import type { MoneyProps } from "../money";
import { InvariantViolationError } from "../shared/domain-error";
import type { FailureCode } from "../wagering/failure-code";
import { type WagerTransaction, WagerTransactionStatus } from "../wagering/wager-transaction";
import { type EventContext, IntegrationEvent } from "./integration-event";

/**
 * Campos comuns aos eventos de transacao. `aggregateId` e a walletId:
 * e a unidade de ordenacao (MessageGroupId na fila FIFO de eventos).
 */
export interface WagerTransactionEventData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

export interface WagerTransactionProcessedData extends WagerTransactionEventData {
  referenceTransactionId?: string;
  balance: MoneyProps;
  processedAt: string;
}

export interface WagerTransactionRejectedData extends WagerTransactionEventData {
  failureCode: FailureCode;
  balance?: MoneyProps;
  rejectedAt: string;
}

export interface WagerTransactionPendingReferenceData extends WagerTransactionEventData {
  referenceExternalTransactionId: string;
  attempts: number;
  nextCheckAt: string;
}

/** Qualquer transacao aplicada, inclusive LOSS (que nao move saldo). */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = "WagerTransactionProcessed";
  readonly version = 1;

  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    assertStatus(transaction, WagerTransactionStatus.Processed);
    const balance = required(transaction.observedBalance, "observedBalance");
    return new WagerTransactionProcessed({
      ...ctx,
      aggregateId: transaction.walletId,
      data: {
        ...baseData(transaction),
        ...(transaction.referenceTransactionId === undefined
          ? {}
          : { referenceTransactionId: transaction.referenceTransactionId }),
        balance: balance.toJSON(),
        processedAt: required(transaction.processedAt, "processedAt").toISOString(),
      },
    });
  }
}

/** Rejeicao por regra de negocio (inclusive referencia que nunca chegou). */
export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = "WagerTransactionRejected";
  readonly version = 1;

  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    assertStatus(transaction, WagerTransactionStatus.Rejected);
    return new WagerTransactionRejected({
      ...ctx,
      aggregateId: transaction.walletId,
      data: {
        ...baseData(transaction),
        failureCode: required(transaction.failureCode, "failureCode"),
        ...(transaction.observedBalance === undefined ? {} : { balance: transaction.observedBalance.toJSON() }),
        rejectedAt: required(transaction.processedAt, "processedAt").toISOString(),
      },
    });
  }
}

/** A referencia ainda nao existe; a transacao sera reavaliada em `nextCheckAt`. */
export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = "WagerTransactionPendingReference";
  readonly version = 1;

  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    assertStatus(transaction, WagerTransactionStatus.PendingReference);
    return new WagerTransactionPendingReference({
      ...ctx,
      aggregateId: transaction.walletId,
      data: {
        ...baseData(transaction),
        referenceExternalTransactionId: required(
          transaction.referenceExternalTransactionId,
          "referenceExternalTransactionId",
        ),
        attempts: transaction.referenceAttempts,
        nextCheckAt: required(transaction.nextReferenceCheckAt, "nextReferenceCheckAt").toISOString(),
      },
    });
  }
}

function baseData(transaction: WagerTransaction): WagerTransactionEventData {
  return {
    transactionId: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    money: transaction.money.toJSON(),
    ...(transaction.referenceExternalTransactionId === undefined
      ? {}
      : { referenceExternalTransactionId: transaction.referenceExternalTransactionId }),
  };
}

function assertStatus(transaction: WagerTransaction, expected: WagerTransactionStatus): void {
  if (transaction.status !== expected) {
    throw new InvariantViolationError(`evento exige status ${expected}, transacao ${transaction.id} esta ${transaction.status}`);
  }
}

function required<T>(value: T | undefined, field: string): T {
  if (value === undefined) {
    throw new InvariantViolationError(`${field} ausente`);
  }
  return value;
}
