/**
 * Erros da camada de aplicacao. Cada um tem um `code` estavel; a borda (HTTP, SQS)
 * decide o status e se a mensagem volta para a fila a partir da classe, nunca do texto.
 */
export abstract class ApplicationError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export interface ValidationIssue {
  field: string;
  message: string;
}

/** Payload invalido: corrigir e reenviar. */
export class ValidationError extends ApplicationError {
  readonly code = "VALIDATION_FAILED";

  constructor(readonly issues: ValidationIssue[]) {
    super(issues.map((i) => `${i.field}: ${i.message}`).join("; "));
  }
}

/** Mesma idempotency key (ou mesma operacao do provedor) com conteudo diferente. Nunca e replay. */
export class IdempotencyConflictError extends ApplicationError {
  readonly code = "IDEMPOTENCY_CONFLICT";

  constructor(
    message: string,
    readonly existingTransactionId: string,
  ) {
    super(message);
  }
}

export class WalletAlreadyExistsError extends ApplicationError {
  readonly code = "WALLET_ALREADY_EXISTS";
}

export class WalletNotFoundError extends ApplicationError {
  readonly code = "WALLET_NOT_FOUND";
}

export class TransactionNotFoundError extends ApplicationError {
  readonly code = "TRANSACTION_NOT_FOUND";
}

/** Mesmo messageId com payload diferente: nao e redelivery, e mensagem invalida (vai para a DLQ). */
export class InboxConflictError extends ApplicationError {
  readonly code = "MESSAGE_ID_CONFLICT";
}

/** Banco ou broker indisponivel, lock que nao saiu a tempo, deadlock: tentar de novo e seguro. */
export class TransientInfrastructureError extends ApplicationError {
  readonly code = "TEMPORARILY_UNAVAILABLE";

  constructor(
    message: string,
    readonly reason: "connection" | "lock_timeout" | "deadlock" | "serialization" | "timeout",
    options?: { cause?: unknown },
  ) {
    super(message);
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

/** Corrida perdida contra outra instancia num indice unico; o caso de uso tenta de novo e cai no replay. */
export class UniqueViolationError extends ApplicationError {
  readonly code = "UNIQUE_VIOLATION";

  constructor(
    message: string,
    readonly constraint: string | undefined,
  ) {
    super(message);
  }
}
