import type { Money } from "../domain/money";
import type { CounterLabels, CounterName, HistogramLabels, HistogramName } from "./metrics-catalog";
import type { InboxMessage } from "../domain/messaging/inbox-message";
import type { OutboxMessage } from "../domain/messaging/outbox-message";
import type { WagerTransaction } from "../domain/wagering/wager-transaction";
import type { Wallet } from "../domain/wallet/wallet";
import type { WalletLedgerEntry } from "../domain/wallet/wallet-ledger-entry";

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  /** Id unico e ordenavel no tempo (UUIDv7). */
  next(): string;
}

export interface WalletRepository {
  findById(id: string): Promise<Wallet | undefined>;
  /**
   * Le a wallet travando a linha ate o fim da transacao (SELECT ... FOR UPDATE).
   * E o ponto de serializacao: operacoes da mesma wallet esperam aqui; wallets diferentes seguem em paralelo.
   */
  lockById(id: string): Promise<Wallet | undefined>;
  findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | undefined>;
  add(wallet: Wallet): void;
  /** Registra a nova versao de uma wallet obtida por esta unidade de trabalho. */
  save(wallet: Wallet): void;
}

export interface WagerTransactionRepository {
  findById(id: string): Promise<WagerTransaction | undefined>;
  findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;
  findByIdempotencyKey(providerId: string, idempotencyKey: string): Promise<WagerTransaction | undefined>;
  /** Ja existe REFUND/ROLLBACK PROCESSED apontando para esta transacao? */
  hasProcessedReversalOf(referenceTransactionId: string): Promise<boolean>;
  /** Antecipa a verificacao das transacoes que esperam por (providerId, externalTransactionId). */
  expediteWaitingFor(providerId: string, externalTransactionId: string, at: Date): Promise<number>;
  add(transaction: WagerTransaction): void;
  save(transaction: WagerTransaction): void;
}

export interface LedgerSummary {
  total: Money;
  entries: number;
}

export interface LedgerRepository {
  append(entry: WalletLedgerEntry): void;
  /** Lancamentos com walletVersion > afterVersion, em ordem crescente. */
  page(walletId: string, afterVersion: number, limit: number): Promise<WalletLedgerEntry[]>;
  /** Soma com sinal (credito +, debito -) calculada no banco, sem passar por number. */
  summarize(walletId: string, currency: string): Promise<LedgerSummary>;
}

export interface InboxRepository {
  find(consumerName: string, messageId: string): Promise<{ message: InboxMessage; transactionId: string | undefined } | undefined>;
  add(message: InboxMessage, transactionId: string | undefined): void;
}

export interface OutboxRepository {
  enqueue(message: OutboxMessage): void;
}

/** Repositorios ligados a uma mesma transacao SQL. */
export interface UnitOfWork {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  inbox: InboxRepository;
  outbox: OutboxRepository;
}

export interface RunOptions {
  isolation?: "read committed" | "repeatable read";
  readOnly?: boolean;
}

export interface TransactionRunner {
  /**
   * Executa `work` numa transacao SQL. Tudo o que for registrado nos repositorios
   * (add/save/append/enqueue) e confirmado junto no COMMIT, ou nada e.
   */
  run<T>(work: (uow: UnitOfWork) => Promise<T>, options?: RunOptions): Promise<T>;
  /** Leitura sem transacao explicita (cada consulta ve o ultimo commit). */
  read<T>(work: (uow: UnitOfWork) => Promise<T>): Promise<T>;
}

/** Transacao PENDING_REFERENCE cuja proxima verificacao ja venceu. */
export interface DuePendingReference {
  transactionId: string;
  walletId: string;
}

export interface PendingReferenceFinder {
  findDue(now: Date, limit: number): Promise<DuePendingReference[]>;
}

/** Evento reivindicado por um publicador, com prazo de posse (lease). */
export interface ClaimedOutboxMessage {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
}

export interface OutboxStore {
  /**
   * Reivindica ate `limit` eventos pendentes e vencidos que ninguem detem (ou cujo lease expirou),
   * em ordem de ocorrencia. Publicadores concorrentes nunca recebem o mesmo evento ao mesmo tempo.
   */
  claim(owner: string, limit: number, leaseMs: number): Promise<ClaimedOutboxMessage[]>;
  /** Marca publicado se o lease ainda for deste dono; devolve false se outro ja assumiu. */
  markPublished(id: string, owner: string, at: Date): Promise<boolean>;
  /** Devolve o evento para a fila de pendentes, com nova tentativa agendada. */
  reschedule(id: string, owner: string, attempts: number, nextAttemptAt: Date, error: string): Promise<void>;
  /** Idade do evento pendente mais antigo, em ms (0 se nao houver). */
  oldestPendingAgeMs(now: Date): Promise<number>;
}

export interface PublishResult {
  id: string;
  ok: boolean;
  error?: string | undefined;
}

export interface EventPublisher {
  publish(messages: readonly ClaimedOutboxMessage[]): Promise<PublishResult[]>;
}

/** Metricas do catalogo (metrics-catalog.ts): nome ou rotulo fora dele nao compila. */
export interface Metrics {
  increment<N extends CounterName>(name: N, labels?: CounterLabels<N>, value?: number): void;
  observe<N extends HistogramName>(name: N, value: number, labels?: HistogramLabels<N>): void;
}

export interface AppLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/** Contexto de quem pediu: vira correlationId/causationId nos eventos e nos logs. */
export interface RequestContext {
  correlationId: string;
  causationId?: string | undefined;
}
