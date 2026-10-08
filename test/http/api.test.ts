import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import { loadConfig } from "../../src/config";
import { createHttpApp } from "../../src/http-app";
import { type TestDatabase, createTestDatabase } from "../support/database";

/** API HTTP de ponta a ponta: Nest + MikroORM + Postgres real + SQS real (readiness). */
let db: TestDatabase;
let app: INestApplication;
let base: string;

beforeAll(async () => {
  db = await createTestDatabase();
  app = await createHttpApp({ ...loadConfig(), databaseUrl: db.url }, { logger: false });
  await app.listen(0, "127.0.0.1");
  base = (await app.getUrl()).replace("[::1]", "127.0.0.1");
});

afterAll(async () => {
  await app?.close();
  await db?.drop();
});

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : undefined };
}

async function createWallet(amount = "100.00") {
  const playerId = crypto.randomUUID();
  const { status, body } = await call("POST", "/wallets", { playerId, initialBalance: { amount, currency: "BRL" } });
  expect(status).toBe(201);
  return body as { id: string; playerId: string };
}

function wager(wallet: { id: string; playerId: string }, kind: string, amount: string, extra: Record<string, unknown> = {}) {
  const externalTransactionId = (extra.externalTransactionId as string | undefined) ?? `tx-${crypto.randomUUID()}`;
  return {
    body: {
      providerId: "provider-a",
      externalTransactionId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: "round-987",
      gameId: "fortune-chimp",
      kind,
      money: { amount, currency: "BRL" },
      ...extra,
    },
    key: `provider-a:${externalTransactionId}`,
  };
}

const submit = (w: { body: unknown; key: string }, key = w.key) =>
  call("POST", "/wagering/transactions", w.body, { "Idempotency-Key": key });

describe("health", () => {
  test("live e ready sem autenticacao", async () => {
    expect(await call("GET", "/health/live")).toMatchObject({ status: 200, body: { status: "ok" } });
    expect(await call("GET", "/health/ready")).toMatchObject({
      status: 200,
      body: { status: "ok", checks: { postgres: "up", sqs: "up" } },
    });
  });
});

describe("wallets", () => {
  test("POST /wallets devolve o contrato do enunciado", async () => {
    const playerId = crypto.randomUUID();
    const { status, body } = await call("POST", "/wallets", { playerId, initialBalance: { amount: "1000.00", currency: "BRL" } });
    expect(status).toBe(201);
    expect(body).toEqual({ id: expect.any(String), playerId, balance: { amount: "1000.00", currency: "BRL" }, version: 1 });
    expect((await call("GET", `/wallets/${body.id}`)).body).toEqual(body);
  });

  test("duplicada: 409 WALLET_ALREADY_EXISTS", async () => {
    const wallet = await createWallet();
    const { status, body } = await call("POST", "/wallets", {
      playerId: wallet.playerId,
      initialBalance: { amount: "1.00", currency: "BRL" },
    });
    expect(status).toBe(409);
    expect(body.error.code).toBe("WALLET_ALREADY_EXISTS");
  });

  test.each([
    [{ playerId: "p", initialBalance: { amount: 10, currency: "BRL" } }],
    [{ playerId: "p", initialBalance: { amount: "-1.00", currency: "BRL" } }],
    [{ playerId: "", initialBalance: { amount: "1.00", currency: "BRL" } }],
    [{ playerId: "p", initialBalance: { amount: "1.00", currency: "real" } }],
  ])("payload invalido: 400 VALIDATION_FAILED (%j)", async (payload) => {
    const { status, body } = await call("POST", "/wallets", payload);
    expect(status).toBe(400);
    expect(body.error.code).toBe("VALIDATION_FAILED");
  });

  test("id que nao e UUID: 400; inexistente: 404", async () => {
    expect((await call("GET", "/wallets/abc")).status).toBe(400);
    const missing = await call("GET", "/wallets/0192f291-27dd-7d3f-8071-5f8685deef37");
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe("WALLET_NOT_FOUND");
  });
});

describe("POST /wagering/transactions: um status por situacao", () => {
  test("201 processada, 200 replay com o mesmo corpo", async () => {
    const wallet = await createWallet("1000.00");
    const bet = wager(wallet, "BET", "25.00");
    const first = await submit(bet);
    expect(first.status).toBe(201);
    expect(first.body).toEqual({
      transactionId: expect.any(String),
      status: "PROCESSED",
      balance: { amount: "975.00", currency: "BRL" },
      idempotentReplay: false,
    });
    const replay = await submit(bet);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
  });

  test("409 IDEMPOTENCY_CONFLICT: mesma key, payload diferente", async () => {
    const wallet = await createWallet();
    const bet = wager(wallet, "BET", "25.00");
    await submit(bet);
    const conflict = await submit({ ...bet, body: { ...bet.body, money: { amount: "26.00", currency: "BRL" } } });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  test("422 rejeicao de negocio, com failureCode e saldo; o replay tambem e 422", async () => {
    const wallet = await createWallet("10.00");
    const bet = wager(wallet, "BET", "25.00");
    const rejected = await submit(bet);
    expect(rejected.status).toBe(422);
    expect(rejected.body).toMatchObject({ status: "REJECTED", failureCode: "INSUFFICIENT_FUNDS", idempotentReplay: false });
    const replay = await submit(bet);
    expect(replay.status).toBe(422);
    expect(replay.body.idempotentReplay).toBe(true);
  });

  test("202 aceita aguardando referencia", async () => {
    const wallet = await createWallet();
    const refund = await submit(wager(wallet, "REFUND", "5.00", { referenceExternalTransactionId: "ainda-nao" }));
    expect(refund.status).toBe(202);
    expect(refund.body).toMatchObject({ status: "PENDING_REFERENCE", idempotentReplay: false });
  });

  test.each([
    ["sem Idempotency-Key", (w: ReturnType<typeof wager>) => call("POST", "/wagering/transactions", w.body)],
    ["OPENING pela API", (w: ReturnType<typeof wager>) => submit({ ...w, body: { ...w.body, kind: "OPENING" } })],
    ["valor em notacao cientifica", (w: ReturnType<typeof wager>) => submit({ ...w, body: { ...w.body, money: { amount: "1e2", currency: "BRL" } } })],
    ["valor como number", (w: ReturnType<typeof wager>) => submit({ ...w, body: { ...w.body, money: { amount: 25, currency: "BRL" } } })],
    ["REFUND sem referencia", (w: ReturnType<typeof wager>) => submit({ ...w, body: { ...w.body, kind: "REFUND" } })],
    ["JSON malformado", (w: ReturnType<typeof wager>) => call("POST", "/wagering/transactions", "{oops", { "Idempotency-Key": w.key })],
  ])("400 VALIDATION_FAILED: %s", async (_label, send) => {
    const wallet = await createWallet();
    const { status, body } = await send(wager(wallet, "BET", "25.00"));
    expect(status).toBe(400);
    expect(body.error.code).toBe("VALIDATION_FAILED");
  });

  test("404 WALLET_NOT_FOUND", async () => {
    const ghost = { id: "0192f291-27dd-7d3f-8071-5f8685deef37", playerId: "p" };
    const { status, body } = await submit(wager(ghost, "BET", "1.00"));
    expect(status).toBe(404);
    expect(body.error.code).toBe("WALLET_NOT_FOUND");
  });

  test("correlation id do chamador volta no header; sem ele, um e gerado", async () => {
    const live = await call("GET", "/health/live", undefined, { "x-correlation-id": "abc-123" });
    expect(live.headers.get("x-correlation-id")).toBe("abc-123");
    const generated = await call("GET", "/health/live");
    expect(generated.headers.get("x-correlation-id")).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("consultas", () => {
  test("transacao por id interno e por (provider, externalTransactionId)", async () => {
    const wallet = await createWallet();
    const bet = wager(wallet, "BET", "25.00", { externalTransactionId: `consulta-${crypto.randomUUID()}` });
    const { body: created } = await submit(bet);
    const byId = await call("GET", `/wagering/transactions/${created.transactionId}`);
    expect(byId.status).toBe(200);
    expect(byId.body).toMatchObject({ id: created.transactionId, status: "PROCESSED", kind: "BET", money: { amount: "25.00", currency: "BRL" } });
    const byProvider = await call("GET", `/providers/provider-a/wagering/transactions/${bet.body.externalTransactionId}`);
    expect(byProvider.body).toEqual(byId.body);
    expect((await call("GET", "/providers/provider-a/wagering/transactions/nao-existe")).status).toBe(404);
  });

  test("ledger paginado por cursor opaco e estavel percorre tudo sem repetir", async () => {
    const wallet = await createWallet("100.00");
    for (let i = 0; i < 6; i++) await submit(wager(wallet, "BET", "1.00"));
    const seen: number[] = [];
    let cursor: string | null = null;
    do {
      const query: string = cursor ? `?limit=3&cursor=${cursor}` : "?limit=3";
      const page = await call("GET", `/wallets/${wallet.id}/ledger${query}`);
      expect(page.status).toBe(200);
      seen.push(...page.body.entries.map((e: { walletVersion: number }) => e.walletVersion));
      cursor = page.body.nextCursor;
    } while (cursor);
    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect((await call("GET", `/wallets/${wallet.id}/ledger?cursor=lixo`)).status).toBe(400);
    expect((await call("GET", `/wallets/${wallet.id}/ledger?limit=0`)).status).toBe(400);
  });

  test("reconciliacao devolve o contrato do enunciado", async () => {
    const wallet = await createWallet("1000.00");
    await submit(wager(wallet, "BET", "25.00"));
    const { status, body } = await call("POST", `/wallets/${wallet.id}/reconciliation`);
    expect(status).toBe(200);
    expect(body).toEqual({
      walletId: wallet.id,
      storedBalance: { amount: "975.00", currency: "BRL" },
      calculatedBalance: { amount: "975.00", currency: "BRL" },
      difference: { amount: "0.00", currency: "BRL" },
      consistent: true,
      checkedEntries: 2,
    });
  });
});
