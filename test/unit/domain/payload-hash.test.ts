import { describe, expect, test } from "bun:test";
import { InvalidMoneyError } from "../../../src/domain/money";
import { type WagerPayload, canonicalJson, sha256Hex, wagerPayloadHash } from "../../../src/domain/wagering/payload-hash";

const payload: WagerPayload = {
  providerId: "provider-a",
  externalTransactionId: "transaction-123",
  playerId: "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  walletId: "0192f291-27dd-7d3f-8071-5f8685deef37",
  roundId: "round-987",
  gameId: "fortune-chimp",
  kind: "BET",
  money: { amount: "25.00", currency: "BRL" },
};

describe("canonicalJson", () => {
  test("ordena chaves recursivamente e omite undefined", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: undefined } })).toBe('{"a":{"d":[3,{"y":2,"z":1}]},"b":1}');
  });

  test("independe da ordem de insercao das chaves", () => {
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });
});

describe("wagerPayloadHash", () => {
  test("e SHA-256 hex do JSON canonico (algoritmo documentado e reproduzivel)", () => {
    const expected = sha256Hex(
      '{"externalTransactionId":"transaction-123","gameId":"fortune-chimp","kind":"BET",' +
        '"money":{"amount":"25.00","currency":"BRL"},"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",' +
        '"providerId":"provider-a","roundId":"round-987","walletId":"0192f291-27dd-7d3f-8071-5f8685deef37"}',
    );
    expect(wagerPayloadHash(payload)).toBe(expected);
    expect(expected).toMatch(/^[0-9a-f]{64}$/);
  });

  test("mesma operacao com chaves em outra ordem ou valor com outra escala: mesmo hash", () => {
    const reordered = Object.fromEntries(Object.entries(payload).reverse()) as unknown as WagerPayload;
    expect(wagerPayloadHash(reordered)).toBe(wagerPayloadHash(payload));
    expect(wagerPayloadHash({ ...payload, money: { amount: "25", currency: "BRL" } })).toBe(wagerPayloadHash(payload));
  });

  test("campos de transporte nao entram: objeto com campo extra gera o mesmo hash", () => {
    const withTransport = { ...payload, idempotencyKey: "x", messageId: "msg-1" } as WagerPayload;
    expect(wagerPayloadHash(withTransport)).toBe(wagerPayloadHash(payload));
  });

  test.each([
    ["valor", { money: { amount: "25.01", currency: "BRL" } }],
    ["moeda", { money: { amount: "25.00", currency: "USD" } }],
    ["kind", { kind: "WIN" }],
    ["rodada", { roundId: "round-988" }],
    ["referencia", { referenceExternalTransactionId: "bet-1" }],
  ])("%s diferente: hash diferente (mesma key vira conflito, nao replay)", (_label, change) => {
    expect(wagerPayloadHash({ ...payload, ...change })).not.toBe(wagerPayloadHash(payload));
  });

  test("valor invalido nao gera hash", () => {
    expect(() => wagerPayloadHash({ ...payload, money: { amount: "1e3", currency: "BRL" } })).toThrow(InvalidMoneyError);
  });
});
