import { describe, expect, test } from "bun:test";
import { CurrencyMismatchError, InvalidMoneyError, Money } from "../../../src/domain/money";
import { brl } from "./fixtures";

describe("Money.from", () => {
  test.each([
    ["25.00", "25.00"],
    ["25.5", "25.50"],
    ["25", "25.00"],
    ["0", "0.00"],
    ["0.01", "0.01"],
    ["999999999999999999.99", "999999999999999999.99"],
  ])("aceita %p e serializa com escala 2 como %p", (input, expected) => {
    expect(Money.from({ amount: input, currency: "BRL" }).toJSON()).toEqual({ amount: expected, currency: "BRL" });
  });

  test.each([
    "",
    " ",
    "NaN",
    "Infinity",
    "-Infinity",
    "1e3",
    "1E3",
    "2.5e-1",
    "0x10",
    "-1.00",
    "-0.01",
    "+1.00",
    "1.234",
    "0.001",
    "01.00",
    "1.",
    ".50",
    " 1.00",
    "1.00 ",
    "1,00",
    "1_000.00",
    "1000000000000000000.00",
  ])("recusa amount %p", (amount) => {
    expect(() => Money.from({ amount, currency: "BRL" })).toThrow(InvalidMoneyError);
  });

  test("recusa amount que nao e string (number nunca entra)", () => {
    expect(() => Money.from({ amount: 25 as unknown as string, currency: "BRL" })).toThrow(InvalidMoneyError);
    expect(() => Money.from(null as unknown as { amount: string; currency: string })).toThrow(InvalidMoneyError);
  });

  test.each(["brl", "BR", "BRLL", "", "R$", "123"])("recusa currency %p", (currency) => {
    expect(() => Money.from({ amount: "1.00", currency })).toThrow(InvalidMoneyError);
  });
});

describe("aritmetica exata", () => {
  test("0.10 + 0.20 == 0.30 (o classico que float erra)", () => {
    expect(brl("0.10").add(brl("0.20")).equals(brl("0.30"))).toBe(true);
  });

  test("somar mil vezes 0.01 da 10.00", () => {
    let total = Money.zero("BRL");
    for (let i = 0; i < 1000; i++) total = total.add(brl("0.01"));
    expect(total.toJSON().amount).toBe("10.00");
  });

  test("valores grandes nao perdem precisao", () => {
    const big = brl("999999999999999999.99");
    expect(big.subtract(brl("0.01")).toJSON().amount).toBe("999999999999999999.98");
  });

  test("subtract pode ficar negativo internamente; negate inverte o sinal", () => {
    const result = brl("20.00").subtract(brl("80.00"));
    expect(result.isNegative()).toBe(true);
    expect(result.toJSON().amount).toBe("-60.00");
    expect(result.negate().toJSON().amount).toBe("60.00");
    expect(brl("0.05").negate().toString()).toBe("-0.05 BRL");
  });

  test("predicados", () => {
    expect(Money.zero("BRL").isZero()).toBe(true);
    expect(brl("0.01").isPositive()).toBe(true);
    expect(brl("0.01").isNegative()).toBe(false);
    expect(brl("10.00").isLessThan(brl("10.01"))).toBe(true);
    expect(brl("10.00").isLessThan(brl("10.00"))).toBe(false);
    expect(brl("10.0").equals(brl("10.00"))).toBe(true);
  });

  test("imutavel: operacoes devolvem nova instancia e a original nao muda", () => {
    const a = brl("10.00");
    const b = a.add(brl("5.00"));
    expect(a.toJSON().amount).toBe("10.00");
    expect(b).not.toBe(a);
    expect(Object.isFrozen(a)).toBe(true);
  });
});

describe("conflito de moeda", () => {
  const usd = Money.from({ amount: "1.00", currency: "USD" });

  test.each([
    ["add", () => brl("1.00").add(usd)],
    ["subtract", () => brl("1.00").subtract(usd)],
    ["isLessThan", () => brl("1.00").isLessThan(usd)],
  ])("%s entre moedas diferentes lanca CurrencyMismatchError", (_name, operation) => {
    expect(operation).toThrow(CurrencyMismatchError);
  });

  test("equals entre moedas diferentes e false, nao erro", () => {
    expect(brl("1.00").equals(usd)).toBe(false);
  });
});
