import { createHash } from "node:crypto";
import { Money, type MoneyProps } from "../money";

/** Campos de negocio que definem "a mesma operacao". Header e metadados de transporte ficam de fora. */
export interface WagerPayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string | undefined;
}

/**
 * JSON canonico: chaves de objeto em ordem lexicografica (code unit), sem espacos,
 * campos `undefined` omitidos. Arrays mantem a ordem.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (value === undefined || typeof value === "function" || typeof value === "bigint" || typeof value === "symbol") {
      throw new TypeError(`valor nao serializavel em JSON canonico: ${typeof value}`);
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/**
 * payloadHash = SHA-256 (hex minusculo) do JSON canonico do payload de negocio.
 * O valor passa por `Money` antes: "25.5" e "25.50" sao a mesma operacao.
 */
export function wagerPayloadHash(payload: WagerPayload): string {
  const normalized: WagerPayload = {
    providerId: payload.providerId,
    externalTransactionId: payload.externalTransactionId,
    playerId: payload.playerId,
    walletId: payload.walletId,
    roundId: payload.roundId,
    gameId: payload.gameId,
    kind: payload.kind,
    money: Money.from(payload.money).toJSON(),
    referenceExternalTransactionId: payload.referenceExternalTransactionId,
  };
  return sha256Hex(canonicalJson(normalized));
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
