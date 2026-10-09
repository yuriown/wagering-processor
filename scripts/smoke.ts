import { GetQueueUrlCommand } from "@aws-sdk/client-sqs";
import { loadConfig } from "../src/config";
import { createSqsClient } from "../src/infrastructure/messaging/sqs-client";
import { WagerTransactionKind } from "../src/domain/wagering/wager-transaction";
import { WagerRequestProducer } from "../src/interfaces/sqs/wager-request-producer";

// Fumaca da pilha completa (docker compose --profile app): API + 3 workers + Postgres + SQS.
//   bun run smoke            (API em http://localhost:3000)
//   API_URL=http://... bun run smoke
const api = process.env.API_URL ?? "http://localhost:3000";
const config = loadConfig();

function check(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`FALHOU: ${message}`);
    process.exit(1);
  }
  console.log(`ok  ${message}`);
}

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${api}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text && response.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text };
}

async function eventually(what: string, probe: () => Promise<boolean>, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await probe())) {
    if (Date.now() > deadline) check(false, what);
    await Bun.sleep(250);
  }
  check(true, what);
}

await eventually("API pronta (Postgres e SQS alcancaveis)", async () => (await call("GET", "/health/ready").catch(() => ({ status: 0 }))).status === 200);

const playerId = crypto.randomUUID();
const wallet = await call("POST", "/wallets", { playerId, initialBalance: { amount: "100.00", currency: "BRL" } });
check(wallet.status === 201 && wallet.body.balance.amount === "100.00", "wallet criada com saldo inicial");
const walletId: string = wallet.body.id;

const bet = {
  providerId: "provider-smoke",
  externalTransactionId: `smoke-${crypto.randomUUID()}`,
  playerId,
  walletId,
  roundId: "round-smoke",
  gameId: "fortune-chimp",
  kind: "BET",
  money: { amount: "25.00", currency: "BRL" },
};
const key = `provider-smoke:${bet.externalTransactionId}`;
const first = await call("POST", "/wagering/transactions", bet, { "Idempotency-Key": key });
check(first.status === 201 && first.body.balance.amount === "75.00", "BET via HTTP processada (201)");
const replay = await call("POST", "/wagering/transactions", bet, { "Idempotency-Key": key });
check(replay.status === 200 && replay.body.idempotentReplay === true, "reenvio identico e replay (200)");

const sqs = createSqsClient(config.sqs);
const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: config.sqs.queueName }));
const producer = new WagerRequestProducer(sqs, QueueUrl!);
for (let i = 0; i < 3; i++) {
  const externalTransactionId = `smoke-sqs-${crypto.randomUUID()}`;
  await producer.send({
    ...bet,
    kind: WagerTransactionKind.Bet,
    externalTransactionId,
    idempotencyKey: `provider-smoke:${externalTransactionId}`,
    money: { amount: "5.00", currency: "BRL" },
  });
}
await eventually("3 BETs via SQS processadas pelos workers", async () => (await call("GET", `/wallets/${walletId}`)).body.balance.amount === "60.00");

const recon = await call("POST", `/wallets/${walletId}/reconciliation`);
check(recon.body.consistent === true && recon.body.checkedEntries === 5, "reconciliacao: saldo == ledger");

await eventually("outbox publicada pelos workers", async () => {
  const metrics = (await call("GET", "/metrics")).body as string;
  return /^outbox_pending_events\{[^}]*\} 0$/m.test(metrics);
});
sqs.destroy();
console.log("fumaca ok");
