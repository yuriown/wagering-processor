import { HttpStatus } from "@nestjs/common";
import type { WagerOutcome } from "../../application/process-wager-transaction";
import type { MoneyProps } from "../../domain/money";
import { type WagerTransaction, WagerTransactionStatus } from "../../domain/wagering/wager-transaction";
import type { Wallet } from "../../domain/wallet/wallet";
import type { WalletLedgerEntry } from "../../domain/wallet/wallet-ledger-entry";

export function presentWallet(wallet: Wallet) {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    balance: wallet.balance.toJSON(),
    version: wallet.version,
  };
}

export function presentLedgerEntry(entry: WalletLedgerEntry) {
  return {
    id: entry.id,
    transactionId: entry.transactionId,
    direction: entry.direction,
    money: entry.money.toJSON(),
    balanceBefore: entry.balanceBefore.toJSON(),
    balanceAfter: entry.balanceAfter.toJSON(),
    walletVersion: entry.walletVersion,
    createdAt: entry.createdAt.toISOString(),
  };
}

export function presentTransaction(transaction: WagerTransaction) {
  return {
    id: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    money: transaction.money.toJSON(),
    status: transaction.status,
    ...optional("referenceExternalTransactionId", transaction.referenceExternalTransactionId),
    ...optional("referenceTransactionId", transaction.referenceTransactionId),
    ...optional("failureCode", transaction.failureCode),
    ...optional("balance", transaction.observedBalance?.toJSON()),
    createdAt: transaction.createdAt.toISOString(),
    ...optional("processedAt", transaction.processedAt?.toISOString()),
  };
}

export interface WagerResponse {
  transactionId: string;
  status: WagerTransactionStatus;
  balance?: MoneyProps;
  failureCode?: string;
  idempotentReplay: boolean;
}

/** Corpo e status da submissao. O replay devolve o mesmo corpo da primeira resposta, so com idempotentReplay=true. */
export function presentWagerOutcome(outcome: WagerOutcome): { status: number; body: WagerResponse } {
  const { transaction, idempotentReplay } = outcome;
  const body: WagerResponse = {
    transactionId: transaction.id,
    status: transaction.status,
    ...optional("balance", transaction.observedBalance?.toJSON()),
    ...optional("failureCode", transaction.failureCode),
    idempotentReplay,
  };
  return { status: wagerStatusCode(transaction.status, idempotentReplay), body };
}

function wagerStatusCode(status: WagerTransactionStatus, replay: boolean): number {
  switch (status) {
    case WagerTransactionStatus.Processed:
      return replay ? HttpStatus.OK : HttpStatus.CREATED;
    case WagerTransactionStatus.Pending:
    case WagerTransactionStatus.PendingReference:
      return HttpStatus.ACCEPTED;
    case WagerTransactionStatus.Rejected:
    case WagerTransactionStatus.Failed:
      return HttpStatus.UNPROCESSABLE_ENTITY;
  }
}

function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}
