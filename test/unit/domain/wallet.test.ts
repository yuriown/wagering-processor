import { describe, expect, test } from "bun:test";
import { CurrencyMismatchError, Money } from "../../../src/domain/money";
import { InvariantViolationError } from "../../../src/domain/shared/domain-error";
import { LedgerDirection } from "../../../src/domain/wallet/ledger-direction";
import { InsufficientFundsError, Wallet } from "../../../src/domain/wallet/wallet";
import { WalletLedgerEntry } from "../../../src/domain/wallet/wallet-ledger-entry";
import { PLAYER, T0, WALLET, brl, openWallet } from "./fixtures";

const T1 = new Date("2026-07-29T15:00:01.000Z");

describe("Wallet.open", () => {
  test("saldo inicial positivo: version 1 e lancamento CREDIT de abertura", () => {
    const { wallet, openingEntry } = Wallet.open({
      id: WALLET,
      playerId: PLAYER,
      initialBalance: brl("1000.00"),
      openingTransactionId: "opening-tx",
      openingEntryId: "opening-entry",
      at: T0,
    });
    expect(wallet.balance.toJSON()).toEqual({ amount: "1000.00", currency: "BRL" });
    expect(wallet.version).toBe(1);
    expect(wallet.currency).toBe("BRL");
    expect(openingEntry).toBeDefined();
    expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
    expect(openingEntry?.transactionId).toBe("opening-tx");
    expect(openingEntry?.balanceBefore.isZero()).toBe(true);
    expect(openingEntry?.balanceAfter.equals(wallet.balance)).toBe(true);
    expect(openingEntry?.walletVersion).toBe(1);
  });

  test("saldo inicial zero: version 1 e nenhum lancamento", () => {
    const { wallet, openingEntry } = Wallet.open({
      id: WALLET,
      playerId: PLAYER,
      initialBalance: Money.zero("BRL"),
      openingTransactionId: "opening-tx",
      openingEntryId: "opening-entry",
      at: T0,
    });
    expect(wallet.balance.isZero()).toBe(true);
    expect(wallet.version).toBe(1);
    expect(openingEntry).toBeUndefined();
  });
});

describe("debit e credit", () => {
  test("debito gera lancamento coerente e incrementa version", () => {
    const wallet = openWallet("100.00");
    const entry = wallet.debit({ entryId: "e1", transactionId: "t1", money: brl("80.00"), at: T1 });
    expect(wallet.balance.toJSON().amount).toBe("20.00");
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt).toEqual(T1);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceBefore.toJSON().amount).toBe("100.00");
    expect(entry.balanceAfter.toJSON().amount).toBe("20.00");
    expect(entry.walletVersion).toBe(2);
  });

  test("credito gera lancamento coerente e incrementa version", () => {
    const wallet = openWallet("100.00");
    const entry = wallet.credit({ entryId: "e1", transactionId: "t1", money: brl("50.25"), at: T1 });
    expect(wallet.balance.toJSON().amount).toBe("150.25");
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Credit);
  });

  test("debitar exatamente o saldo zera a wallet (nao e negativo)", () => {
    const wallet = openWallet("100.00");
    wallet.debit({ entryId: "e1", transactionId: "t1", money: brl("100.00"), at: T1 });
    expect(wallet.balance.isZero()).toBe(true);
  });

  test("saldo insuficiente: lanca e nao muda saldo nem version", () => {
    const wallet = openWallet("100.00");
    expect(wallet.canDebit(brl("100.01"))).toBe(false);
    expect(() => wallet.debit({ entryId: "e1", transactionId: "t1", money: brl("100.01"), at: T1 })).toThrow(
      InsufficientFundsError,
    );
    expect(wallet.balance.toJSON().amount).toBe("100.00");
    expect(wallet.version).toBe(1);
    expect(wallet.updatedAt).toEqual(T0);
  });

  test("moeda diferente da wallet: lanca e nao muda nada", () => {
    const wallet = openWallet("100.00");
    const usd = Money.from({ amount: "1.00", currency: "USD" });
    expect(() => wallet.credit({ entryId: "e1", transactionId: "t1", money: usd, at: T1 })).toThrow(CurrencyMismatchError);
    expect(() => wallet.debit({ entryId: "e1", transactionId: "t1", money: usd, at: T1 })).toThrow(CurrencyMismatchError);
    expect(wallet.version).toBe(1);
  });

  test("valor zero nao vira lancamento", () => {
    const wallet = openWallet("100.00");
    expect(() => wallet.credit({ entryId: "e1", transactionId: "t1", money: brl("0.00"), at: T1 })).toThrow(
      InvariantViolationError,
    );
    expect(wallet.version).toBe(1);
  });

  test("saldo reconstruido pelo ledger == saldo da wallet", () => {
    const { wallet, openingEntry } = Wallet.open({
      id: WALLET,
      playerId: PLAYER,
      initialBalance: brl("100.00"),
      openingTransactionId: "o",
      openingEntryId: "oe",
      at: T0,
    });
    const entries: WalletLedgerEntry[] = openingEntry ? [openingEntry] : [];
    entries.push(wallet.debit({ entryId: "e1", transactionId: "t1", money: brl("30.00"), at: T1 }));
    entries.push(wallet.credit({ entryId: "e2", transactionId: "t2", money: brl("12.34"), at: T1 }));
    entries.push(wallet.debit({ entryId: "e3", transactionId: "t3", money: brl("82.34"), at: T1 }));

    const rebuilt = entries.reduce((sum, e) => sum.add(e.signedAmount()), Money.zero("BRL"));
    expect(rebuilt.equals(wallet.balance)).toBe(true);
    expect(wallet.balance.isZero()).toBe(true);
    // Corrente: cada lancamento parte do saldo em que o anterior terminou, e as versoes sao consecutivas.
    entries.slice(1).forEach((entry, i) => {
      expect(entry.balanceBefore.equals(entries[i]!.balanceAfter)).toBe(true);
      expect(entry.walletVersion).toBe(entries[i]!.walletVersion + 1);
    });
  });
});

describe("WalletLedgerEntry", () => {
  const base = {
    id: "e1",
    walletId: WALLET,
    transactionId: "t1",
    direction: LedgerDirection.Debit,
    money: brl("10.00"),
    balanceBefore: brl("100.00"),
    balanceAfter: brl("90.00"),
    walletVersion: 2,
    createdAt: T0,
  };

  test("create valida a aritmetica", () => {
    expect(WalletLedgerEntry.create(base).isBalanced()).toBe(true);
    expect(() => WalletLedgerEntry.create({ ...base, balanceAfter: brl("91.00") })).toThrow(InvariantViolationError);
    expect(() => WalletLedgerEntry.create({ ...base, direction: LedgerDirection.Credit })).toThrow(
      InvariantViolationError,
    );
  });

  test("create recusa saldo negativo, valor nao positivo e version invalida", () => {
    expect(() =>
      WalletLedgerEntry.create({ ...base, balanceBefore: brl("5.00"), balanceAfter: brl("5.00").subtract(brl("10.00")) }),
    ).toThrow(InvariantViolationError);
    expect(() => WalletLedgerEntry.create({ ...base, money: brl("0.00"), balanceAfter: brl("100.00") })).toThrow(
      InvariantViolationError,
    );
    expect(() => WalletLedgerEntry.create({ ...base, walletVersion: 0 })).toThrow(InvariantViolationError);
  });

  test("imutabilidade estrutural: instancia congelada, sem setter", () => {
    const entry = WalletLedgerEntry.create(base);
    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => {
      (entry as unknown as { balanceAfter: Money }).balanceAfter = brl("1000.00");
    }).toThrow(TypeError);
    expect(entry.balanceAfter.toJSON().amount).toBe("90.00");
  });
});
