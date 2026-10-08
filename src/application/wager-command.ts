import { InvalidMoneyError, Money, type MoneyProps } from "../domain/money";
import { SUBMITTABLE_KINDS, type WagerTransactionKind } from "../domain/wagering/wager-transaction";
import { ValidationError, type ValidationIssue } from "./errors";

/** Pedido de transacao do provedor, ja validado. Mesmo formato para HTTP e SQS. */
export interface WagerCommand {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string | undefined;
}

const TEXT_LIMITS = {
  providerId: 128,
  externalTransactionId: 256,
  playerId: 128,
  walletId: 36,
  roundId: 256,
  gameId: 256,
} as const;
const IDEMPOTENCY_KEY_LIMIT = 512;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Valida o corpo de uma transacao e junta todos os problemas numa unica resposta.
 * `idempotencyKey` vem do header (HTTP) ou de `data.idempotencyKey` (SQS).
 */
export function parseWagerCommand(body: unknown, idempotencyKey: unknown): WagerCommand {
  const issues: ValidationIssue[] = [];
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new ValidationError([{ field: "body", message: "deve ser um objeto JSON" }]);
  }
  const input = body as Record<string, unknown>;

  const text = (field: keyof typeof TEXT_LIMITS): string => {
    const value = input[field];
    if (typeof value !== "string" || value.trim().length === 0) {
      issues.push({ field, message: "obrigatorio, texto nao vazio" });
      return "";
    }
    if ([...value].length > TEXT_LIMITS[field]) {
      issues.push({ field, message: `no maximo ${TEXT_LIMITS[field]} caracteres` });
    }
    return value;
  };

  const providerId = text("providerId");
  const externalTransactionId = text("externalTransactionId");
  const playerId = text("playerId");
  const walletId = text("walletId");
  const roundId = text("roundId");
  const gameId = text("gameId");
  if (walletId && !UUID.test(walletId)) {
    issues.push({ field: "walletId", message: "deve ser um UUID" });
  }

  if (typeof idempotencyKey !== "string" || idempotencyKey.trim().length === 0) {
    issues.push({ field: "idempotencyKey", message: "obrigatoria (header Idempotency-Key)" });
  } else if ([...idempotencyKey].length > IDEMPOTENCY_KEY_LIMIT) {
    issues.push({ field: "idempotencyKey", message: `no maximo ${IDEMPOTENCY_KEY_LIMIT} caracteres` });
  }

  const kind = input.kind;
  if (typeof kind !== "string" || !(SUBMITTABLE_KINDS as readonly string[]).includes(kind)) {
    issues.push({ field: "kind", message: `deve ser um de ${SUBMITTABLE_KINDS.join(", ")}` });
  }

  let money: MoneyProps = { amount: "", currency: "" };
  try {
    money = Money.from(input.money as MoneyProps).toJSON();
  } catch (error) {
    if (!(error instanceof InvalidMoneyError)) throw error;
    issues.push({ field: "money", message: error.message });
  }

  const reference = input.referenceExternalTransactionId;
  if (reference !== undefined && reference !== null) {
    if (typeof reference !== "string" || reference.trim().length === 0) {
      issues.push({ field: "referenceExternalTransactionId", message: "texto nao vazio quando presente" });
    } else if ([...reference].length > TEXT_LIMITS.externalTransactionId) {
      issues.push({ field: "referenceExternalTransactionId", message: "no maximo 256 caracteres" });
    }
  }

  if (issues.length > 0) {
    throw new ValidationError(issues);
  }
  return {
    providerId,
    externalTransactionId,
    idempotencyKey: idempotencyKey as string,
    playerId,
    walletId: walletId.toLowerCase(),
    roundId,
    gameId,
    kind: kind as WagerTransactionKind,
    money,
    referenceExternalTransactionId: typeof reference === "string" ? reference : undefined,
  };
}
