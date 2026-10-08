import {
  ConnectionException,
  DeadlockException,
  IsolationLevel,
  LockMode,
  LockWaitTimeoutException,
  UniqueConstraintViolationException,
} from "@mikro-orm/core";
import type { EntityManager, MikroORM } from "@mikro-orm/postgresql";
import { TransientInfrastructureError, UniqueViolationError } from "../../application/errors";
import type {
  Clock,
  InboxRepository,
  LedgerRepository,
  LedgerSummary,
  Metrics,
  OutboxRepository,
  RunOptions,
  TransactionRunner,
  UnitOfWork,
  WagerTransactionRepository,
  WalletRepository,
} from "../../application/ports";
import { Money } from "../../domain/money";
import type { InboxMessage } from "../../domain/messaging/inbox-message";
import type { OutboxMessage } from "../../domain/messaging/outbox-message";
import { WagerTransactionKind, WagerTransactionStatus, type WagerTransaction } from "../../domain/wagering/wager-transaction";
import type { Wallet } from "../../domain/wallet/wallet";
import type { WalletLedgerEntry } from "../../domain/wallet/wallet-ledger-entry";
import {
  applyWallet,
  inboxToDomain,
  ledgerEntryToDomain,
  outboxToRecord,
  transactionToDomain,
  walletToDomain,
  walletToRecord,
} from "./mappers";
import { InboxRecord, LedgerEntryRecord, OutboxRecord, WagerTransactionRecord, WalletRecord } from "./records";

export interface UnitOfWorkOptions {
  /** Quanto esperar pelo lock de uma wallet antes de desistir com erro transitorio. */
  lockTimeoutMs: number;
}

/**
 * TransactionRunner sobre o MikroORM. Cada execucao usa um EntityManager proprio
 * (fork): identity map e unit of work nao vazam entre requisicoes. Dentro de
 * `run`, os repositorios so registram (persist); o flush acontece uma vez, no fim
 * de `em.transactional`, e o COMMIT leva tudo junto.
 */
export class MikroOrmTransactionRunner implements TransactionRunner {
  constructor(
    private readonly orm: MikroORM,
    private readonly clock: Clock,
    private readonly options: UnitOfWorkOptions = { lockTimeoutMs: 5_000 },
    private readonly metrics?: Metrics,
  ) {}

  async run<T>(work: (uow: UnitOfWork) => Promise<T>, options: RunOptions = {}): Promise<T> {
    try {
      return await this.orm.em.fork().transactional(
        async (em) => {
          // SET LOCAL vale so para esta transacao; inteiro ja validado, sem interpolar texto de fora.
          await em.execute(`set local lock_timeout = ${Math.trunc(this.options.lockTimeoutMs)}`);
          return work(new MikroOrmUnitOfWork(em, this.clock, this.metrics));
        },
        {
          isolationLevel:
            options.isolation === "repeatable read" ? IsolationLevel.REPEATABLE_READ : IsolationLevel.READ_COMMITTED,
          readOnly: options.readOnly ?? false,
        },
      );
    } catch (error) {
      const translated = translateDriverError(error);
      if (translated instanceof TransientInfrastructureError && translated.reason === "lock_timeout") {
        this.metrics?.increment("wallet_lock_timeouts_total");
      }
      throw translated;
    }
  }

  async read<T>(work: (uow: UnitOfWork) => Promise<T>): Promise<T> {
    try {
      return await work(new MikroOrmUnitOfWork(this.orm.em.fork(), this.clock, this.metrics));
    } catch (error) {
      throw translateDriverError(error);
    }
  }
}

/**
 * Converte falhas do driver em erros que a aplicacao sabe classificar. O resto passa como esta.
 * Classifica pela classe do MikroORM e tambem pelo SQLSTATE: o lock_timeout (55P03) chega
 * como DriverException generica, e sem isto viraria 500 em vez de 503.
 */
export function translateDriverError(error: unknown): unknown {
  const state = sqlState(error);
  if (error instanceof UniqueConstraintViolationException || state === "23505") {
    return new UniqueViolationError((error as Error).message, constraintName(error));
  }
  if (error instanceof LockWaitTimeoutException || state === "55P03") {
    return new TransientInfrastructureError("lock da wallet nao saiu a tempo", "lock_timeout", { cause: error });
  }
  if (error instanceof DeadlockException || state === "40P01") {
    return new TransientInfrastructureError("deadlock detectado", "deadlock", { cause: error });
  }
  if (error instanceof ConnectionException || isConnectionFailure(error)) {
    return new TransientInfrastructureError("banco indisponivel", "connection", { cause: error });
  }
  if (state === "40001") {
    return new TransientInfrastructureError("conflito de serializacao", "serialization", { cause: error });
  }
  if (state === "57014") {
    return new TransientInfrastructureError("consulta cancelada por tempo", "timeout", { cause: error });
  }
  return error;
}

function sqlState(error: unknown): string | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const { sqlState: state, code } = error as { sqlState?: unknown; code?: unknown };
  if (typeof state === "string") return state;
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : undefined;
}

function constraintName(error: unknown): string | undefined {
  const fromDriver = (error as { constraint?: unknown }).constraint;
  if (typeof fromDriver === "string") return fromDriver;
  const message = error instanceof Error ? error.message : "";
  return /constraint "([^"]+)"/.exec(message)?.[1];
}

const CONNECTION_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "57P01", "57P03", "08006", "08001", "08003"]);

function isConnectionFailure(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  const sqlState = (error as { sqlState?: unknown } | null)?.sqlState;
  return (typeof code === "string" && CONNECTION_CODES.has(code)) || (typeof sqlState === "string" && CONNECTION_CODES.has(sqlState));
}

class MikroOrmUnitOfWork implements UnitOfWork {
  readonly wallets: WalletRepository;
  readonly transactions: WagerTransactionRepository;
  readonly ledger: LedgerRepository;
  readonly inbox: InboxRepository;
  readonly outbox: OutboxRepository;

  constructor(em: EntityManager, clock: Clock, metrics: Metrics | undefined) {
    this.wallets = new MikroOrmWalletRepository(em, metrics);
    this.transactions = new MikroOrmWagerTransactionRepository(em, clock);
    this.ledger = new MikroOrmLedgerRepository(em);
    this.inbox = new MikroOrmInboxRepository(em);
    this.outbox = new MikroOrmOutboxRepository(em);
  }
}

/**
 * Ponte entre o objeto de dominio e o registro gerenciado pelo UoW: `save` sabe
 * qual registro atualizar porque guardou o par quando carregou.
 */
class Tracked<D extends object, R extends object> {
  private readonly records = new WeakMap<D, R>();

  remember(domain: D, record: R): D {
    this.records.set(domain, record);
    return domain;
  }

  recordOf(domain: D, what: string): R {
    const record = this.records.get(domain);
    if (record === undefined) {
      throw new Error(`${what} nao foi carregada nem adicionada nesta unidade de trabalho`);
    }
    return record;
  }
}

class MikroOrmWalletRepository implements WalletRepository {
  private readonly tracked = new Tracked<Wallet, WalletRecord>();

  constructor(
    private readonly em: EntityManager,
    private readonly metrics: Metrics | undefined,
  ) {}

  async findById(id: string): Promise<Wallet | undefined> {
    const record = await this.em.findOne(WalletRecord, { id });
    return record === null ? undefined : this.tracked.remember(walletToDomain(record), record);
  }

  async lockById(id: string): Promise<Wallet | undefined> {
    const started = performance.now();
    const record = await this.em.findOne(WalletRecord, { id }, { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true });
    // Tempo na fila da wallet: alto aqui = wallet quente (contencao), nao banco lento.
    this.metrics?.observe("wallet_lock_wait_seconds", (performance.now() - started) / 1000);
    return record === null ? undefined : this.tracked.remember(walletToDomain(record), record);
  }

  async findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | undefined> {
    const record = await this.em.findOne(WalletRecord, { playerId, currency });
    return record === null ? undefined : this.tracked.remember(walletToDomain(record), record);
  }

  add(wallet: Wallet): void {
    const record = walletToRecord(new WalletRecord(), wallet);
    this.em.persist(record);
    this.tracked.remember(wallet, record);
  }

  save(wallet: Wallet): void {
    applyWallet(this.tracked.recordOf(wallet, "wallet"), wallet);
  }
}

class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  private readonly tracked = new Tracked<WagerTransaction, WagerTransactionRecord>();

  constructor(
    private readonly em: EntityManager,
    private readonly clock: Clock,
  ) {}

  async findById(id: string): Promise<WagerTransaction | undefined> {
    return this.one({ id });
  }

  async findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined> {
    return this.one({ providerId, externalTransactionId });
  }

  async findByIdempotencyKey(providerId: string, idempotencyKey: string): Promise<WagerTransaction | undefined> {
    return this.one({ providerId, idempotencyKey });
  }

  async findExisting(
    providerId: string,
    idempotencyKey: string,
    externalTransactionId: string,
  ): Promise<{ byKey: WagerTransaction | undefined; byOperation: WagerTransaction | undefined }> {
    // Uma ida ao banco em vez de duas: roda com o lock da wallet na mao, cada round-trip conta.
    const records = await this.em.find(
      WagerTransactionRecord,
      { providerId, $or: [{ idempotencyKey }, { externalTransactionId }] },
      { populate: ["wallet"] as never },
    );
    const found = records.map((record) => ({ record, domain: this.tracked.remember(transactionToDomain(record), record) }));
    return {
      byKey: found.find((f) => f.record.idempotencyKey === idempotencyKey)?.domain,
      byOperation: found.find((f) => f.record.externalTransactionId === externalTransactionId)?.domain,
    };
  }

  async hasProcessedReversalOf(referenceTransactionId: string): Promise<boolean> {
    const count = await this.em.count(WagerTransactionRecord, {
      referenceTransaction: referenceTransactionId,
      status: WagerTransactionStatus.Processed,
      kind: { $in: [WagerTransactionKind.Refund, WagerTransactionKind.Rollback] },
    });
    return count > 0;
  }

  async expediteWaitingFor(providerId: string, externalTransactionId: string, at: Date): Promise<number> {
    return this.em.nativeUpdate(
      WagerTransactionRecord,
      {
        providerId,
        referenceExternalTransactionId: externalTransactionId,
        status: WagerTransactionStatus.PendingReference,
      },
      { nextReferenceCheckAt: at, updatedAt: at },
    );
  }

  add(transaction: WagerTransaction): void {
    const record = new WagerTransactionRecord();
    record.id = transaction.id;
    record.providerId = transaction.providerId;
    record.externalTransactionId = transaction.externalTransactionId;
    record.idempotencyKey = transaction.idempotencyKey;
    record.payloadHash = transaction.payloadHash;
    record.wallet = this.em.getReference(WalletRecord, transaction.walletId);
    record.playerId = transaction.playerId;
    record.roundId = transaction.roundId;
    record.gameId = transaction.gameId;
    record.kind = transaction.kind;
    record.amount = transaction.money.toJSON().amount;
    record.currency = transaction.money.currency;
    record.referenceExternalTransactionId = transaction.referenceExternalTransactionId ?? null;
    record.referenceAttempts = 0;
    record.createdAt = transaction.createdAt;
    this.applyState(record, transaction);
    this.em.persist(record);
    this.tracked.remember(transaction, record);
  }

  save(transaction: WagerTransaction): void {
    this.applyState(this.tracked.recordOf(transaction, "transacao"), transaction);
  }

  private applyState(record: WagerTransactionRecord, transaction: WagerTransaction): void {
    record.status = transaction.status;
    record.referenceTransaction =
      transaction.referenceTransactionId === undefined
        ? null
        : this.em.getReference(WagerTransactionRecord, transaction.referenceTransactionId);
    record.failureCode = transaction.failureCode ?? null;
    record.observedBalance = transaction.observedBalance?.toJSON().amount ?? null;
    record.processedAt = transaction.processedAt ?? null;
    record.referenceAttempts = transaction.referenceAttempts;
    record.nextReferenceCheckAt = transaction.nextReferenceCheckAt ?? null;
    record.updatedAt = this.clock.now();
  }

  private async one(where: Partial<Record<keyof WagerTransactionRecord, unknown>>): Promise<WagerTransaction | undefined> {
    // A wallet vem junto: o saldo observado esta na moeda dela.
    const record = await this.em.findOne(WagerTransactionRecord, where as never, { populate: ["wallet"] as never });
    return record === null ? undefined : this.tracked.remember(transactionToDomain(record), record);
  }
}

class MikroOrmLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  append(entry: WalletLedgerEntry): void {
    const record = new LedgerEntryRecord();
    record.id = entry.id;
    record.wallet = this.em.getReference(WalletRecord, entry.walletId);
    record.transaction = this.em.getReference(WagerTransactionRecord, entry.transactionId);
    record.direction = entry.direction;
    record.amount = entry.money.toJSON().amount;
    record.currency = entry.money.currency;
    record.balanceBefore = entry.balanceBefore.toJSON().amount;
    record.balanceAfter = entry.balanceAfter.toJSON().amount;
    record.walletVersion = entry.walletVersion;
    record.createdAt = entry.createdAt;
    this.em.persist(record);
  }

  async page(walletId: string, afterVersion: number, limit: number): Promise<WalletLedgerEntry[]> {
    const records = await this.em.find(
      LedgerEntryRecord,
      { wallet: walletId, walletVersion: { $gt: afterVersion } },
      { orderBy: { walletVersion: "asc" }, limit },
    );
    return records.map(ledgerEntryToDomain);
  }

  async summarize(walletId: string, currency: string): Promise<LedgerSummary> {
    // Soma em numeric no proprio Postgres; volta como texto e entra em Money sem passar por number.
    const [row] = await this.em.execute<{ total: string; entries: number }[]>(
      `select coalesce(sum(case direction when 'CREDIT' then amount else -amount end), 0)::numeric(20, 2)::text as total,
              count(*)::int as entries
         from wallet_ledger_entries
        where wallet_id = ?`,
      [walletId],
    );
    const total = row?.total ?? "0.00";
    const negative = total.startsWith("-");
    const magnitude = Money.from({ amount: negative ? total.slice(1) : total, currency });
    return { total: negative ? magnitude.negate() : magnitude, entries: row?.entries ?? 0 };
  }
}

class MikroOrmInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  async find(
    consumerName: string,
    messageId: string,
  ): Promise<{ message: InboxMessage; transactionId: string | undefined } | undefined> {
    const record = await this.em.findOne(InboxRecord, { consumerName, messageId });
    if (record === null) return undefined;
    return { message: inboxToDomain(record), transactionId: record.transaction?.id };
  }

  add(message: InboxMessage, transactionId: string | undefined): void {
    const record = new InboxRecord();
    record.consumerName = message.consumerName;
    record.messageId = message.messageId;
    record.payloadHash = message.payloadHash;
    record.transaction = transactionId === undefined ? null : this.em.getReference(WagerTransactionRecord, transactionId);
    record.receivedAt = message.receivedAt;
    record.processedAt = message.processedAt ?? null;
    this.em.persist(record);
  }
}

class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  enqueue(message: OutboxMessage): void {
    this.em.persist(outboxToRecord(new OutboxRecord(), message));
  }
}
