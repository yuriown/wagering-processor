import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { Money } from "../../src/domain/money";
import { sha256Hex } from "../../src/domain/wagering/payload-hash";
import { type TestDatabase, createTestDatabase, expectAsync } from "../support/database";

/**
 * Cada garantia da secao 6 tem de valer no schema: aqui o SQL e escrito direto,
 * sem passar pelo dominio, tentando violar cada uma delas.
 */
let db: TestDatabase;
let sql: SQL;

beforeAll(async () => {
  db = await createTestDatabase();
  sql = db.sql;
});

afterAll(async () => {
  await db?.drop();
});

const uuid = () => crypto.randomUUID();
const NOW = new Date("2026-07-29T15:00:00.000Z");

interface TxRow {
  id: string;
  provider_id: string;
  external_transaction_id: string;
  idempotency_key: string;
  payload_hash: string;
  wallet_id: string;
  player_id: string;
  round_id: string;
  game_id: string;
  kind: string;
  amount: string;
  currency: string;
  reference_external_transaction_id: string | null;
  reference_transaction_id: string | null;
  status: string;
  failure_code: string | null;
  observed_balance: string | null;
  processed_at: Date | null;
  reference_attempts: number;
  next_reference_check_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface EntryRow {
  id: string;
  wallet_id: string;
  transaction_id: string;
  direction: string;
  amount: string;
  currency: string;
  balance_before: string;
  balance_after: string;
  wallet_version: number;
  created_at: Date;
}

interface Wallet {
  id: string;
  playerId: string;
}

function txRow(wallet: Wallet, overrides: Partial<TxRow> = {}): TxRow {
  const external = overrides.external_transaction_id ?? `ext-${uuid()}`;
  const provider = overrides.provider_id ?? "provider-a";
  const status = overrides.status ?? "PROCESSED";
  const terminal = ["PROCESSED", "REJECTED", "FAILED"].includes(status);
  return {
    id: uuid(),
    provider_id: provider,
    external_transaction_id: external,
    idempotency_key: `${provider}:${external}`,
    payload_hash: sha256Hex(external),
    wallet_id: wallet.id,
    player_id: wallet.playerId,
    round_id: "round-1",
    game_id: "game-1",
    kind: "BET",
    amount: "10.00",
    currency: "BRL",
    reference_external_transaction_id: null,
    reference_transaction_id: null,
    status,
    failure_code: null,
    observed_balance: status === "PROCESSED" ? "0.00" : null,
    processed_at: terminal ? NOW : null,
    reference_attempts: 0,
    next_reference_check_at: status === "PENDING_REFERENCE" ? NOW : null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

async function insertTx(q: SQL, row: TxRow): Promise<void> {
  await q`insert into wager_transactions ${q(row)}`;
}

async function insertEntry(q: SQL, row: EntryRow): Promise<void> {
  await q`insert into wallet_ledger_entries ${q(row)}`;
}

/** Fluxo valido: wallet + OPENING + credito de abertura, num unico commit. */
async function openWallet(balance = "100.00", currency = "BRL"): Promise<Wallet> {
  const wallet = { id: uuid(), playerId: uuid() };
  await sql.begin(async (tx) => {
    await tx`insert into wallets (id, player_id, currency, balance, version, created_at, updated_at)
             values (${wallet.id}, ${wallet.playerId}, ${currency}, ${balance}, 1, ${NOW}, ${NOW})`;
    if (balance !== "0.00") {
      const opening = txRow(wallet, {
        provider_id: "internal",
        external_transaction_id: `opening:${wallet.id}`,
        kind: "OPENING",
        amount: balance,
        currency,
        observed_balance: balance,
      });
      await insertTx(tx, opening);
      await insertEntry(tx, {
        id: uuid(),
        wallet_id: wallet.id,
        transaction_id: opening.id,
        direction: "CREDIT",
        amount: balance,
        currency,
        balance_before: "0.00",
        balance_after: balance,
        wallet_version: 1,
        created_at: NOW,
      });
    }
  });
  return wallet;
}

async function walletState(walletId: string): Promise<{ balance: string; version: number }> {
  const [row] = await sql`select balance::text as balance, version from wallets where id = ${walletId}`;
  return row;
}

/**
 * Movimento valido completo: transacao PROCESSED + lancamento + wallet atualizada.
 * `tamper` permite estragar uma parte para provar que o commit falha.
 */
async function move(
  wallet: Wallet,
  kind: string,
  amount: string,
  options: {
    direction?: "DEBIT" | "CREDIT";
    reference?: TxRow;
    tamper?: { skipEntry?: boolean; skipWalletUpdate?: boolean; walletBalance?: string };
  } = {},
): Promise<TxRow> {
  const direction = options.direction ?? (kind === "BET" ? "DEBIT" : "CREDIT");
  return sql.begin(async (tx) => {
    const [w] = await tx`select balance::text as balance, version from wallets where id = ${wallet.id} for update`;
    const before = Money.from({ amount: w.balance, currency: "BRL" });
    const value = Money.from({ amount, currency: "BRL" });
    const after = (direction === "CREDIT" ? before.add(value) : before.subtract(value)).toJSON().amount;
    const row = txRow(wallet, {
      kind,
      amount,
      observed_balance: after,
      reference_external_transaction_id: options.reference?.external_transaction_id ?? null,
      reference_transaction_id: options.reference?.id ?? null,
    });
    await insertTx(tx, row);
    if (!options.tamper?.skipEntry) {
      await insertEntry(tx, {
        id: uuid(),
        wallet_id: wallet.id,
        transaction_id: row.id,
        direction,
        amount,
        currency: "BRL",
        balance_before: before.toJSON().amount,
        balance_after: after,
        wallet_version: w.version + 1,
        created_at: NOW,
      });
    }
    if (!options.tamper?.skipWalletUpdate) {
      await tx`update wallets set balance = ${options.tamper?.walletBalance ?? after}, version = ${w.version + 1},
               updated_at = ${NOW} where id = ${wallet.id}`;
    }
    return row;
  });
}

async function ledgerSum(walletId: string): Promise<string> {
  const [row] = await sql`
    select coalesce(sum(case direction when 'CREDIT' then amount else -amount end), 0)::numeric(20,2)::text as total
      from wallet_ledger_entries where wallet_id = ${walletId}`;
  return row.total;
}

describe("wallets", () => {
  test("no maximo uma wallet por player + moeda", async () => {
    const wallet = await openWallet("0.00");
    const duplicate = sql`insert into wallets (id, player_id, currency, balance, version, created_at, updated_at)
                          values (${uuid()}, ${wallet.playerId}, 'BRL', 0, 1, ${NOW}, ${NOW})`;
    await expectAsync(duplicate).rejects.toThrow(/wallets_player_currency_key/);
    // Mesma pessoa em outra moeda pode.
    await sql`insert into wallets (id, player_id, currency, balance, version, created_at, updated_at)
              values (${uuid()}, ${wallet.playerId}, 'USD', 0, 1, ${NOW}, ${NOW})`;
  });

  test("saldo negativo recusado pelo banco", async () => {
    const wallet = await openWallet("0.00");
    await expectAsync(sql`update wallets set balance = -0.01 where id = ${wallet.id}`).rejects.toThrow(/wallets_balance_non_negative/);
  });

  test("moeda fora do ISO-4217 recusada", async () => {
    await expectAsync(
      sql`insert into wallets (id, player_id, currency, balance, version, created_at, updated_at)
          values (${uuid()}, ${uuid()}, 'brl', 0, 1, ${NOW}, ${NOW})`,
    ).rejects.toThrow(/wallets_currency_check/);
  });

  test("wallet nao se apaga nem se trunca", async () => {
    const wallet = await openWallet("0.00");
    await expectAsync(sql`delete from wallets where id = ${wallet.id}`).rejects.toThrow(/nao e permitido/);
    await expectAsync(sql`truncate wallets cascade`).rejects.toThrow(/nao e permitido/);
  });
});

describe("wager_transactions", () => {
  test("(provider, externalTransactionId) e unico", async () => {
    const wallet = await openWallet("0.00");
    const row = txRow(wallet, { status: "PENDING" });
    await insertTx(sql, row);
    await expectAsync(insertTx(sql, { ...row, id: uuid(), idempotency_key: "outra" })).rejects.toThrow(
      /wager_transactions_provider_external_key/,
    );
  });

  test("idempotency key e unica por provedor, nao global", async () => {
    const wallet = await openWallet("0.00");
    const row = txRow(wallet, { status: "PENDING", idempotency_key: "chave-compartilhada" });
    await insertTx(sql, row);
    await expectAsync(insertTx(sql, txRow(wallet, { status: "PENDING", idempotency_key: "chave-compartilhada" }))).rejects.toThrow(
      /wager_transactions_provider_idempotency_key/,
    );
    await insertTx(sql, txRow(wallet, { status: "PENDING", provider_id: "provider-b", idempotency_key: "chave-compartilhada" }));
  });

  test.each([
    ["OPENING fora do provider interno", { kind: "OPENING", status: "PENDING" }, /opening_is_internal/],
    ["REFUND sem referencia", { kind: "REFUND", status: "PENDING" }, /reference_required/],
    ["ROLLBACK sem referencia", { kind: "ROLLBACK", status: "PENDING" }, /reference_required/],
    ["BET com referencia", { kind: "BET", status: "PENDING", reference_external_transaction_id: "x" }, /reference_forbidden/],
    ["BET com valor zero", { status: "PENDING", amount: "0.00" }, /wager_transactions_amount_check/],
    ["valor negativo", { status: "PENDING", kind: "LOSS", amount: "-1.00" }, /wager_transactions_amount_check/],
    ["kind desconhecido", { status: "PENDING", kind: "JACKPOT" }, /wager_transactions_kind_check/],
    ["status desconhecido", { status: "DONE", processed_at: null }, /wager_transactions_status_check/],
    ["hash fora do formato", { status: "PENDING", payload_hash: "abc" }, /payload_hash_check/],
    ["REJECTED sem failure_code", { status: "REJECTED" }, /failure_code_iff_failed/],
    ["PENDING com failure_code", { status: "PENDING", failure_code: "INSUFFICIENT_FUNDS" }, /failure_code_iff_failed/],
    ["terminal sem processed_at", { status: "REJECTED", failure_code: "X", processed_at: null }, /processed_at_iff_terminal/],
    ["PROCESSED sem saldo observado", { status: "PROCESSED", kind: "LOSS", observed_balance: null }, /observed_balance_when_processed/],
    ["PENDING_REFERENCE sem agendamento", { status: "PENDING_REFERENCE", kind: "REFUND", reference_external_transaction_id: "b", next_reference_check_at: null }, /next_check_iff_pending_reference/],
  ] as [string, Partial<TxRow>, RegExp][])("recusa %s", async (_label, overrides, constraint) => {
    const wallet = await openWallet("0.00");
    await expectAsync(insertTx(sql, txRow(wallet, overrides))).rejects.toThrow(constraint);
  });

  test("LOSS com valor zero e aceita", async () => {
    const wallet = await openWallet("0.00");
    await insertTx(sql, txRow(wallet, { kind: "LOSS", amount: "0.00", status: "PENDING" }));
  });

  test("estado terminal nao muda mais", async () => {
    const wallet = await openWallet("0.00");
    const row = txRow(wallet, { status: "REJECTED", failure_code: "INSUFFICIENT_FUNDS" });
    await insertTx(sql, row);
    await expectAsync(sql`update wager_transactions set status = 'FAILED' where id = ${row.id}`).rejects.toThrow(/terminal/);
    await expectAsync(sql`update wager_transactions set failure_code = 'OUTRO' where id = ${row.id}`).rejects.toThrow(/terminal/);
  });

  test("campos da operacao sao imutaveis e nada volta para PENDING", async () => {
    const wallet = await openWallet("0.00");
    const row = txRow(wallet, { status: "PENDING_REFERENCE", kind: "REFUND", reference_external_transaction_id: "bet-x" });
    await insertTx(sql, row);
    await expectAsync(sql`update wager_transactions set amount = 99 where id = ${row.id}`).rejects.toThrow(/imutaveis/);
    await expectAsync(sql`update wager_transactions set status = 'PENDING', next_reference_check_at = null where id = ${row.id}`).rejects.toThrow(
      /nao volta para PENDING/,
    );
    await expectAsync(sql`update wager_transactions set reference_attempts = -1 where id = ${row.id}`).rejects.toThrow();
    // Transicao legitima: nova tentativa agendada.
    await sql`update wager_transactions set reference_attempts = 2, next_reference_check_at = ${NOW} where id = ${row.id}`;
  });

  test("transacao nao se apaga", async () => {
    const wallet = await openWallet("0.00");
    const row = txRow(wallet, { status: "PENDING" });
    await insertTx(sql, row);
    await expectAsync(sql`delete from wager_transactions where id = ${row.id}`).rejects.toThrow(/nao e permitido/);
  });

  test("uma referencia so e revertida uma vez, de qualquer tipo", async () => {
    const wallet = await openWallet("100.00");
    const bet = await move(wallet, "BET", "30.00");
    await move(wallet, "REFUND", "30.00", { reference: bet });
    await expectAsync(move(wallet, "ROLLBACK", "30.00", { reference: bet })).rejects.toThrow(/one_reversal_per_reference/);
    await expectAsync(move(wallet, "REFUND", "30.00", { reference: bet })).rejects.toThrow(/one_reversal_per_reference/);
    expect(await walletState(wallet.id)).toEqual({ balance: "100.00", version: 3 });
  });

  test("uma unica OPENING por wallet", async () => {
    const wallet = await openWallet("100.00");
    const second = txRow(wallet, {
      provider_id: "internal",
      external_transaction_id: `opening-2:${wallet.id}`,
      kind: "OPENING",
      status: "PENDING",
    });
    await expectAsync(insertTx(sql, second)).rejects.toThrow(/one_opening_per_wallet/);
  });
});

describe("ledger imutavel e encadeado", () => {
  test("lancamento nao se edita, nao se apaga, nao se trunca", async () => {
    const wallet = await openWallet("100.00");
    const [entry] = await sql`select id from wallet_ledger_entries where wallet_id = ${wallet.id}`;
    await expectAsync(sql`update wallet_ledger_entries set amount = 1 where id = ${entry.id}`).rejects.toThrow(/nao e permitido/);
    await expectAsync(sql`delete from wallet_ledger_entries where id = ${entry.id}`).rejects.toThrow(/nao e permitido/);
    await expectAsync(sql`truncate wallet_ledger_entries`).rejects.toThrow(/nao e permitido/);
  });

  test("aritmetica do lancamento conferida pelo banco", async () => {
    const wallet = await openWallet("0.00");
    const row = txRow(wallet, { kind: "WIN", status: "PENDING" });
    await insertTx(sql, row);
    const entry: EntryRow = {
      id: uuid(),
      wallet_id: wallet.id,
      transaction_id: row.id,
      direction: "CREDIT",
      amount: "10.00",
      currency: "BRL",
      balance_before: "0.00",
      balance_after: "10.01",
      wallet_version: 2,
      created_at: NOW,
    };
    await expectAsync(insertEntry(sql, entry)).rejects.toThrow(/wallet_ledger_entries_balanced/);
    await expectAsync(insertEntry(sql, { ...entry, amount: "0.00", balance_after: "0.00" })).rejects.toThrow(/amount_positive/);
    await expectAsync(
      insertEntry(sql, { ...entry, direction: "DEBIT", balance_after: "-10.00" }),
    ).rejects.toThrow(/balance_after_non_negative/);
  });

  test("lancamento que nao parte do saldo anterior quebra a corrente", async () => {
    const wallet = await openWallet("100.00");
    const row = txRow(wallet, { status: "PENDING" });
    await insertTx(sql, row);
    const base = {
      id: uuid(),
      wallet_id: wallet.id,
      transaction_id: row.id,
      direction: "DEBIT",
      amount: "10.00",
      currency: "BRL",
      created_at: NOW,
    };
    await expectAsync(insertEntry(sql, { ...base, balance_before: "50.00", balance_after: "40.00", wallet_version: 2 })).rejects.toThrow(
      /quebra a corrente/,
    );
    await expectAsync(insertEntry(sql, { ...base, balance_before: "100.00", balance_after: "90.00", wallet_version: 3 })).rejects.toThrow(
      /fora de sequencia/,
    );
  });

  test("versao repetida na mesma wallet e recusada", async () => {
    const wallet = await openWallet("100.00");
    const row = txRow(wallet, { status: "PENDING" });
    await insertTx(sql, row);
    await expectAsync(
      insertEntry(sql, {
        id: uuid(),
        wallet_id: wallet.id,
        transaction_id: row.id,
        direction: "DEBIT",
        amount: "10.00",
        currency: "BRL",
        balance_before: "0.00",
        balance_after: "0.00",
        wallet_version: 1,
        created_at: NOW,
      }),
    ).rejects.toThrow();
  });

  test("lancamento em moeda diferente da wallet e recusado", async () => {
    const wallet = await openWallet("0.00");
    const row = txRow(wallet, { kind: "WIN", currency: "USD", status: "PENDING" });
    await insertTx(sql, row);
    await expectAsync(
      insertEntry(sql, {
        id: uuid(),
        wallet_id: wallet.id,
        transaction_id: row.id,
        direction: "CREDIT",
        amount: "10.00",
        currency: "USD",
        balance_before: "0.00",
        balance_after: "10.00",
        wallet_version: 2,
        created_at: NOW,
      }),
    ).rejects.toThrow(/para wallet/);
  });
});

describe("saldo, ledger e transacao conferidos no commit", () => {
  test("fluxo valido confirma e o ledger reconstroi o saldo", async () => {
    const wallet = await openWallet("100.00");
    const bet = await move(wallet, "BET", "80.00");
    await move(wallet, "WIN", "15.50");
    await move(wallet, "ROLLBACK", "80.00", { reference: bet, direction: "CREDIT" });
    expect(await walletState(wallet.id)).toEqual({ balance: "115.50", version: 4 });
    expect(await ledgerSum(wallet.id)).toBe("115.50");
  });

  test("mudar o saldo sem lancamento: commit falha e nada fica", async () => {
    const wallet = await openWallet("100.00");
    await expectAsync(move(wallet, "BET", "30.00", { tamper: { skipEntry: true } })).rejects.toThrow(/sem lancamento|diverge do ledger/);
    expect(await walletState(wallet.id)).toEqual({ balance: "100.00", version: 1 });
    const [{ count }] = await sql`select count(*)::int as count from wager_transactions where wallet_id = ${wallet.id}`;
    expect(count).toBe(1); // so a OPENING
  });

  test("lancamento sem mudar o saldo: commit falha", async () => {
    const wallet = await openWallet("100.00");
    await expectAsync(move(wallet, "BET", "30.00", { tamper: { skipWalletUpdate: true } })).rejects.toThrow(/diverge do ledger/);
    expect(await ledgerSum(wallet.id)).toBe("100.00");
  });

  test("saldo da wallet diferente do balance_after: commit falha", async () => {
    const wallet = await openWallet("100.00");
    await expectAsync(move(wallet, "BET", "30.00", { tamper: { walletBalance: "75.00" } })).rejects.toThrow(/diverge do ledger/);
  });

  test("direcao incoerente com o tipo: commit falha", async () => {
    const wallet = await openWallet("100.00");
    // Conta coerente com DEBIT, mas WIN tem de ser credito: so o trigger de direcao pega.
    await expectAsync(move(wallet, "WIN", "30.00", { direction: "DEBIT" })).rejects.toThrow(/exige CREDIT/);
    const bet = await move(wallet, "BET", "30.00");
    // ROLLBACK de BET tem de ser credito.
    await expectAsync(move(wallet, "ROLLBACK", "30.00", { reference: bet, direction: "DEBIT" })).rejects.toThrow(/exige CREDIT/);
  });

  test("LOSS nao pode ter lancamento", async () => {
    const wallet = await openWallet("100.00");
    await expectAsync(move(wallet, "LOSS", "30.00", { direction: "DEBIT" })).rejects.toThrow(/nao corresponde/);
  });

  test("transacao PROCESSED que move saldo sem lancamento: commit falha", async () => {
    const wallet = await openWallet("100.00");
    await expectAsync(insertTx(sql, txRow(wallet, { kind: "WIN", observed_balance: "100.00" }))).rejects.toThrow(/sem lancamento/);
  });

  test("LOSS PROCESSED sem lancamento e valida", async () => {
    const wallet = await openWallet("100.00");
    await insertTx(sql, txRow(wallet, { kind: "LOSS", observed_balance: "100.00" }));
  });

  test("wallet aberta com saldo sem credito de abertura: commit falha", async () => {
    await expectAsync(
      sql`insert into wallets (id, player_id, currency, balance, version, created_at, updated_at)
          values (${uuid()}, ${uuid()}, 'BRL', 50, 1, ${NOW}, ${NOW})`,
    ).rejects.toThrow(/sem lancamento/);
  });
});

describe("inbox e outbox", () => {
  test("inbox: (consumer, messageId) e unico; mesmo id em outro consumidor pode", async () => {
    const row = { consumer_name: "wager-consumer", message_id: "msg-1", payload_hash: sha256Hex("m"), received_at: NOW };
    await sql`insert into inbox_messages ${sql(row)}`;
    await expectAsync(sql`insert into inbox_messages ${sql(row)}`).rejects.toThrow(/inbox_messages_pkey/);
    await sql`insert into inbox_messages ${sql({ ...row, consumer_name: "outro-consumer" })}`;
  });

  const outbox = () => {
    const id = uuid();
    return {
      id,
      aggregate_id: uuid(),
      event_type: "WalletBalanceChanged",
      payload: { eventId: id, eventType: "WalletBalanceChanged", data: { amount: "1.00" } },
      occurred_at: NOW,
    };
  };

  test("outbox: payload tem de ser o envelope do proprio evento", async () => {
    const row = outbox();
    await expectAsync(sql`insert into outbox_messages ${sql({ ...row, payload: { ...row.payload, eventId: uuid() } })}`).rejects.toThrow(
      /outbox_messages_payload_event_id/,
    );
    await sql`insert into outbox_messages ${sql(row)}`;
  });

  test("outbox: conteudo imutavel; depois de publicado nada muda", async () => {
    const row = outbox();
    await sql`insert into outbox_messages ${sql(row)}`;
    await expectAsync(sql`update outbox_messages set event_type = 'Outro' where id = ${row.id}`).rejects.toThrow(/imutavel/);
    await sql`update outbox_messages set attempts = 1, next_attempt_at = ${NOW} where id = ${row.id}`;
    await sql`update outbox_messages set published_at = ${NOW} where id = ${row.id}`;
    await expectAsync(sql`update outbox_messages set published_at = null where id = ${row.id}`).rejects.toThrow(/ja publicado/);
  });

  test("outbox: lease tem dono e prazo juntos", async () => {
    const row = outbox();
    await sql`insert into outbox_messages ${sql(row)}`;
    await expectAsync(sql`update outbox_messages set locked_by = 'instancia-1' where id = ${row.id}`).rejects.toThrow(/lease_check/);
  });
});

describe("migrations reversiveis", () => {
  test("down total remove tudo e up recria; o historico fica coerente", async () => {
    const fresh = await createTestDatabase({ migrate: false });
    try {
      const objects = async () => {
        const [row] = await fresh.sql`
          select
            (select count(*)::int from pg_tables where schemaname = 'public' and tablename <> 'schema_migrations') as tables,
            (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public') as functions`;
        return row;
      };
      expect(await objects()).toEqual({ tables: 0, functions: 0 });

      const up = await fresh.orm.migrator.up();
      expect(up.length).toBe(4);
      expect(await objects()).toEqual({ tables: 5, functions: 8 });

      const down = await fresh.orm.migrator.down({ to: 0 });
      expect(down.length).toBe(4);
      expect(await objects()).toEqual({ tables: 0, functions: 0 });

      expect((await fresh.orm.migrator.up()).length).toBe(4);
      expect(await fresh.orm.migrator.getPending()).toEqual([]);
    } finally {
      await fresh.drop();
    }
  });
});
