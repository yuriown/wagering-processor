import { describe, expect, test } from "bun:test";
import { Money } from "../../../src/domain/money";
import { FailureCode } from "../../../src/domain/wagering/failure-code";
import {
  REFERENCE_MAX_ATTEMPTS,
  type SettlementResult,
  expirePendingReference,
  settleWagerTransaction,
} from "../../../src/domain/wagering/wager-settlement";
import {
  InvalidTransactionStateError,
  type WagerTransaction,
  type WagerTransactionKind,
  WagerTransactionStatus,
} from "../../../src/domain/wagering/wager-transaction";
import { LedgerDirection } from "../../../src/domain/wallet/ledger-direction";
import type { Wallet } from "../../../src/domain/wallet/wallet";
import type { WalletLedgerEntry } from "../../../src/domain/wallet/wallet-ledger-entry";
import { InvariantViolationError } from "../../../src/domain/shared/domain-error";
import { Kind, T0, type TxOverrides, brl, nextId, openWallet, wagerTx } from "./fixtures";

function settle(
  tx: WagerTransaction,
  wallet: Wallet,
  reference?: WagerTransaction,
  referenceAlreadyReversed = false,
): SettlementResult {
  return settleWagerTransaction({ transaction: tx, wallet, reference, referenceAlreadyReversed, entryId: nextId("entry"), at: T0 });
}

/** Cria e processa uma transacao, devolvendo-a ja PROCESSED. */
function processed(kind: WagerTransactionKind, wallet: Wallet, overrides: TxOverrides = {}, reference?: WagerTransaction): WagerTransaction {
  const tx = wagerTx(kind, overrides);
  const result = settle(tx, wallet, reference);
  expect(result.status).toBe(WagerTransactionStatus.Processed);
  return tx;
}



describe("BET", () => {
  test("debita e gera 1 lancamento DEBIT", () => {
    const wallet = openWallet("100.00");
    const tx = wagerTx(Kind.Bet, { amount: "25.00" });
    const result = settle(tx, wallet);
    expect(result.status).toBe(WagerTransactionStatus.Processed);
    if (result.status !== WagerTransactionStatus.Processed) return;
    expect(result.entry?.direction).toBe(LedgerDirection.Debit);
    expect(result.entry?.transactionId).toBe(tx.id);
    expect(wallet.balance.toJSON().amount).toBe("75.00");
    expect(tx.observedBalance?.toJSON().amount).toBe("75.00");
  });

  test("saldo insuficiente: REJECTED com INSUFFICIENT_FUNDS, sem lancamento e sem mexer no saldo", () => {
    const wallet = openWallet("100.00");
    const tx = wagerTx(Kind.Bet, { amount: "100.01" });
    const result = settle(tx, wallet);
    expect(result).toEqual({ status: WagerTransactionStatus.Rejected, failureCode: FailureCode.InsufficientFunds });
    expect(tx.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(wallet.balance.toJSON().amount).toBe("100.00");
    expect(wallet.version).toBe(1);
    expect(tx.observedBalance?.toJSON().amount).toBe("100.00");
  });

  test("cenario da secao 8 (sequencial): 100.00 e duas apostas de 80.00 -> uma passa, outra rejeita", () => {
    const wallet = openWallet("100.00");
    const first = settle(wagerTx(Kind.Bet, { amount: "80.00" }), wallet);
    const second = settle(wagerTx(Kind.Bet, { amount: "80.00" }), wallet);
    expect(first.status).toBe(WagerTransactionStatus.Processed);
    expect(second).toEqual({ status: WagerTransactionStatus.Rejected, failureCode: FailureCode.InsufficientFunds });
    expect(wallet.balance.toJSON().amount).toBe("20.00");
  });
});

describe("WIN", () => {
  test("credita sem referencia", () => {
    const wallet = openWallet("100.00");
    const result = settle(wagerTx(Kind.Win, { amount: "40.00" }), wallet);
    expect(result.status).toBe(WagerTransactionStatus.Processed);
    expect(wallet.balance.toJSON().amount).toBe("140.00");
  });

  test("com referencia a BET da mesma rodada: credita e guarda o id interno da BET; valor pode diferir", () => {
    const wallet = openWallet("100.00");
    const bet = processed(Kind.Bet, wallet, { externalTransactionId: "bet-1", amount: "10.00" });
    const win = wagerTx(Kind.Win, { amount: "35.00", referenceExternalTransactionId: "bet-1" });
    expect(settle(win, wallet, bet).status).toBe(WagerTransactionStatus.Processed);
    expect(win.referenceTransactionId).toBe(bet.id);
    expect(wallet.balance.toJSON().amount).toBe("125.00");
  });

  test("referenciando algo que nao e BET: INVALID_REFERENCE_KIND", () => {
    const wallet = openWallet("100.00");
    const otherWin = processed(Kind.Win, wallet, { externalTransactionId: "win-1" });
    const win = wagerTx(Kind.Win, { referenceExternalTransactionId: "win-1" });
    expect(settle(win, wallet, otherWin)).toEqual({
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.InvalidReferenceKind,
    });
  });
});

describe("LOSS", () => {
  test("PROCESSED sem lancamento e sem mudar saldo nem version", () => {
    const wallet = openWallet("100.00");
    const tx = wagerTx(Kind.Loss, { amount: "25.00" });
    const result = settle(tx, wallet);
    expect(result).toEqual({ status: WagerTransactionStatus.Processed, entry: undefined });
    expect(wallet.balance.toJSON().amount).toBe("100.00");
    expect(wallet.version).toBe(1);
    expect(tx.observedBalance?.toJSON().amount).toBe("100.00");
  });
});

describe("REFUND", () => {
  test("credita o valor da BET referenciada", () => {
    const wallet = openWallet("100.00");
    const bet = processed(Kind.Bet, wallet, { externalTransactionId: "bet-1", amount: "30.00" });
    const refund = wagerTx(Kind.Refund, { amount: "30.00", referenceExternalTransactionId: "bet-1" });
    const result = settle(refund, wallet, bet);
    expect(result.status).toBe(WagerTransactionStatus.Processed);
    if (result.status !== WagerTransactionStatus.Processed) return;
    expect(result.entry?.direction).toBe(LedgerDirection.Credit);
    expect(refund.referenceTransactionId).toBe(bet.id);
    expect(wallet.balance.toJSON().amount).toBe("100.00");
  });

  test("so referencia BET", () => {
    const wallet = openWallet("100.00");
    const win = processed(Kind.Win, wallet, { externalTransactionId: "win-1", amount: "30.00" });
    const refund = wagerTx(Kind.Refund, { amount: "30.00", referenceExternalTransactionId: "win-1" });
    expect(settle(refund, wallet, win)).toEqual({
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.InvalidReferenceKind,
    });
  });

  test("valor diferente da BET: AMOUNT_MISMATCH (reversao parcial fora de escopo)", () => {
    const wallet = openWallet("100.00");
    const bet = processed(Kind.Bet, wallet, { externalTransactionId: "bet-1", amount: "30.00" });
    const refund = wagerTx(Kind.Refund, { amount: "10.00", referenceExternalTransactionId: "bet-1" });
    expect(settle(refund, wallet, bet)).toEqual({
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.AmountMismatch,
    });
    expect(wallet.balance.toJSON().amount).toBe("70.00");
  });

  test("uma unica vez: segunda reversao da mesma BET e REFERENCE_ALREADY_REVERSED", () => {
    const wallet = openWallet("100.00");
    const bet = processed(Kind.Bet, wallet, { externalTransactionId: "bet-1", amount: "30.00" });
    processed(Kind.Refund, wallet, { amount: "30.00", referenceExternalTransactionId: "bet-1" }, bet);
    const again = wagerTx(Kind.Refund, { amount: "30.00", referenceExternalTransactionId: "bet-1" });
    expect(settle(again, wallet, bet, true)).toEqual({
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.ReferenceAlreadyReversed,
    });
    expect(wallet.balance.toJSON().amount).toBe("100.00");
  });

  test("referencia REJECTED: REFERENCE_NOT_PROCESSED", () => {
    const wallet = openWallet("10.00");
    const bet = wagerTx(Kind.Bet, { externalTransactionId: "bet-1", amount: "30.00" });
    expect(settle(bet, wallet).status).toBe(WagerTransactionStatus.Rejected);
    const refund = wagerTx(Kind.Refund, { amount: "30.00", referenceExternalTransactionId: "bet-1" });
    expect(settle(refund, wallet, bet)).toEqual({
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.ReferenceNotProcessed,
    });
    expect(wallet.balance.toJSON().amount).toBe("10.00");
  });

  test.each([
    ["rodada", { roundId: "outra-rodada" }],
    ["provider", { providerId: "provider-b" }],
  ])("referencia de outra %s: REFERENCE_MISMATCH", (_label, overrides) => {
    const wallet = openWallet("100.00");
    const bet = processed(Kind.Bet, wallet, { externalTransactionId: "bet-1", amount: "30.00" });
    const refund = wagerTx(Kind.Refund, { amount: "30.00", referenceExternalTransactionId: "bet-1", ...overrides });
    expect(settle(refund, wallet, bet)).toEqual({
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.ReferenceMismatch,
    });
  });
});

describe("ROLLBACK", () => {
  test("de BET: credita (inverso do debito)", () => {
    const wallet = openWallet("100.00");
    const bet = processed(Kind.Bet, wallet, { externalTransactionId: "bet-1", amount: "30.00" });
    const rollback = wagerTx(Kind.Rollback, { amount: "30.00", referenceExternalTransactionId: "bet-1" });
    const result = settle(rollback, wallet, bet);
    expect(result.status).toBe(WagerTransactionStatus.Processed);
    if (result.status !== WagerTransactionStatus.Processed) return;
    expect(result.entry?.direction).toBe(LedgerDirection.Credit);
    expect(wallet.balance.toJSON().amount).toBe("100.00");
  });

  test("de WIN: debita (inverso do credito)", () => {
    const wallet = openWallet("100.00");
    const win = processed(Kind.Win, wallet, { externalTransactionId: "win-1", amount: "50.00" });
    const rollback = wagerTx(Kind.Rollback, { amount: "50.00", referenceExternalTransactionId: "win-1" });
    const result = settle(rollback, wallet, win);
    expect(result.status).toBe(WagerTransactionStatus.Processed);
    if (result.status !== WagerTransactionStatus.Processed) return;
    expect(result.entry?.direction).toBe(LedgerDirection.Debit);
    expect(wallet.balance.toJSON().amount).toBe("100.00");
  });

  test("de REFUND: debita, desfazendo o reembolso", () => {
    const wallet = openWallet("100.00");
    const bet = processed(Kind.Bet, wallet, { externalTransactionId: "bet-1", amount: "30.00" });
    const refund = processed(
      Kind.Refund,
      wallet,
      { externalTransactionId: "refund-1", amount: "30.00", referenceExternalTransactionId: "bet-1" },
      bet,
    );
    const rollback = wagerTx(Kind.Rollback, { amount: "30.00", referenceExternalTransactionId: "refund-1" });
    expect(settle(rollback, wallet, refund).status).toBe(WagerTransactionStatus.Processed);
    expect(wallet.balance.toJSON().amount).toBe("70.00");
  });

  test("de WIN ja gasto: REVERSAL_WOULD_OVERDRAW, distinto de INSUFFICIENT_FUNDS, saldo intacto", () => {
    const wallet = openWallet("0.00");
    const win = processed(Kind.Win, wallet, { externalTransactionId: "win-1", amount: "50.00" });
    processed(Kind.Bet, wallet, { amount: "45.00" });
    const rollback = wagerTx(Kind.Rollback, { amount: "50.00", referenceExternalTransactionId: "win-1" });
    expect(settle(rollback, wallet, win)).toEqual({
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.ReversalWouldOverdraw,
    });
    expect(FailureCode.ReversalWouldOverdraw).not.toBe(FailureCode.InsufficientFunds);
    expect(wallet.balance.toJSON().amount).toBe("5.00");
    expect(rollback.observedBalance?.toJSON().amount).toBe("5.00");
  });

  test("de LOSS: INVALID_REFERENCE_KIND", () => {
    const wallet = openWallet("100.00");
    const loss = processed(Kind.Loss, wallet, { externalTransactionId: "loss-1", amount: "30.00" });
    const rollback = wagerTx(Kind.Rollback, { amount: "30.00", referenceExternalTransactionId: "loss-1" });
    expect(settle(rollback, wallet, loss)).toEqual({
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.InvalidReferenceKind,
    });
  });

  test("BET ja reembolsada nao pode ser revertida de novo (nem por ROLLBACK)", () => {
    const wallet = openWallet("100.00");
    const bet = processed(Kind.Bet, wallet, { externalTransactionId: "bet-1", amount: "30.00" });
    processed(Kind.Refund, wallet, { amount: "30.00", referenceExternalTransactionId: "bet-1" }, bet);
    const rollback = wagerTx(Kind.Rollback, { amount: "30.00", referenceExternalTransactionId: "bet-1" });
    expect(settle(rollback, wallet, bet, true)).toEqual({
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.ReferenceAlreadyReversed,
    });
    expect(wallet.balance.toJSON().amount).toBe("100.00");
  });
});

describe("referencia fora de ordem", () => {
  test("referencia ausente: PENDING_REFERENCE, sem tocar no saldo", () => {
    const wallet = openWallet("100.00");
    const rollback = wagerTx(Kind.Rollback, { amount: "30.00", referenceExternalTransactionId: "bet-ainda-nao-chegou" });
    expect(settle(rollback, wallet, undefined)).toEqual({ status: WagerTransactionStatus.PendingReference });
    expect(rollback.status).toBe(WagerTransactionStatus.PendingReference);
    expect(rollback.referenceAttempts).toBe(1);
    expect(rollback.nextReferenceCheckAt?.getTime()).toBeGreaterThan(T0.getTime());
    expect(wallet.version).toBe(1);
  });

  test("referencia chega depois: reprocessar aplica normalmente", () => {
    const wallet = openWallet("100.00");
    const refund = wagerTx(Kind.Refund, { amount: "30.00", referenceExternalTransactionId: "bet-1" });
    settle(refund, wallet, undefined);
    const bet = processed(Kind.Bet, wallet, { externalTransactionId: "bet-1", amount: "30.00" });
    expect(settle(refund, wallet, bet).status).toBe(WagerTransactionStatus.Processed);
    expect(wallet.balance.toJSON().amount).toBe("100.00");
  });

  test("referencia que tambem esta esperando: continua PENDING_REFERENCE", () => {
    const wallet = openWallet("100.00");
    const refund = wagerTx(Kind.Refund, { externalTransactionId: "refund-1", amount: "30.00", referenceExternalTransactionId: "bet-1" });
    settle(refund, wallet, undefined);
    const rollback = wagerTx(Kind.Rollback, { amount: "30.00", referenceExternalTransactionId: "refund-1" });
    expect(settle(rollback, wallet, refund).status).toBe(WagerTransactionStatus.PendingReference);
  });

  test("esgotado o limite: REJECTED com REFERENCE_NOT_FOUND", () => {
    const wallet = openWallet("100.00");
    const refund = wagerTx(Kind.Refund, { amount: "30.00", referenceExternalTransactionId: "bet-1" });
    for (let i = 0; i < REFERENCE_MAX_ATTEMPTS; i++) settle(refund, wallet, undefined);
    expect(refund.referenceRetriesExhausted(REFERENCE_MAX_ATTEMPTS)).toBe(true);
    expirePendingReference(refund, wallet, T0);
    expect(refund.status).toBe(WagerTransactionStatus.Rejected);
    expect(refund.failureCode).toBe(FailureCode.ReferenceNotFound);
    expect(wallet.balance.toJSON().amount).toBe("100.00");
  });
});

describe("validacoes de wallet", () => {
  test("moeda da operacao diferente da wallet: CURRENCY_MISMATCH", () => {
    const wallet = openWallet("100.00");
    const tx = wagerTx(Kind.Bet, { currency: "USD" });
    expect(settle(tx, wallet)).toEqual({ status: WagerTransactionStatus.Rejected, failureCode: FailureCode.CurrencyMismatch });
    expect(wallet.balance.equals(Money.from({ amount: "100.00", currency: "BRL" }))).toBe(true);
  });

  test("wallet de outro player: WALLET_PLAYER_MISMATCH", () => {
    const wallet = openWallet("100.00", { playerId: "outro-player" });
    expect(settle(wagerTx(Kind.Bet), wallet)).toEqual({
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.WalletPlayerMismatch,
    });
  });

  test("transacao de outra wallet e erro de programacao", () => {
    const wallet = openWallet("100.00", { id: "outra-wallet" });
    expect(() => settle(wagerTx(Kind.Bet), wallet)).toThrow(InvariantViolationError);
  });

  test("reaplicar transacao ja PROCESSED e erro de programacao, nunca debito duplo", () => {
    const wallet = openWallet("100.00");
    const bet = processed(Kind.Bet, wallet, { amount: "30.00" });
    expect(() => settle(bet, wallet)).toThrow(InvalidTransactionStateError);
    expect(wallet.balance.toJSON().amount).toBe("70.00");
    expect(wallet.version).toBe(2);
  });
});

test("conservacao: depois de uma sequencia mista, ledger reconstroi o saldo", () => {
  const wallet = openWallet("0.00");
  const entries: WalletLedgerEntry[] = [];
  const run = (tx: WagerTransaction, ref?: WagerTransaction) => {
    const r = settle(tx, wallet, ref);
    if (r.status === WagerTransactionStatus.Processed && r.entry) entries.push(r.entry);
    return tx;
  };
  run(wagerTx(Kind.Win, { amount: "100.00" }));
  const bet = run(wagerTx(Kind.Bet, { externalTransactionId: "b1", amount: "60.00" }));
  run(wagerTx(Kind.Bet, { amount: "60.00" })); // rejeitada
  run(wagerTx(Kind.Loss, { amount: "60.00" }));
  run(wagerTx(Kind.Refund, { amount: "60.00", referenceExternalTransactionId: "b1" }), bet);
  run(wagerTx(Kind.Bet, { amount: "99.99" }));
  const rebuilt = entries.reduce((sum, e) => sum.add(e.signedAmount()), Money.zero("BRL"));
  expect(rebuilt.equals(wallet.balance)).toBe(true);
  expect(wallet.balance.toJSON().amount).toBe("0.01");
  expect(entries.length).toBe(4);
  expect(wallet.version).toBe(1 + entries.length);
  expect(brl("0.01").equals(wallet.balance)).toBe(true);
});
