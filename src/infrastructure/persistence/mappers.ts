import { Money } from "../../domain/money";
import { InboxMessage } from "../../domain/messaging/inbox-message";
import type { OutboxMessage } from "../../domain/messaging/outbox-message";
import type { FailureCode } from "../../domain/wagering/failure-code";
import {
  WagerTransaction,
  type WagerTransactionKind,
  type WagerTransactionStatus,
} from "../../domain/wagering/wager-transaction";
import type { LedgerDirection } from "../../domain/wallet/ledger-direction";
import { Wallet } from "../../domain/wallet/wallet";
import { WalletLedgerEntry } from "../../domain/wallet/wallet-ledger-entry";
import type { InboxRecord, LedgerEntryRecord, OutboxRecord, WagerTransactionRecord, WalletRecord } from "./records";

const toMoney = (amount: string, currency: string): Money => Money.from({ amount, currency });
const orUndefined = <T>(value: T | null | undefined): T | undefined => (value === null ? undefined : value);

export function walletToDomain(record: WalletRecord): Wallet {
  return Wallet.rehydrate({
    id: record.id,
    playerId: record.playerId,
    currency: record.currency,
    balance: toMoney(record.balance, record.currency),
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

/** Copia o estado mutavel da wallet para o registro gerenciado (o UoW gera o UPDATE). */
export function applyWallet(record: WalletRecord, wallet: Wallet): void {
  record.balance = wallet.balance.toJSON().amount;
  record.version = wallet.version;
  record.updatedAt = wallet.updatedAt;
}

export function walletToRecord(record: WalletRecord, wallet: Wallet): WalletRecord {
  record.id = wallet.id;
  record.playerId = wallet.playerId;
  record.currency = wallet.currency;
  record.createdAt = wallet.createdAt;
  applyWallet(record, wallet);
  return record;
}

export function transactionToDomain(record: WagerTransactionRecord): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: record.id,
    providerId: record.providerId,
    externalTransactionId: record.externalTransactionId,
    idempotencyKey: record.idempotencyKey,
    payloadHash: record.payloadHash,
    walletId: record.wallet.id,
    playerId: record.playerId,
    roundId: record.roundId,
    gameId: record.gameId,
    kind: record.kind as WagerTransactionKind,
    money: toMoney(record.amount, record.currency),
    referenceExternalTransactionId: orUndefined(record.referenceExternalTransactionId),
    createdAt: record.createdAt,
    status: record.status as WagerTransactionStatus,
    referenceTransactionId: orUndefined(record.referenceTransaction?.id),
    failureCode: orUndefined(record.failureCode) as FailureCode | undefined,
    processedAt: orUndefined(record.processedAt),
    // O saldo observado esta na moeda da wallet, que pode diferir da moeda da operacao (CURRENCY_MISMATCH):
    // por isso o repositorio sempre carrega a wallet junto (populate).
    observedBalance:
      record.observedBalance === null ? undefined : toMoney(record.observedBalance, record.wallet.currency),
    referenceAttempts: record.referenceAttempts,
    nextReferenceCheckAt: orUndefined(record.nextReferenceCheckAt),
  });
}

export function ledgerEntryToDomain(record: LedgerEntryRecord): WalletLedgerEntry {
  return WalletLedgerEntry.rehydrate({
    id: record.id,
    walletId: record.wallet.id,
    transactionId: record.transaction.id,
    direction: record.direction as LedgerDirection,
    money: toMoney(record.amount, record.currency),
    balanceBefore: toMoney(record.balanceBefore, record.currency),
    balanceAfter: toMoney(record.balanceAfter, record.currency),
    walletVersion: record.walletVersion,
    createdAt: record.createdAt,
  });
}

export function inboxToDomain(record: InboxRecord): InboxMessage {
  return InboxMessage.rehydrate({
    messageId: record.messageId,
    consumerName: record.consumerName,
    payloadHash: record.payloadHash,
    receivedAt: record.receivedAt,
    processedAt: orUndefined(record.processedAt),
  });
}

export function outboxToRecord(record: OutboxRecord, message: OutboxMessage): OutboxRecord {
  record.id = message.id;
  record.aggregateId = message.aggregateId;
  record.eventType = message.eventType;
  record.payload = { ...message.payload };
  record.occurredAt = message.occurredAt;
  record.attempts = message.attempts;
  record.nextAttemptAt = message.nextAttemptAt ?? null;
  record.lockedBy = null;
  record.lockedUntil = null;
  record.lastError = null;
  record.publishedAt = message.publishedAt ?? null;
  return record;
}
