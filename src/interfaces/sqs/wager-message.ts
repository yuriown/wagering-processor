import { ValidationError } from "../../application/errors";
import { type WagerCommand, parseWagerCommand } from "../../application/wager-command";
import { canonicalJson, sha256Hex } from "../../domain/wagering/payload-hash";

export const WAGER_REQUESTED = "WagerTransactionRequested";

export interface WagerTransactionRequested {
  messageId: string;
  type: typeof WAGER_REQUESTED;
  occurredAt: string;
  correlationId?: string;
  data: Record<string, unknown>;
}

export interface ParsedWagerMessage {
  messageId: string;
  correlationId: string;
  command: WagerCommand;
  /** Hash da mensagem inteira (JSON canonico): redelivery tem o mesmo; reuso de messageId nao. */
  payloadHash: string;
}

/** Corpo da fila -> comando. Qualquer problema aqui e permanente: a mesma mensagem nunca vai passar. */
export function parseWagerMessage(body: string | undefined): ParsedWagerMessage {
  let envelope: unknown;
  try {
    envelope = JSON.parse(body ?? "");
  } catch {
    throw new ValidationError([{ field: "body", message: "JSON invalido" }]);
  }
  if (envelope === null || typeof envelope !== "object" || Array.isArray(envelope)) {
    throw new ValidationError([{ field: "body", message: "envelope deve ser objeto" }]);
  }
  const message = envelope as Partial<WagerTransactionRequested>;
  if (message.type !== WAGER_REQUESTED) {
    throw new ValidationError([{ field: "type", message: `esperado ${WAGER_REQUESTED}` }]);
  }
  if (typeof message.messageId !== "string" || message.messageId.length === 0 || message.messageId.length > 256) {
    throw new ValidationError([{ field: "messageId", message: "obrigatorio, ate 256 caracteres" }]);
  }
  const data = message.data;
  if (data === null || typeof data !== "object") {
    throw new ValidationError([{ field: "data", message: "obrigatorio" }]);
  }
  const command = parseWagerCommand(data, (data as { idempotencyKey?: unknown }).idempotencyKey);
  const correlationId =
    typeof message.correlationId === "string" && message.correlationId.length > 0 ? message.correlationId : message.messageId;
  return { messageId: message.messageId, correlationId, command, payloadHash: sha256Hex(canonicalJson(envelope)) };
}
