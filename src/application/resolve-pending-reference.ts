import {
  REFERENCE_MAX_ATTEMPTS,
  expirePendingReference,
  settleWagerTransaction,
} from "../domain/wagering/wager-settlement";
import { WagerTransactionStatus } from "../domain/wagering/wager-transaction";
import type { EventFactory } from "./event-factory";
import type { Clock, IdGenerator, Metrics, PendingReferenceFinder, TransactionRunner } from "./ports";

export type ResolutionResult = "processed" | "rejected" | "still_pending" | "expired" | "skipped";

/**
 * Reavalia uma transacao PENDING_REFERENCE. Mesma disciplina do caso de uso
 * principal: trava a wallet, rele a transacao sob o lock (outro worker pode ter
 * resolvido) e so entao decide. Varios workers concorrentes nunca aplicam duas vezes.
 */
export class ResolvePendingReference {
  constructor(
    private readonly runner: TransactionRunner,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly events: EventFactory,
    private readonly metrics: Metrics,
    private readonly maxAttempts = REFERENCE_MAX_ATTEMPTS,
  ) {}

  async execute(transactionId: string, walletId: string): Promise<ResolutionResult> {
    const result = await this.runner.run(async (uow) => {
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
    this.metrics.increment("pending_reference_resolutions_total", { result });
    return result;
  }
}

/** Uma varredura: busca as vencidas e resolve uma a uma. Devolve quantas foram tocadas. */
export class PendingReferenceSweep {
  constructor(
    private readonly finder: PendingReferenceFinder,
    private readonly resolver: ResolvePendingReference,
    private readonly clock: Clock,
    private readonly batchSize = 50,
  ) {}

  async runOnce(): Promise<number> {
    const due = await this.finder.findDue(this.clock.now(), this.batchSize);
    for (const item of due) {
      await this.resolver.execute(item.transactionId, item.walletId);
    }
    return due.length;
  }
}
