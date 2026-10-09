import { expect } from "bun:test";
import type { SQL } from "bun";
import { CreateWallet } from "../../src/application/create-wallet";
import { EventFactory } from "../../src/application/event-factory";
import type { AppLogger, Metrics } from "../../src/application/ports";
import { ProcessWagerTransaction, type ProcessContext } from "../../src/application/process-wager-transaction";
import { WalletQueries } from "../../src/application/queries";
import { ReconcileWallet } from "../../src/application/reconcile-wallet";
import type { WagerCommand } from "../../src/application/wager-command";
import { WagerTransactionKind } from "../../src/domain/wagering/wager-transaction";
import { MikroOrmTransactionRunner } from "../../src/infrastructure/persistence/mikro-orm-unit-of-work";
import { SystemClock, UuidV7Generator } from "../../src/infrastructure/system";
import type { TestDatabase } from "./database";

/** Metricas e logs capturados em memoria para os testes conferirem. */
export class RecordingMetrics implements Metrics {
  readonly counters = new Map<string, number>();

  increment(name: string, labels: Record<string, string> = {}, value = 1): void {
    const key = `${name}${JSON.stringify(labels)}`;
    this.counters.set(key, (this.counters.get(key) ?? 0) + value);
  }

  observe(): void {}

  count(name: string, labels: Record<string, string> = {}): number {
    return this.counters.get(`${name}${JSON.stringify(labels)}`) ?? 0;
  }
}

export class RecordingLogger implements AppLogger {
  readonly lines: { level: string; message: string; fields: Record<string, unknown> }[] = [];
  info(message: string, fields: Record<string, unknown> = {}) {
    this.lines.push({ level: "info", message, fields });
  }
  warn(message: string, fields: Record<string, unknown> = {}) {
    this.lines.push({ level: "warn", message, fields });
  }
  error(message: string, fields: Record<string, unknown> = {}) {
    this.lines.push({ level: "error", message, fields });
  }
}

export function buildApplication(db: TestDatabase, options: { lockTimeoutMs?: number } = {}) {
  const clock = new SystemClock();
  const ids = new UuidV7Generator();
  const metrics = new RecordingMetrics();
  const logger = new RecordingLogger();
  const runner = new MikroOrmTransactionRunner(db.orm, clock, { lockTimeoutMs: options.lockTimeoutMs ?? 5_000 });
  const events = new EventFactory(ids, clock);
  return {
    runner,
    metrics,
    logger,
    process: new ProcessWagerTransaction(runner, ids, clock, events, metrics),
    createWallet: new CreateWallet(runner, ids, clock, events),
    queries: new WalletQueries(runner),
    reconcile: new ReconcileWallet(runner, logger, metrics),
  };
}

export type TestApplication = ReturnType<typeof buildApplication>;

export const ctx = (extra: Partial<ProcessContext> = {}): ProcessContext => ({ correlationId: "corr-test", ...extra });

export async function openWallet(app: TestApplication, amount = "100.00", currency = "BRL") {
  return app.createWallet.execute({ playerId: crypto.randomUUID(), initialBalance: { amount, currency } }, ctx());
}

export function command(
  wallet: { id: string; playerId: string },
  kind: WagerTransactionKind | `${WagerTransactionKind}`,
  amount: string,
  overrides: Partial<WagerCommand> = {},
): WagerCommand {
  const externalTransactionId = overrides.externalTransactionId ?? `ext-${crypto.randomUUID()}`;
  const providerId = overrides.providerId ?? "provider-a";
  return {
    providerId,
    externalTransactionId,
    idempotencyKey: `${providerId}:${externalTransactionId}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: "round-1",
    gameId: "fortune-chimp",
    kind: kind as WagerTransactionKind,
    money: { amount, currency: "BRL" },
    ...overrides,
  };
}

/** Invariante final de todo teste: saldo da wallet == saldo reconstruido pelo ledger. */
export async function expectLedgerConsistent(sql: SQL, walletId: string): Promise<string> {
  const [row] = await sql`
    select w.balance::text as stored,
           coalesce(sum(case e.direction when 'CREDIT' then e.amount else -e.amount end), 0)::numeric(20, 2)::text as rebuilt
      from wallets w
      left join wallet_ledger_entries e on e.wallet_id = w.id
     where w.id = ${walletId}
     group by w.balance`;
  expect(row.rebuilt).toBe(row.stored);
  return row.stored;
}
