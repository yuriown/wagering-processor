import { describe, expect, test } from "bun:test";
import { WalletBalanceChanged } from "../../../src/domain/events/wallet-balance-changed";
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
} from "../../../src/domain/events/wager-transaction-events";
import { InboxMessage } from "../../../src/domain/messaging/inbox-message";
import { OutboxMessage } from "../../../src/domain/messaging/outbox-message";
import { InvariantViolationError } from "../../../src/domain/shared/domain-error";
import { LedgerDirection } from "../../../src/domain/wallet/ledger-direction";
import { FailureCode } from "../../../src/domain/wagering/failure-code";
import { settleWagerTransaction } from "../../../src/domain/wagering/wager-settlement";
import { Kind, T0, WALLET, brl, openWallet, wagerTx } from "./fixtures";

const ctx = { eventId: "evt-1", correlationId: "corr-1", causationId: "msg-1", occurredAt: T0 };

describe("eventos de integracao", () => {
  test("WalletBalanceChanged: envelope JSON estavel com MoneyProps, nunca Money", () => {
    const wallet = openWallet("100.00");
    const entry = wallet.debit({ entryId: "e1", transactionId: "t1", money: brl("25.00"), at: T0 });
    const json = WalletBalanceChanged.from(wallet, entry, ctx).toJSON();
    expect(json).toEqual({
      eventId: "evt-1",
      eventType: "WalletBalanceChanged",
      aggregateId: WALLET,
      correlationId: "corr-1",
      causationId: "msg-1",
      occurredAt: "2026-07-29T15:00:00.000Z",
      version: 1,
      data: {
        walletId: WALLET,
        transactionId: "t1",
        direction: LedgerDirection.Debit,
        money: { amount: "25.00", currency: "BRL" },
        balanceBefore: { amount: "100.00", currency: "BRL" },
        balanceAfter: { amount: "75.00", currency: "BRL" },
        walletVersion: 2,
      },
    });
    // Ida e volta por JSON sem perda: o payload da outbox e so dado.
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
  });

  test("causationId ausente nao aparece no envelope", () => {
    const wallet = openWallet("100.00");
    const entry = wallet.credit({ entryId: "e1", transactionId: "t1", money: brl("1.00"), at: T0 });
    const json = WalletBalanceChanged.from(wallet, entry, { eventId: "e", correlationId: "c", occurredAt: T0 }).toJSON();
    expect("causationId" in json).toBe(false);
  });

  test("WagerTransactionProcessed (inclusive LOSS), Rejected e PendingReference", () => {
    const wallet = openWallet("10.00");

    const loss = wagerTx(Kind.Loss);
    settleWagerTransaction({ transaction: loss, wallet, reference: undefined, referenceAlreadyReversed: false, entryId: "x", at: T0 });
    const processed = WagerTransactionProcessed.from(loss, ctx).toJSON();
    expect(processed.eventType).toBe("WagerTransactionProcessed");
    expect(processed.data.kind).toBe("LOSS");
    expect(processed.data.balance).toEqual({ amount: "10.00", currency: "BRL" });

    const bet = wagerTx(Kind.Bet, { amount: "50.00" });
    settleWagerTransaction({ transaction: bet, wallet, reference: undefined, referenceAlreadyReversed: false, entryId: "y", at: T0 });
    const rejected = WagerTransactionRejected.from(bet, ctx).toJSON();
    expect(rejected.data.failureCode).toBe(FailureCode.InsufficientFunds);

    const refund = wagerTx(Kind.Refund, { referenceExternalTransactionId: "bet-x" });
    settleWagerTransaction({ transaction: refund, wallet, reference: undefined, referenceAlreadyReversed: false, entryId: "z", at: T0 });
    const pending = WagerTransactionPendingReference.from(refund, ctx).toJSON();
    expect(pending.data.referenceExternalTransactionId).toBe("bet-x");
    expect(pending.data.attempts).toBe(1);
  });

  test("evento exige o status correspondente", () => {
    expect(() => WagerTransactionProcessed.from(wagerTx(Kind.Bet), ctx)).toThrow(InvariantViolationError);
    expect(() => WagerTransactionRejected.from(wagerTx(Kind.Bet), ctx)).toThrow(InvariantViolationError);
  });

  test("data e congelado", () => {
    const wallet = openWallet("100.00");
    const entry = wallet.credit({ entryId: "e1", transactionId: "t1", money: brl("1.00"), at: T0 });
    expect(Object.isFrozen(WalletBalanceChanged.from(wallet, entry, ctx).data)).toBe(true);
  });
});

describe("OutboxMessage", () => {
  function message(): OutboxMessage {
    const wallet = openWallet("100.00");
    const entry = wallet.credit({ entryId: "e1", transactionId: "t1", money: brl("1.00"), at: T0 });
    return OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, entry, ctx));
  }

  test("enqueue usa o eventId como id e guarda o envelope serializado", () => {
    const msg = message();
    expect(msg.id).toBe("evt-1");
    expect(msg.eventType).toBe("WalletBalanceChanged");
    expect(msg.aggregateId).toBe(WALLET);
    expect(msg.payload.eventId).toBe("evt-1");
    expect(msg.isPending()).toBe(true);
    expect(msg.isDue(T0)).toBe(true);
    expect(msg.attempts).toBe(0);
  });

  test("scheduleRetry incrementa attempts e adia com backoff", () => {
    const msg = message();
    msg.scheduleRetry(T0, { baseMs: 1_000, maxMs: 4_000 });
    expect(msg.attempts).toBe(1);
    expect(msg.isDue(T0)).toBe(false);
    expect(msg.isDue(new Date(T0.getTime() + 1_000))).toBe(true);
    msg.scheduleRetry(T0, { baseMs: 1_000, maxMs: 4_000 });
    msg.scheduleRetry(T0, { baseMs: 1_000, maxMs: 4_000 });
    msg.scheduleRetry(T0, { baseMs: 1_000, maxMs: 4_000 });
    expect(msg.nextAttemptAt?.getTime()).toBe(T0.getTime() + 4_000);
  });

  test("publicado deixa de estar pendente; publicar de novo e erro de programacao", () => {
    const msg = message();
    msg.markPublished(T0);
    expect(msg.isPending()).toBe(false);
    expect(msg.isDue(T0)).toBe(false);
    expect(msg.publishedAt).toEqual(T0);
    expect(() => msg.markPublished(T0)).toThrow(InvariantViolationError);
    expect(() => msg.scheduleRetry(T0)).toThrow(InvariantViolationError);
  });
});

describe("InboxMessage", () => {
  test("recebe, compara payload e marca processada uma vez", () => {
    const inbox = InboxMessage.receive({ messageId: "msg-1", consumerName: "wager-consumer", payloadHash: "h1", receivedAt: T0 });
    expect(inbox.isProcessed()).toBe(false);
    expect(inbox.matchesPayload("h1")).toBe(true);
    expect(inbox.matchesPayload("h2")).toBe(false);
    inbox.markProcessed(T0);
    expect(inbox.isProcessed()).toBe(true);
    expect(() => inbox.markProcessed(T0)).toThrow(InvariantViolationError);
  });

  test("messageId vazio e recusado", () => {
    expect(() => InboxMessage.receive({ messageId: "", consumerName: "c", payloadHash: "h", receivedAt: T0 })).toThrow();
  });
});
