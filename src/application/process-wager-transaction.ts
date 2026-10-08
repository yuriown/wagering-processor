import { Money } from "../domain/money";
import { InboxMessage } from "../domain/messaging/inbox-message";
import { wagerPayloadHash } from "../domain/wagering/payload-hash";
import { settleWagerTransaction } from "../domain/wagering/wager-settlement";
import { WagerTransaction, WagerTransactionStatus } from "../domain/wagering/wager-transaction";
import {
  IdempotencyConflictError,
  InboxConflictError,
  UniqueViolationError,
  WalletNotFoundError,
} from "./errors";
import type { EventFactory } from "./event-factory";
import type { Clock, IdGenerator, Metrics, RequestContext, TransactionRunner, UnitOfWork } from "./ports";
import type { WagerCommand } from "./wager-command";

/** Presente quando a entrada veio da fila: deduplicacao por (consumerName, messageId) no mesmo commit. */
export interface InboxContext {
  consumerName: string;
  messageId: string;
  /** Hash da mensagem inteira, para distinguir redelivery de reuso indevido de messageId. */
  payloadHash: string;
}

export interface ProcessContext extends RequestContext {
  inbox?: InboxContext | undefined;
}

export interface WagerOutcome {
  transaction: WagerTransaction;
  /** true quando a operacao ja existia: devolve o resultado original, sem reaplicar. */
  idempotentReplay: boolean;
}

/** Uma nova tentativa basta: na segunda, o leitor ve a linha que venceu a corrida e responde replay. */
const MAX_ATTEMPTS = 2;

/**
 * Caso de uso unico para HTTP e SQS.
 *
 * Concorrencia: a wallet e travada com SELECT ... FOR UPDATE antes de qualquer
 * decisao. Operacoes da mesma wallet passam uma de cada vez; wallets diferentes
 * seguem em paralelo (nao existe lock global). Depois do lock, a idempotencia e
 * conferida de novo: quem esperou ve o que o anterior confirmou e devolve replay.
 *
 * Atomicidade: transacao, saldo, lancamento, inbox e eventos (outbox) entram no
 * mesmo COMMIT. Evento nunca e publicado antes disso: so a outbox o grava.
 */
export class ProcessWagerTransaction {
  constructor(
    private readonly runner: TransactionRunner,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly events: EventFactory,
    private readonly metrics: Metrics,
  ) {}

  async execute(command: WagerCommand, context: ProcessContext): Promise<WagerOutcome> {
    const payloadHash = wagerPayloadHash(command);
    for (let attempt = 1; ; attempt++) {
      try {
        const outcome = await this.attempt(command, payloadHash, context);
        if (outcome.idempotentReplay) {
          this.metrics.increment("wager_duplicates_total", { source: context.inbox ? "sqs" : "http" });
        }
        return outcome;
      } catch (error) {
        if (error instanceof UniqueViolationError && attempt < MAX_ATTEMPTS) {
          this.metrics.increment("wager_unique_race_retries_total");
          continue;
        }
        throw error;
      }
    }
  }

  private async attempt(command: WagerCommand, payloadHash: string, context: ProcessContext): Promise<WagerOutcome> {
    // Caminho rapido, sem lock: a maior parte das duplicatas termina aqui.
    const known = await this.runner.read((uow) =>
      uow.transactions.findByIdempotencyKey(command.providerId, command.idempotencyKey),
    );
    if (known !== undefined) {
      return this.replay(known, payloadHash);
    }

    return this.runner.run(async (uow) => {
      const wallet = await uow.wallets.lockById(command.walletId);
      if (wallet === undefined) {
        throw new WalletNotFoundError(`wallet ${command.walletId} nao existe`);
      }

      // Com o lock na mao, olhar de novo: outra instancia pode ter confirmado enquanto esperavamos.
      if (context.inbox !== undefined) {
        const delivered = await this.alreadyDelivered(uow, context.inbox);
        if (delivered !== undefined) return delivered;
      }
      const existing = await uow.transactions.findByIdempotencyKey(command.providerId, command.idempotencyKey);
      if (existing !== undefined) {
        return this.replay(existing, payloadHash);
      }
      const sameOperation = await uow.transactions.findByExternalId(command.providerId, command.externalTransactionId);
      if (sameOperation !== undefined) {
        throw new IdempotencyConflictError(
          `externalTransactionId ${command.externalTransactionId} ja foi enviado com outra Idempotency-Key`,
          sameOperation.id,
        );
      }

      const now = this.clock.now();
      const transaction = WagerTransaction.create({
        id: this.ids.next(),
        providerId: command.providerId,
        externalTransactionId: command.externalTransactionId,
        idempotencyKey: command.idempotencyKey,
        payloadHash,
        walletId: command.walletId,
        playerId: command.playerId,
        roundId: command.roundId,
        gameId: command.gameId,
        kind: command.kind,
        money: Money.from(command.money),
        referenceExternalTransactionId: command.referenceExternalTransactionId,
        createdAt: now,
      });

      const reference =
        command.referenceExternalTransactionId === undefined
          ? undefined
          : await uow.transactions.findByExternalId(command.providerId, command.referenceExternalTransactionId);
      const referenceAlreadyReversed =
        reference !== undefined && transaction.isReversal()
          ? await uow.transactions.hasProcessedReversalOf(reference.id)
          : false;

      const result = settleWagerTransaction({
        transaction,
        wallet,
        reference,
        referenceAlreadyReversed,
        entryId: this.ids.next(),
        at: now,
      });

      uow.transactions.add(transaction);
      const entry = result.status === WagerTransactionStatus.Processed ? result.entry : undefined;
      if (entry !== undefined) {
        uow.wallets.save(wallet);
        uow.ledger.append(entry);
      }
      for (const message of this.events.forOutcome(transaction, wallet, entry, context)) {
        uow.outbox.enqueue(message);
      }
      if (transaction.status === WagerTransactionStatus.Processed) {
        // Quem esperava por esta operacao (REFUND/ROLLBACK fora de ordem) e reavaliado ja.
        await uow.transactions.expediteWaitingFor(transaction.providerId, transaction.externalTransactionId, now);
      }
      if (context.inbox !== undefined) {
        const inbox = InboxMessage.receive({ ...context.inbox, receivedAt: now });
        inbox.markProcessed(now);
        uow.inbox.add(inbox, transaction.id);
      }

      this.metrics.increment("wager_transactions_total", { kind: transaction.kind, status: transaction.status });
      return { transaction, idempotentReplay: false };
    });
  }

  private async alreadyDelivered(uow: UnitOfWork, inbox: InboxContext): Promise<WagerOutcome | undefined> {
    const found = await uow.inbox.find(inbox.consumerName, inbox.messageId);
    if (found === undefined) return undefined;
    if (!found.message.matchesPayload(inbox.payloadHash)) {
      throw new InboxConflictError(`messageId ${inbox.messageId} ja recebido com outro conteudo`);
    }
    const transaction = found.transactionId === undefined ? undefined : await uow.transactions.findById(found.transactionId);
    if (transaction === undefined) {
      throw new InboxConflictError(`messageId ${inbox.messageId} registrado sem transacao`);
    }
    return { transaction, idempotentReplay: true };
  }

  private replay(existing: WagerTransaction, payloadHash: string): WagerOutcome {
    if (!existing.matchesPayload(payloadHash)) {
      throw new IdempotencyConflictError(
        `Idempotency-Key ${existing.idempotencyKey} ja foi usada com outro conteudo`,
        existing.id,
      );
    }
    return { transaction: existing, idempotentReplay: true };
  }
}
