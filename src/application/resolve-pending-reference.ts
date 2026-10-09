import { DomainError, InvariantViolationError } from "../domain/shared/domain-error";
import { FailureCode } from "../domain/wagering/failure-code";
import {
  REFERENCE_MAX_ATTEMPTS,
  expirePendingReference,
  settleWagerTransaction,
} from "../domain/wagering/wager-settlement";
import { WagerTransactionStatus } from "../domain/wagering/wager-transaction";
import { IntegrityViolationError } from "./errors";
import type { EventFactory } from "./event-factory";
import { withLogContext } from "./log-context";
import type { AppLogger, Clock, IdGenerator, Metrics, PendingReferenceFinder, TransactionRunner } from "./ports";

export type ResolutionResult = "processed" | "rejected" | "still_pending" | "expired" | "failed" | "skipped";

/**
 * Erro que se repete a cada tentativa: o banco recusou por integridade (dado corrompido ou bug que
 * produz estado invalido) ou o dominio detectou uma invariante quebrada. Tentar de novo nao resolve.
 */
export function isPermanentFailure(error: unknown): boolean {
  return error instanceof IntegrityViolationError || error instanceof InvariantViolationError || error instanceof DomainError;
}

/**
 * Reavalia uma transacao PENDING_REFERENCE. Mesma disciplina do caso de uso
 * principal: trava a wallet, rele a transacao sob o lock (outro worker pode ter
 * resolvido) e so entao decide. Varios workers concorrentes nunca aplicam duas vezes.
 *
 * Se a reavaliacao falhar de forma permanente, a transacao vai para FAILED com
 * PROCESSING_FAILED: terminal e auditavel, em vez de voltar em toda varredura.
 */
export class ResolvePendingReference {
  constructor(
    private readonly runner: TransactionRunner,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly events: EventFactory,
    private readonly metrics: Metrics,
    private readonly logger: AppLogger,
    private readonly maxAttempts = REFERENCE_MAX_ATTEMPTS,
  ) {}

  async execute(transactionId: string, walletId: string): Promise<ResolutionResult> {
    return withLogContext({ transactionId, walletId }, async () => {
      let result: ResolutionResult;
      try {
        result = await this.resolve(transactionId, walletId);
      } catch (error) {
        if (!isPermanentFailure(error)) throw error;
        result = await this.markFailed(transactionId, walletId, error);
      }
      this.metrics.increment("pending_reference_resolutions_total", { result });
      return result;
    });
  }

  private async resolve(transactionId: string, walletId: string): Promise<ResolutionResult> {
    return this.runner.run(async (uow) => {
      const wallet = await uow.wallets.lockById(walletId);
      const transaction = await uow.transactions.findById(transactionId);
      if (wallet === undefined || transaction === undefined) return "skipped" as const;
      const now = this.clock.now();
      if (
        transaction.status !== WagerTransactionStatus.PendingReference ||
        transaction.nextReferenceCheckAt === undefined ||
        transaction.nextReferenceCheckAt.getTime() > now.getTime()
      ) {
        return "skipped" as const;
      }

      const reference = await uow.transactions.findByExternalId(
        transaction.providerId,
        transaction.referenceExternalTransactionId ?? "",
      );
      const context = { correlationId: transaction.id, causationId: transaction.id };

      if ((reference === undefined || !reference.isTerminal()) && transaction.referenceRetriesExhausted(this.maxAttempts)) {
        expirePendingReference(transaction, wallet, now);
        uow.transactions.save(transaction);
        for (const message of this.events.forOutcome(transaction, wallet, undefined, context)) uow.outbox.enqueue(message);
        return "expired" as const;
      }

      const settlement = settleWagerTransaction({
        transaction,
        wallet,
        reference,
        referenceAlreadyReversed:
          reference !== undefined && transaction.isReversal()
            ? await uow.transactions.hasProcessedReversalOf(reference.id)
            : false,
        entryId: this.ids.next(),
        at: now,
      });
      uow.transactions.save(transaction);

      if (settlement.status === WagerTransactionStatus.PendingReference) {
        // Nova tentativa agendada; sem evento a cada volta para nao inundar os consumidores.
        return "still_pending" as const;
      }
      const entry = settlement.status === WagerTransactionStatus.Processed ? settlement.entry : undefined;
      if (entry !== undefined) {
        uow.wallets.save(wallet);
        uow.ledger.append(entry);
      }
      for (const message of this.events.forOutcome(transaction, wallet, entry, context)) uow.outbox.enqueue(message);
      if (settlement.status === WagerTransactionStatus.Processed) {
        await uow.transactions.expediteWaitingFor(transaction.providerId, transaction.externalTransactionId, now);
        return "processed" as const;
      }
      return "rejected" as const;
    });
  }

  /**
   * Transacao separada: a que falhou foi desfeita por inteiro, entao saldo e ledger estao como antes.
   * Esta so grava o estado terminal, sem tocar saldo; por isso passa mesmo com a wallet corrompida.
   */
  private async markFailed(transactionId: string, walletId: string, error: unknown): Promise<ResolutionResult> {
    const result = await this.runner.run(async (uow) => {
      const wallet = await uow.wallets.lockById(walletId);
      const transaction = await uow.transactions.findById(transactionId);
      if (wallet === undefined || transaction === undefined) return "skipped" as const;
      if (transaction.status !== WagerTransactionStatus.PendingReference) return "skipped" as const;
      transaction.fail(FailureCode.ProcessingFailed, this.clock.now());
      uow.transactions.save(transaction);
      this.metrics.increment("wager_transactions_total", { kind: transaction.kind, status: transaction.status });
      return "failed" as const;
    });
    if (result === "failed") {
      this.logger.error("pendencia com falha permanente; transacao marcada FAILED", {
        failureCode: FailureCode.ProcessingFailed,
        error: error instanceof Error ? error.name : typeof error,
        code: (error as { code?: unknown }).code,
        sqlState: (error as { sqlState?: unknown }).sqlState,
      });
    }
    return result;
  }
}

/**
 * Uma varredura: busca as vencidas e resolve uma a uma. Uma pendencia que falha nao
 * interrompe as outras: as permanentes ja viraram FAILED no resolver; as transitorias
 * ficam para a proxima varredura. Devolve quantas foram tocadas.
 */
export class PendingReferenceSweep {
  constructor(
    private readonly finder: PendingReferenceFinder,
    private readonly resolver: ResolvePendingReference,
    private readonly clock: Clock,
    private readonly logger: AppLogger,
    private readonly batchSize = 50,
  ) {}

  async runOnce(): Promise<number> {
    const due = await this.finder.findDue(this.clock.now(), this.batchSize);
    for (const item of due) {
      try {
        await this.resolver.execute(item.transactionId, item.walletId);
      } catch (error) {
        this.logger.warn("pendencia nao resolvida nesta varredura; segue para a proxima", {
          transactionId: item.transactionId,
          walletId: item.walletId,
          error: error instanceof Error ? error.name : typeof error,
        });
      }
    }
    return due.length;
  }
}
