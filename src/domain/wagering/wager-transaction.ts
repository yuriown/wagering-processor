import type { Money } from "../money";
import { type BackoffPolicy, nextAttemptAt } from "../shared/backoff";
import { DomainError, InvariantViolationError } from "../shared/domain-error";
import { LedgerDirection, oppositeDirection } from "../wallet/ledger-direction";
import type { FailureCode } from "./failure-code";
import { sha256Hex } from "./payload-hash";

export enum WagerTransactionKind {
  /** Interno: credito de abertura da wallet. Nunca aceito pela API nem pela fila. */
  Opening = "OPENING",
  Bet = "BET",
  Win = "WIN",
  Loss = "LOSS",
  Refund = "REFUND",
  Rollback = "ROLLBACK",
}

export enum WagerTransactionStatus {
  Pending = "PENDING",
  PendingReference = "PENDING_REFERENCE",
  Processed = "PROCESSED",
  Rejected = "REJECTED",
  Failed = "FAILED",
}

/** Tipos que provedores podem submeter (OPENING fica de fora). */
export const SUBMITTABLE_KINDS: readonly WagerTransactionKind[] = [
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
];

const TERMINAL_STATUSES: ReadonlySet<WagerTransactionStatus> = new Set([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
]);

/** Quem cada tipo pode referenciar. Ausente = nao aceita referencia. */
const ALLOWED_REFERENCES: Partial<Record<WagerTransactionKind, readonly WagerTransactionKind[]>> = {
  [WagerTransactionKind.Win]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Loss]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Rollback]: [WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund],
};

export const OPENING_PROVIDER_ID = "internal";

export class InvalidWagerTransactionError extends DomainError {
  readonly code = "INVALID_WAGER_TRANSACTION";
}

/** Tentativa de transicao proibida pela maquina de estados: erro de programacao. */
export class InvalidTransactionStateError extends InvariantViolationError {}

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  /** Id no provedor, nao o id interno. Obrigatorio em REFUND e ROLLBACK, opcional em WIN e LOSS. */
  referenceExternalTransactionId?: string | undefined;
  createdAt: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  status: WagerTransactionStatus;
  referenceTransactionId?: string | undefined;
  failureCode?: FailureCode | undefined;
  /** Momento em que a transacao chegou a um estado terminal. */
  processedAt?: Date | undefined;
  /** Saldo observado na decisao (PROCESSED ou REJECTED): e o que o replay devolve. */
  observedBalance?: Money | undefined;
  referenceAttempts: number;
  nextReferenceCheckAt?: Date | undefined;
}

export interface OpeningTransactionProps {
  id: string;
  walletId: string;
  playerId: string;
  money: Money;
  at: Date;
}

export interface MarkProcessedProps {
  referenceTransactionId: string | undefined;
  observedBalance: Money;
  at: Date;
}

/**
 * Operacao de um provedor sobre uma wallet. Transicoes validas:
 *
 *   PENDING ──────────► PROCESSED | REJECTED | FAILED
 *   PENDING ──────────► PENDING_REFERENCE
 *   PENDING_REFERENCE ► PENDING_REFERENCE (nova tentativa) | PROCESSED | REJECTED | FAILED
 *
 * PROCESSED, REJECTED e FAILED sao terminais: transicionar a partir deles lanca
 * InvalidTransactionStateError.
 */
export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId: string | undefined,
    private _failureCode: FailureCode | undefined,
    private _processedAt: Date | undefined,
    private _observedBalance: Money | undefined,
    private _referenceAttempts: number,
    private _nextReferenceCheckAt: Date | undefined,
  ) {}

  /** Nasce em PENDING. Valida o contrato de entrada e a exigencia de referencia por tipo. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    const fields = {
      id: props.id,
      providerId: props.providerId,
      externalTransactionId: props.externalTransactionId,
      idempotencyKey: props.idempotencyKey,
      payloadHash: props.payloadHash,
      walletId: props.walletId,
      playerId: props.playerId,
      roundId: props.roundId,
      gameId: props.gameId,
    };
    for (const [field, value] of Object.entries(fields)) {
      if (typeof value !== "string" || value.trim().length === 0) {
        throw new InvalidWagerTransactionError(`${field} e obrigatorio`);
      }
    }
    if (!SUBMITTABLE_KINDS.includes(props.kind)) {
      throw new InvalidWagerTransactionError(`kind nao aceito: ${String(props.kind)}`);
    }
    WagerTransaction.assertReferenceContract(props);
    WagerTransaction.assertAmount(props.kind, props.money);
    return WagerTransaction.fromCreate(props);
  }

  /** Credito interno de abertura: ja nasce PROCESSED, no mesmo commit que cria a wallet. */
  static opening(props: OpeningTransactionProps): WagerTransaction {
    if (!props.money.isPositive()) {
      throw new InvariantViolationError("OPENING so existe para saldo inicial positivo");
    }
    const externalTransactionId = `opening:${props.walletId}`;
    const transaction = WagerTransaction.fromCreate({
      id: props.id,
      providerId: OPENING_PROVIDER_ID,
      externalTransactionId,
      idempotencyKey: `${OPENING_PROVIDER_ID}:${externalTransactionId}`,
      payloadHash: sha256Hex(`${externalTransactionId}:${props.money.toString()}`),
      walletId: props.walletId,
      playerId: props.playerId,
      roundId: externalTransactionId,
      gameId: OPENING_PROVIDER_ID,
      kind: WagerTransactionKind.Opening,
      money: props.money,
      referenceExternalTransactionId: undefined,
      createdAt: props.at,
    });
    transaction.markProcessed({ referenceTransactionId: undefined, observedBalance: props.money, at: props.at });
    return transaction;
  }

  /** Reconstrucao a partir da persistencia: nao revalida transicoes. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      new Date(state.createdAt),
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt === undefined ? undefined : new Date(state.processedAt),
      state.observedBalance,
      state.referenceAttempts,
      state.nextReferenceCheckAt === undefined ? undefined : new Date(state.nextReferenceCheckAt),
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  get observedBalance(): Money | undefined {
    return this._observedBalance;
  }

  get referenceAttempts(): number {
    return this._referenceAttempts;
  }

  get nextReferenceCheckAt(): Date | undefined {
    return this._nextReferenceCheckAt;
  }

  // ---- transicoes

  markProcessed(props: MarkProcessedProps): void {
    this.assertNotTerminal("PROCESSED");
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = props.referenceTransactionId;
    this._observedBalance = props.observedBalance;
    this.finish(props.at);
  }

  /** Referencia ausente: agenda a proxima verificacao com backoff exponencial. */
  markPendingReference(at: Date, policy: BackoffPolicy): void {
    this.assertNotTerminal("PENDING_REFERENCE");
    this._status = WagerTransactionStatus.PendingReference;
    this._referenceAttempts += 1;
    this._nextReferenceCheckAt = nextAttemptAt(at, this._referenceAttempts, policy);
  }

  reject(code: FailureCode, observedBalance: Money | undefined, at: Date): void {
    this.assertNotTerminal("REJECTED");
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._observedBalance = observedBalance;
    this.finish(at);
  }

  fail(code: FailureCode, at: Date): void {
    this.assertNotTerminal("FAILED");
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this.finish(at);
  }

  // ---- consultas de dominio

  isTerminal(): boolean {
    return TERMINAL_STATUSES.has(this._status);
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return this.isReversal();
  }

  isReversal(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  /** Esta transacao pode ser referenciada por uma do tipo `kind`? */
  canBeReferencedBy(kind: WagerTransactionKind): boolean {
    return ALLOWED_REFERENCES[kind]?.includes(this.kind) ?? false;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  referenceRetriesExhausted(maxAttempts: number): boolean {
    return this._referenceAttempts >= maxAttempts;
  }

  /** Direcao do lancamento. ROLLBACK inverte a direcao da referencia; LOSS nao tem lancamento. */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback:
        if (reference === undefined) {
          throw new InvariantViolationError("ROLLBACK precisa da referencia para saber a direcao");
        }
        return oppositeDirection(reference.ledgerDirectionFor());
      case WagerTransactionKind.Loss:
        throw new InvariantViolationError("LOSS nao gera lancamento");
    }
  }

  private finish(at: Date): void {
    this._processedAt = at;
    this._nextReferenceCheckAt = undefined;
  }

  private assertNotTerminal(target: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(`transacao ${this.id} ja esta ${this._status}; nao pode ir para ${target}`);
    }
  }

  private static assertReferenceContract(props: CreateWagerTransactionProps): void {
    const reference = props.referenceExternalTransactionId;
    const allowed = ALLOWED_REFERENCES[props.kind] !== undefined;
    const required = props.kind === WagerTransactionKind.Refund || props.kind === WagerTransactionKind.Rollback;
    if (reference === undefined) {
      if (required) {
        throw new InvalidWagerTransactionError(`${props.kind} exige referenceExternalTransactionId`);
      }
      return;
    }
    if (!allowed) {
      throw new InvalidWagerTransactionError(`${props.kind} nao aceita referenceExternalTransactionId`);
    }
    if (typeof reference !== "string" || reference.trim().length === 0) {
      throw new InvalidWagerTransactionError("referenceExternalTransactionId nao pode ser vazio");
    }
    if (reference === props.externalTransactionId) {
      throw new InvalidWagerTransactionError("uma transacao nao pode referenciar a si mesma");
    }
  }

  /** LOSS pode registrar valor zero; as demais movem dinheiro e exigem valor positivo. */
  private static assertAmount(kind: WagerTransactionKind, money: Money): void {
    const valid = kind === WagerTransactionKind.Loss ? !money.isNegative() : money.isPositive();
    if (!valid) {
      throw new InvalidWagerTransactionError(`valor invalido para ${kind}: ${money}`);
    }
  }

  private static fromCreate(props: CreateWagerTransactionProps): WagerTransaction {
    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      props.createdAt,
      WagerTransactionStatus.Pending,
      undefined,
      undefined,
      undefined,
      undefined,
      0,
      undefined,
    );
  }
}
