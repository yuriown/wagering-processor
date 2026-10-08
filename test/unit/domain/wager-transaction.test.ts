import { describe, expect, test } from "bun:test";
import { FailureCode } from "../../../src/domain/wagering/failure-code";
import {
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
  WagerTransaction,
  WagerTransactionStatus,
} from "../../../src/domain/wagering/wager-transaction";
import { LedgerDirection } from "../../../src/domain/wallet/ledger-direction";
import { Kind, T0, WALLET, PLAYER, brl, wagerTx } from "./fixtures";

const POLICY = { baseMs: 1_000, maxMs: 8_000 };

describe("WagerTransaction.create", () => {
  test("nasce PENDING, sem referencia interna, sem falha", () => {
    const tx = wagerTx(Kind.Bet);
    expect(tx.status).toBe(WagerTransactionStatus.Pending);
    expect(tx.isTerminal()).toBe(false);
    expect(tx.referenceTransactionId).toBeUndefined();
    expect(tx.failureCode).toBeUndefined();
    expect(tx.processedAt).toBeUndefined();
  });

  test("OPENING nao pode ser submetido", () => {
    expect(() => wagerTx(Kind.Opening)).toThrow(InvalidWagerTransactionError);
  });

  test.each([Kind.Refund, Kind.Rollback])("%s exige referenceExternalTransactionId", (kind) => {
    expect(() => wagerTx(kind)).toThrow(InvalidWagerTransactionError);
    expect(wagerTx(kind, { referenceExternalTransactionId: "bet-1" }).requiresReference()).toBe(true);
  });

  test("BET nao aceita referencia; WIN e LOSS aceitam opcionalmente", () => {
    expect(() => wagerTx(Kind.Bet, { referenceExternalTransactionId: "x" })).toThrow(InvalidWagerTransactionError);
    expect(wagerTx(Kind.Win).referenceExternalTransactionId).toBeUndefined();
    expect(wagerTx(Kind.Win, { referenceExternalTransactionId: "bet-1" }).referenceExternalTransactionId).toBe("bet-1");
    expect(wagerTx(Kind.Loss, { referenceExternalTransactionId: "bet-1" }).requiresReference()).toBe(false);
  });

  test("nao referencia a si mesma", () => {
    expect(() =>
      wagerTx(Kind.Refund, { externalTransactionId: "same", referenceExternalTransactionId: "same" }),
    ).toThrow(InvalidWagerTransactionError);
  });

  test("valor: zero so em LOSS", () => {
    expect(() => wagerTx(Kind.Bet, { amount: "0.00" })).toThrow(InvalidWagerTransactionError);
    expect(() => wagerTx(Kind.Win, { amount: "0" })).toThrow(InvalidWagerTransactionError);
    expect(wagerTx(Kind.Loss, { amount: "0.00" }).money.isZero()).toBe(true);
  });

  test.each(["providerId", "externalTransactionId", "idempotencyKey", "walletId", "playerId", "roundId", "gameId"])(
    "%s vazio e recusado",
    (field) => {
      expect(() => wagerTx(Kind.Bet, { [field]: "  " })).toThrow(InvalidWagerTransactionError);
    },
  );
});

describe("transicoes", () => {
  test("PENDING -> PROCESSED guarda referencia, saldo observado e horario", () => {
    const tx = wagerTx(Kind.Bet);
    tx.markProcessed({ referenceTransactionId: undefined, observedBalance: brl("75.00"), at: T0 });
    expect(tx.status).toBe(WagerTransactionStatus.Processed);
    expect(tx.observedBalance?.toJSON().amount).toBe("75.00");
    expect(tx.processedAt).toEqual(T0);
    expect(tx.isTerminal()).toBe(true);
  });

  test("PENDING -> PENDING_REFERENCE agenda com backoff exponencial, e pode repetir", () => {
    const tx = wagerTx(Kind.Refund, { referenceExternalTransactionId: "bet-1" });
    tx.markPendingReference(T0, POLICY);
    expect(tx.status).toBe(WagerTransactionStatus.PendingReference);
    expect(tx.referenceAttempts).toBe(1);
    expect(tx.nextReferenceCheckAt?.getTime()).toBe(T0.getTime() + 1_000);
    tx.markPendingReference(T0, POLICY);
    tx.markPendingReference(T0, POLICY);
    expect(tx.nextReferenceCheckAt?.getTime()).toBe(T0.getTime() + 4_000);
    tx.markPendingReference(T0, POLICY);
    tx.markPendingReference(T0, POLICY);
    expect(tx.nextReferenceCheckAt?.getTime()).toBe(T0.getTime() + 8_000); // teto
    expect(tx.referenceRetriesExhausted(5)).toBe(true);
    expect(tx.referenceRetriesExhausted(6)).toBe(false);
  });

  test("PENDING_REFERENCE -> PROCESSED limpa o agendamento", () => {
    const tx = wagerTx(Kind.Refund, { referenceExternalTransactionId: "bet-1" });
    tx.markPendingReference(T0, POLICY);
    tx.markProcessed({ referenceTransactionId: "tx-bet", observedBalance: brl("100.00"), at: T0 });
    expect(tx.referenceTransactionId).toBe("tx-bet");
    expect(tx.nextReferenceCheckAt).toBeUndefined();
  });

  test("REJECTED e FAILED carregam failureCode", () => {
    const rejected = wagerTx(Kind.Bet);
    rejected.reject(FailureCode.InsufficientFunds, brl("10.00"), T0);
    expect(rejected.status).toBe(WagerTransactionStatus.Rejected);
    expect(rejected.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(rejected.observedBalance?.toJSON().amount).toBe("10.00");

    const failed = wagerTx(Kind.Bet);
    failed.fail(FailureCode.ProcessingFailed, T0);
    expect(failed.status).toBe(WagerTransactionStatus.Failed);
    expect(failed.isTerminal()).toBe(true);
  });

  const terminals: [string, (tx: WagerTransaction) => void][] = [
    ["PROCESSED", (tx) => tx.markProcessed({ referenceTransactionId: undefined, observedBalance: brl("1.00"), at: T0 })],
    ["REJECTED", (tx) => tx.reject(FailureCode.InsufficientFunds, undefined, T0)],
    ["FAILED", (tx) => tx.fail(FailureCode.ProcessingFailed, T0)],
  ];
  const transitions: [string, (tx: WagerTransaction) => void][] = [
    ...terminals,
    ["PENDING_REFERENCE", (tx) => tx.markPendingReference(T0, POLICY)],
  ];

  for (const [from, toTerminal] of terminals) {
    for (const [to, transition] of transitions) {
      test(`${from} e terminal: ir para ${to} lanca InvalidTransactionStateError`, () => {
        const tx = wagerTx(Kind.Win, { referenceExternalTransactionId: "bet-1" });
        toTerminal(tx);
        const snapshot = { status: tx.status, failureCode: tx.failureCode, processedAt: tx.processedAt };
        expect(() => transition(tx)).toThrow(InvalidTransactionStateError);
        expect({ status: tx.status, failureCode: tx.failureCode, processedAt: tx.processedAt }).toEqual(snapshot);
      });
    }
  }
});

describe("consultas de dominio", () => {
  test("affectsBalance e false so para LOSS", () => {
    expect(wagerTx(Kind.Loss).affectsBalance()).toBe(false);
    for (const kind of [Kind.Bet, Kind.Win]) expect(wagerTx(kind).affectsBalance()).toBe(true);
    for (const kind of [Kind.Refund, Kind.Rollback]) {
      expect(wagerTx(kind, { referenceExternalTransactionId: "r" }).affectsBalance()).toBe(true);
    }
  });

  test("direcao do lancamento por tipo; ROLLBACK inverte a referencia", () => {
    const bet = wagerTx(Kind.Bet);
    const win = wagerTx(Kind.Win);
    const refund = wagerTx(Kind.Refund, { referenceExternalTransactionId: "r" });
    const rollback = wagerTx(Kind.Rollback, { referenceExternalTransactionId: "r" });
    expect(bet.ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(win.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(refund.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
    expect(rollback.ledgerDirectionFor(refund)).toBe(LedgerDirection.Debit);
    expect(() => rollback.ledgerDirectionFor()).toThrow();
    expect(() => wagerTx(Kind.Loss).ledgerDirectionFor()).toThrow();
  });

  test("matrizes de referencia: REFUND so BET; ROLLBACK BET, WIN ou REFUND", () => {
    const bet = wagerTx(Kind.Bet);
    const win = wagerTx(Kind.Win);
    const loss = wagerTx(Kind.Loss);
    const refund = wagerTx(Kind.Refund, { referenceExternalTransactionId: "r" });
    const rollback = wagerTx(Kind.Rollback, { referenceExternalTransactionId: "r" });
    expect([bet, win, loss, refund, rollback].map((t) => t.canBeReferencedBy(Kind.Refund))).toEqual([
      true, false, false, false, false,
    ]);
    expect([bet, win, loss, refund, rollback].map((t) => t.canBeReferencedBy(Kind.Rollback))).toEqual([
      true, true, false, true, false,
    ]);
  });

  test("matchesPayload compara o hash", () => {
    const tx = wagerTx(Kind.Bet, { payloadHash: "a".repeat(64) });
    expect(tx.matchesPayload("a".repeat(64))).toBe(true);
    expect(tx.matchesPayload("b".repeat(64))).toBe(false);
  });
});

describe("OPENING", () => {
  test("nasce PROCESSED, interna, com saldo observado igual ao inicial", () => {
    const tx = WagerTransaction.opening({ id: "o1", walletId: WALLET, playerId: PLAYER, money: brl("1000.00"), at: T0 });
    expect(tx.kind).toBe(Kind.Opening);
    expect(tx.status).toBe(WagerTransactionStatus.Processed);
    expect(tx.providerId).toBe("internal");
    expect(tx.externalTransactionId).toBe(`opening:${WALLET}`);
    expect(tx.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(tx.observedBalance?.equals(brl("1000.00"))).toBe(true);
  });

  test("nao existe OPENING de valor zero", () => {
    expect(() =>
      WagerTransaction.opening({ id: "o1", walletId: WALLET, playerId: PLAYER, money: brl("0.00"), at: T0 }),
    ).toThrow();
  });
});

describe("rehydrate", () => {
  test("reconstroi estado terminal sem revalidar transicoes", () => {
    const tx = WagerTransaction.rehydrate({
      id: "t1",
      providerId: "provider-a",
      externalTransactionId: "ext-1",
      idempotencyKey: "provider-a:ext-1",
      payloadHash: "h",
      walletId: WALLET,
      playerId: PLAYER,
      roundId: "r",
      gameId: "g",
      kind: Kind.Refund,
      money: brl("25.00"),
      referenceExternalTransactionId: "bet-1",
      createdAt: T0,
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.ReferenceNotFound,
      processedAt: T0,
      observedBalance: brl("100.00"),
      referenceAttempts: 8,
    });
    expect(tx.status).toBe(WagerTransactionStatus.Rejected);
    expect(tx.failureCode).toBe(FailureCode.ReferenceNotFound);
    expect(tx.referenceAttempts).toBe(8);
    expect(() => tx.markProcessed({ referenceTransactionId: undefined, observedBalance: brl("1.00"), at: T0 })).toThrow(
      InvalidTransactionStateError,
    );
  });
});
