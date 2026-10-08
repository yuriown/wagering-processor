import type { WagerTransaction } from "../domain/wagering/wager-transaction";
import type { Wallet } from "../domain/wallet/wallet";
import type { WalletLedgerEntry } from "../domain/wallet/wallet-ledger-entry";
import { TransactionNotFoundError, ValidationError, WalletNotFoundError } from "./errors";
import type { TransactionRunner } from "./ports";

export const LEDGER_PAGE_DEFAULT = 50;
export const LEDGER_PAGE_MAX = 200;

export interface LedgerPage {
  entries: WalletLedgerEntry[];
  /** Opaco para o cliente; ausente quando nao ha mais paginas. */
  nextCursor: string | undefined;
}

/**
 * Cursor = base64url de {"v": walletVersion do ultimo item}. walletVersion e unica e
 * crescente por wallet, entao a pagina seguinte e estavel mesmo com novos lancamentos
 * chegando (eles entram depois, nunca no meio).
 */
export function encodeLedgerCursor(walletVersion: number): string {
  return Buffer.from(JSON.stringify({ v: walletVersion })).toString("base64url");
}

export function decodeLedgerCursor(cursor: string): number {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    const version = (parsed as { v?: unknown }).v;
    if (typeof version === "number" && Number.isInteger(version) && version >= 0) return version;
  } catch {
    // cai no erro abaixo
  }
  throw new ValidationError([{ field: "cursor", message: "cursor invalido" }]);
}

export function parseLedgerLimit(raw: unknown): number {
  if (raw === undefined || raw === null || raw === "") return LEDGER_PAGE_DEFAULT;
  const text = String(raw);
  if (!/^\d+$/.test(text)) {
    throw new ValidationError([{ field: "limit", message: `inteiro entre 1 e ${LEDGER_PAGE_MAX}` }]);
  }
  const limit = Number.parseInt(text, 10);
  if (limit < 1 || limit > LEDGER_PAGE_MAX) {
    throw new ValidationError([{ field: "limit", message: `inteiro entre 1 e ${LEDGER_PAGE_MAX}` }]);
  }
  return limit;
}

export class WalletQueries {
  constructor(private readonly runner: TransactionRunner) {}

  async getWallet(walletId: string): Promise<Wallet> {
    const wallet = await this.runner.read((uow) => uow.wallets.findById(walletId));
    if (wallet === undefined) throw new WalletNotFoundError(`wallet ${walletId} nao existe`);
    return wallet;
  }

  async getLedgerPage(walletId: string, cursor: string | undefined, limit: number): Promise<LedgerPage> {
    const after = cursor === undefined || cursor === "" ? 0 : decodeLedgerCursor(cursor);
    return this.runner.read(async (uow) => {
      if ((await uow.wallets.findById(walletId)) === undefined) {
        throw new WalletNotFoundError(`wallet ${walletId} nao existe`);
      }
      const rows = await uow.ledger.page(walletId, after, limit + 1);
      const entries = rows.slice(0, limit);
      const last = entries.at(-1);
      return {
        entries,
        nextCursor: rows.length > limit && last !== undefined ? encodeLedgerCursor(last.walletVersion) : undefined,
      };
    });
  }

  async getTransaction(transactionId: string): Promise<WagerTransaction> {
    const transaction = await this.runner.read((uow) => uow.transactions.findById(transactionId));
    if (transaction === undefined) throw new TransactionNotFoundError(`transacao ${transactionId} nao existe`);
    return transaction;
  }

  async getProviderTransaction(providerId: string, externalTransactionId: string): Promise<WagerTransaction> {
    const transaction = await this.runner.read((uow) =>
      uow.transactions.findByExternalId(providerId, externalTransactionId),
    );
    if (transaction === undefined) {
      throw new TransactionNotFoundError(`transacao ${providerId}/${externalTransactionId} nao existe`);
    }
    return transaction;
  }
}
