import { DecimalType, EntitySchema } from "@mikro-orm/core";

/**
 * Registros de persistencia: espelho das tabelas, sem regra nenhuma. O dominio
 * nao depende deles; os mapeadores convertem nos dois sentidos. Dinheiro e
 * `numeric(20,2)` lido como string (DecimalType em modo string), nunca number.
 */

const money = { type: new DecimalType("string"), columnType: "numeric(20,2)" } as const;

export class WalletRecord {
  id!: string;
  playerId!: string;
  currency!: string;
  balance!: string;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export const WalletSchema = new EntitySchema<WalletRecord>({
  class: WalletRecord,
  tableName: "wallets",
  properties: {
    id: { type: "uuid", primary: true },
    playerId: { type: "text" },
    currency: { type: "text" },
    balance: money,
    version: { type: "integer" },
    createdAt: { type: "datetime" },
    updatedAt: { type: "datetime" },
  },
});

export class WagerTransactionRecord {
  id!: string;
  providerId!: string;
  externalTransactionId!: string;
  idempotencyKey!: string;
  payloadHash!: string;
  wallet!: WalletRecord;
  playerId!: string;
  roundId!: string;
  gameId!: string;
  kind!: string;
  amount!: string;
  currency!: string;
  referenceExternalTransactionId!: string | null;
  referenceTransaction!: WagerTransactionRecord | null;
  status!: string;
  failureCode!: string | null;
  observedBalance!: string | null;
  processedAt!: Date | null;
  referenceAttempts!: number;
  nextReferenceCheckAt!: Date | null;
  createdAt!: Date;
  updatedAt!: Date;
}

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRecord>({
  class: WagerTransactionRecord,
  tableName: "wager_transactions",
  properties: {
    id: { type: "uuid", primary: true },
    providerId: { type: "text" },
    externalTransactionId: { type: "text" },
    idempotencyKey: { type: "text" },
    payloadHash: { type: "text" },
    // Relacoes declaradas para o Unit of Work ordenar os INSERTs (wallet -> transacao -> lancamento).
    wallet: { kind: "m:1", entity: () => WalletRecord },
    playerId: { type: "text" },
    roundId: { type: "text" },
    gameId: { type: "text" },
    kind: { type: "text" },
    amount: money,
    currency: { type: "text" },
    referenceExternalTransactionId: { type: "text", nullable: true },
    referenceTransaction: { kind: "m:1", entity: () => WagerTransactionRecord, nullable: true },
    status: { type: "text" },
    failureCode: { type: "text", nullable: true },
    observedBalance: { ...money, nullable: true },
    processedAt: { type: "datetime", nullable: true },
    referenceAttempts: { type: "integer" },
    nextReferenceCheckAt: { type: "datetime", nullable: true },
    createdAt: { type: "datetime" },
    updatedAt: { type: "datetime" },
  },
});

export class LedgerEntryRecord {
  id!: string;
  wallet!: WalletRecord;
  transaction!: WagerTransactionRecord;
  direction!: string;
  amount!: string;
  currency!: string;
  balanceBefore!: string;
  balanceAfter!: string;
  walletVersion!: number;
  createdAt!: Date;
}

export const LedgerEntrySchema = new EntitySchema<LedgerEntryRecord>({
  class: LedgerEntryRecord,
  tableName: "wallet_ledger_entries",
  properties: {
    id: { type: "uuid", primary: true },
    wallet: { kind: "m:1", entity: () => WalletRecord },
    transaction: { kind: "m:1", entity: () => WagerTransactionRecord },
    direction: { type: "text" },
    amount: money,
    currency: { type: "text" },
    balanceBefore: money,
    balanceAfter: money,
    walletVersion: { type: "integer" },
    createdAt: { type: "datetime" },
  },
});

export class InboxRecord {
  consumerName!: string;
  messageId!: string;
  payloadHash!: string;
  transaction!: WagerTransactionRecord | null;
  receivedAt!: Date;
  processedAt!: Date | null;
}

export const InboxSchema = new EntitySchema<InboxRecord>({
  class: InboxRecord,
  tableName: "inbox_messages",
  properties: {
    consumerName: { type: "text", primary: true },
    messageId: { type: "text", primary: true },
    payloadHash: { type: "text" },
    transaction: { kind: "m:1", entity: () => WagerTransactionRecord, nullable: true },
    receivedAt: { type: "datetime" },
    processedAt: { type: "datetime", nullable: true },
  },
});

export class OutboxRecord {
  id!: string;
  aggregateId!: string;
  eventType!: string;
  payload!: Record<string, unknown>;
  occurredAt!: Date;
  attempts!: number;
  nextAttemptAt!: Date | null;
  lockedBy!: string | null;
  lockedUntil!: Date | null;
  lastError!: string | null;
  publishedAt!: Date | null;
}

export const OutboxSchema = new EntitySchema<OutboxRecord>({
  class: OutboxRecord,
  tableName: "outbox_messages",
  properties: {
    id: { type: "uuid", primary: true },
    aggregateId: { type: "text" },
    eventType: { type: "text" },
    payload: { type: "json" },
    occurredAt: { type: "datetime" },
    attempts: { type: "integer" },
    nextAttemptAt: { type: "datetime", nullable: true },
    lockedBy: { type: "text", nullable: true },
    lockedUntil: { type: "datetime", nullable: true },
    lastError: { type: "text", nullable: true },
    publishedAt: { type: "datetime", nullable: true },
  },
});

export const ENTITY_SCHEMAS = [WalletSchema, WagerTransactionSchema, LedgerEntrySchema, InboxSchema, OutboxSchema];
