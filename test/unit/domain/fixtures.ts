import { Money } from "../../../src/domain/money";
import { wagerPayloadHash } from "../../../src/domain/wagering/payload-hash";
import {
  type CreateWagerTransactionProps,
  WagerTransaction,
  WagerTransactionKind,
} from "../../../src/domain/wagering/wager-transaction";
import { Wallet } from "../../../src/domain/wallet/wallet";

export const T0 = new Date("2026-07-29T15:00:00.000Z");
export const PLAYER = "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1";
export const WALLET = "0192f291-27dd-7d3f-8071-5f8685deef37";

let sequence = 0;
export function nextId(prefix = "id"): string {
  sequence += 1;
  return `${prefix}-${sequence}`;
}

export function brl(amount: string): Money {
  return Money.from({ amount, currency: "BRL" });
}

export function openWallet(initial = "100.00", props: { id?: string; playerId?: string; currency?: string } = {}): Wallet {
  return Wallet.open({
    id: props.id ?? WALLET,
    playerId: props.playerId ?? PLAYER,
    initialBalance: Money.from({ amount: initial, currency: props.currency ?? "BRL" }),
    openingTransactionId: nextId("opening"),
    openingEntryId: nextId("entry"),
    at: T0,
  }).wallet;
}

export type TxOverrides = Partial<Omit<CreateWagerTransactionProps, "money">> & { amount?: string; currency?: string };

export function wagerTx(kind: WagerTransactionKind, overrides: TxOverrides = {}): WagerTransaction {
  const externalTransactionId = overrides.externalTransactionId ?? nextId("ext");
  const providerId = overrides.providerId ?? "provider-a";
  const money = Money.from({ amount: overrides.amount ?? "25.00", currency: overrides.currency ?? "BRL" });
  const base = {
    providerId,
    externalTransactionId,
    playerId: overrides.playerId ?? PLAYER,
    walletId: overrides.walletId ?? WALLET,
    roundId: overrides.roundId ?? "round-987",
    gameId: overrides.gameId ?? "fortune-chimp",
    kind,
    referenceExternalTransactionId: overrides.referenceExternalTransactionId,
  };
  return WagerTransaction.create({
    ...base,
    id: overrides.id ?? nextId("tx"),
    idempotencyKey: overrides.idempotencyKey ?? `${providerId}:${externalTransactionId}`,
    payloadHash: overrides.payloadHash ?? wagerPayloadHash({ ...base, money: money.toJSON() }),
    money,
    createdAt: overrides.createdAt ?? T0,
  });
}

export const Kind = WagerTransactionKind;
