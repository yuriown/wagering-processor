import { cpus, platform, release, totalmem } from "node:os";
import { SendMessageBatchCommand } from "@aws-sdk/client-sqs";
import { WAGER_REQUESTED } from "../src/interfaces/sqs/wager-message";
import { type Instance, startInstance, waitFor } from "../test/support/cluster";
import { createTestDatabase } from "../test/support/database";
import { createTestQueues } from "../test/support/queues";

/**
 * Teste de carga autocontido: banco e filas proprios, N instancias da aplicacao como
 * processos, cenarios HTTP e SQS, metricas lidas do /metrics de cada instancia e do banco.
 * Grava docs/load-test-results.md e confere os invariantes no fim.
 *
 *   bun run test:load
 *   LOAD_DURATION_S=30 LOAD_VUS=64 LOAD_INSTANCES=3 LOAD_SQS_MESSAGES=3000 bun run test:load
 */
const env = (name: string, fallback: number) => {
  const raw = process.env[name];
  return raw === undefined ? fallback : Number.parseInt(raw, 10);
};
const DURATION_S = env("LOAD_DURATION_S", 20);
const VUS = env("LOAD_VUS", 48);
const HOT_VUS = env("LOAD_HOT_VUS", 16);
const INSTANCES = env("LOAD_INSTANCES", 3);
const WALLETS = env("LOAD_WALLETS", 300);
const SQS_MESSAGES = env("LOAD_SQS_MESSAGES", 2000);
const SQS_WALLETS = env("LOAD_SQS_WALLETS", 100);
const DB_POOL_MAX = env("LOAD_DB_POOL_MAX", 10);
const DUPLICATE_RATIO = 0.05;

interface Wallet {
  id: string;
  playerId: string;
}

interface Command {
  body: Record<string, unknown>;
  key: string;
}

interface ScenarioResult {
  name: string;
  requests: number;
  seconds: number;
  throughput: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  statuses: Record<string, number>;
  errors: number;
  errorRate: number;
}

const log = (message: string) => console.log(`[carga] ${message}`);

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

const pick = <T>(items: readonly T[]): T => items[Math.floor(Math.random() * items.length)]!;

async function post(url: string, path: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

function newCommand(wallet: Wallet, kind: "BET" | "WIN", amount: string, roundId: string): Command {
  const externalTransactionId = `load-${crypto.randomUUID()}`;
  return {
    key: `provider-load:${externalTransactionId}`,
    body: {
      providerId: "provider-load",
      externalTransactionId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId,
      gameId: "fortune-chimp",
      kind,
      money: { amount, currency: "BRL" },
    },
  };
}

/** VUs em laco fechado: cada um manda a proxima requisicao assim que a anterior volta. */
async function httpScenario(
  name: string,
  instances: Instance[],
  wallets: Wallet[],
  vus: number,
  durationS: number,
): Promise<ScenarioResult> {
  const latencies: number[] = [];
  const statuses: Record<string, number> = {};
  const sent: Command[] = [];
  let errors = 0;
  let next = 0;
  const started = performance.now();
  const end = started + durationS * 1000;

  await Promise.all(
    Array.from({ length: vus }, async () => {
      while (performance.now() < end) {
        const instance = instances[next++ % instances.length]!;
        // Uma fracao reenvia uma operacao ja enviada: mede o caminho do replay sob carga.
        const duplicate = sent.length > 0 && Math.random() < DUPLICATE_RATIO;
        const command = duplicate
          ? pick(sent)
          : newCommand(pick(wallets), Math.random() < 0.7 ? "BET" : "WIN", Math.random() < 0.7 ? "1.00" : "2.50", "round-load");
        if (!duplicate) sent.push(command);
        const t0 = performance.now();
        try {
          const response = await fetch(`${instance.url}/wagering/transactions`, {
            method: "POST",
            headers: { "content-type": "application/json", "Idempotency-Key": command.key },
            body: JSON.stringify(command.body),
          });
          await response.arrayBuffer();
          statuses[response.status] = (statuses[response.status] ?? 0) + 1;
          if (response.status >= 500) errors += 1;
        } catch {
          statuses.network = (statuses.network ?? 0) + 1;
          errors += 1;
        }
        latencies.push(performance.now() - t0);
      }
    }),
  );

  const seconds = (performance.now() - started) / 1000;
  latencies.sort((a, b) => a - b);
  return {
    name,
    requests: latencies.length,
    seconds,
    throughput: latencies.length / seconds,
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99),
    max: latencies.at(-1) ?? 0,
    statuses,
    errors,
    errorRate: latencies.length === 0 ? 0 : errors / latencies.length,
  };
}

/** Soma uma metrica (contador ou _sum/_count de histograma) em todas as instancias. */
async function scrape(instances: Instance[]): Promise<string[]> {
  return Promise.all(instances.map(async (i) => (await fetch(`${i.url}/metrics`)).text()));
}

function sumMetric(bodies: string[], name: string, labelFilter: Record<string, string> = {}): number {
  let total = 0;
  for (const body of bodies) {
    for (const line of body.split("\n")) {
      const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})? (\S+)$/.exec(line);
      if (!match || match[1] !== name) continue;
      const labels = Object.fromEntries([...(match[2] ?? "").matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
      if (Object.entries(labelFilter).every(([k, v]) => labels[k] === v)) total += Number(match[3]);
    }
  }
  return total;
}

/** Percentil aproximado de um histograma Prometheus somado entre instancias (limite superior do bucket). */
function histogramPercentile(bodies: string[], name: string, p: number): number {
  const buckets = new Map<number, number>();
  for (const body of bodies) {
    for (const line of body.split("\n")) {
      const match = new RegExp(`^${name}_bucket\\{(.*)\\} (\\S+)$`).exec(line);
      if (!match) continue;
      const le = /le="([^"]+)"/.exec(match[1]!)?.[1];
      if (le === undefined || le === "+Inf") continue;
      buckets.set(Number(le), (buckets.get(Number(le)) ?? 0) + Number(match[2]));
    }
  }
  const total = sumMetric(bodies, `${name}_count`);
  if (total === 0) return 0;
  for (const [le, count] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
    if (count >= (p / 100) * total) return le;
  }
  return Number.POSITIVE_INFINITY;
}

const ms = (value: number) => (Number.isFinite(value) ? `${value.toFixed(1)} ms` : "> 10 s");

async function main(): Promise<void> {
  log(`ambiente: ${cpus()[0]?.model} x${cpus().length}, ${(totalmem() / 2 ** 30).toFixed(1)} GiB, ${platform()} ${release()}, Bun ${Bun.version}`);
  const db = await createTestDatabase();
  const queues = await createTestQueues({ visibilityTimeoutSeconds: 30, maxReceiveCount: 5 });
  const instances: Instance[] = [];
  const lagSamples: { at: number; lag: number; pending: number }[] = [];
  let sampling = true;

  try {
    const [{ version }] = await db.sql`select version()`;
    log(`subindo ${INSTANCES} instancias (pool de ${DB_POOL_MAX} conexoes cada)`);
    for (let i = 1; i <= INSTANCES; i++) {
      instances.push(
        await startInstance(`carga-${i}`, {
          databaseUrl: db.url,
          queueName: queues.queueName,
          dlqName: queues.dlqName,
          eventsQueueName: queues.eventsName,
          maxReceiveCount: queues.maxReceiveCount,
          extra: { DB_POOL_MAX: String(DB_POOL_MAX), SQS_CONSUMERS: "2" },
        }),
      );
    }

    // Amostra o lag da outbox durante tudo (leitura direta no banco, a cada 500 ms).
    const sampler = (async () => {
      while (sampling) {
        const [row] = await db.sql`
          select coalesce(extract(epoch from now() - min(occurred_at)), 0)::float8 as lag, count(*)::int as pending
            from outbox_messages where published_at is null`;
        lagSamples.push({ at: Date.now(), lag: row.lag, pending: row.pending });
        await Bun.sleep(500);
      }
    })();

    log(`criando ${WALLETS} wallets`);
    const wallets: Wallet[] = [];
    for (let i = 0; i < WALLETS; i++) {
      const playerId = crypto.randomUUID();
      const { body } = await post(instances[i % INSTANCES]!.url, "/wallets", {
        playerId,
        initialBalance: { amount: "1000000.00", currency: "BRL" },
      });
      wallets.push({ id: body.id as string, playerId });
    }
    const hotPlayer = crypto.randomUUID();
    const hot = { id: (await post(instances[0]!.url, "/wallets", { playerId: hotPlayer, initialBalance: { amount: "1000000.00", currency: "BRL" } })).body.id as string, playerId: hotPlayer };

    // Aquecimento: JIT, pools e planos de consulta.
    await httpScenario("aquecimento", instances, wallets, 8, 3);

    log(`cenario 1: HTTP, ${VUS} VUs em ${WALLETS} wallets por ${DURATION_S} s`);
    const before1 = await scrape(instances);
    const spread = await httpScenario("HTTP, wallets distribuidas", instances, wallets, VUS, DURATION_S);
    const after1 = await scrape(instances);

    log(`cenario 2: HTTP, ${HOT_VUS} VUs numa unica wallet por ${DURATION_S} s`);
    const hotResult = await httpScenario("HTTP, wallet quente (1 wallet)", instances, [hot], HOT_VUS, DURATION_S);
    const after2 = await scrape(instances);

    log(`cenario 3: SQS, ${SQS_MESSAGES} mensagens em ${SQS_WALLETS} wallets`);
    const sqsWallets = wallets.slice(0, SQS_WALLETS);
    const sentAt = new Map<string, number>();
    const sqsStarted = performance.now();
    const batches: { Id: string; MessageBody: string; MessageGroupId: string; MessageDeduplicationId: string }[][] = [];
    for (let i = 0; i < SQS_MESSAGES; i += 10) {
      batches.push(
        Array.from({ length: Math.min(10, SQS_MESSAGES - i) }, (_, j) => {
          const wallet = sqsWallets[(i + j) % sqsWallets.length]!;
          const command = newCommand(wallet, "BET", "1.00", "round-sqs");
          const messageId = `load-msg-${crypto.randomUUID()}`;
          sentAt.set(messageId, Date.now());
          return {
            Id: String(j),
            MessageBody: JSON.stringify({
              messageId,
              type: WAGER_REQUESTED,
              occurredAt: new Date().toISOString(),
              data: { ...command.body, idempotencyKey: command.key },
            }),
            MessageGroupId: wallet.id,
            MessageDeduplicationId: messageId,
          };
        }),
      );
    }
    for (let i = 0; i < batches.length; i += 8) {
      await Promise.all(
        batches.slice(i, i + 8).map((entries) => queues.sqs.send(new SendMessageBatchCommand({ QueueUrl: queues.queueUrl, Entries: entries }))),
      );
    }
    const enqueueSeconds = (performance.now() - sqsStarted) / 1000;
    await waitFor(
      "mensagens processadas",
      async () => {
        const [row] = await db.sql`select count(*)::int as count from inbox_messages where message_id like 'load-msg-%'`;
        return row.count >= SQS_MESSAGES;
      },
      600_000,
      250,
    );
    const sqsSeconds = (performance.now() - sqsStarted) / 1000;
    const inbox = await db.sql`select message_id, received_at from inbox_messages where message_id like 'load-msg-%'`;
    const sqsLatencies = (inbox as { message_id: string; received_at: Date }[])
      .map((r) => new Date(r.received_at).getTime() - (sentAt.get(r.message_id) ?? 0))
      .sort((a, b) => a - b);
    const after3 = await scrape(instances);

    log("esperando a outbox zerar");
    const loadEnded = Date.now();
    await waitFor("outbox publicada", async () => {
      const [row] = await db.sql`select count(*)::int as count from outbox_messages where published_at is null`;
      return row.count === 0;
    }, 600_000, 250);
    const outboxDrainSeconds = (Date.now() - loadEnded) / 1000;
    sampling = false;
    await sampler;

    // Invariantes depois de tudo.
    const [invariants] = await db.sql`
      select count(*)::int as wallets,
             count(*) filter (where w.balance < 0)::int as negative,
             count(*) filter (where w.balance <> coalesce(l.total, 0))::int as divergent
        from wallets w
        left join (select wallet_id, sum(case direction when 'CREDIT' then amount else -amount end) as total
                     from wallet_ledger_entries group by wallet_id) l on l.wallet_id = w.id`;
    const [dupes] = await db.sql`
      select count(*)::int as count from (
        select transaction_id from wallet_ledger_entries group by transaction_id having count(*) > 1) d`;
    const [totals] = await db.sql`
      select (select count(*)::int from wager_transactions where kind <> 'OPENING') as transactions,
             (select count(*)::int from wallet_ledger_entries) as entries,
             (select count(*)::int from outbox_messages) as events`;

    const lags = lagSamples.map((s) => s.lag).sort((a, b) => a - b);
    const lockWait = {
      count: sumMetric(after3, "wallet_lock_wait_seconds_count"),
      mean: (sumMetric(after3, "wallet_lock_wait_seconds_sum") / Math.max(1, sumMetric(after3, "wallet_lock_wait_seconds_count"))) * 1000,
      p95Spread: histogramPercentile(after1, "wallet_lock_wait_seconds", 95) * 1000,
      p95All: histogramPercentile(after3, "wallet_lock_wait_seconds", 95) * 1000,
    };
    const hotLockMeanMs =
      ((sumMetric(after2, "wallet_lock_wait_seconds_sum") - sumMetric(after1, "wallet_lock_wait_seconds_sum")) /
        Math.max(1, sumMetric(after2, "wallet_lock_wait_seconds_count") - sumMetric(after1, "wallet_lock_wait_seconds_count"))) *
      1000;

    const report = renderReport({
      environment: {
        cpu: `${cpus()[0]?.model ?? "?"} (${cpus().length} threads)`,
        memory: `${(totalmem() / 2 ** 30).toFixed(1)} GiB`,
        os: `${platform()} ${release()}`,
        bun: Bun.version,
        postgres: String(version).split(" on ")[0] ?? String(version),
      },
      scenarios: [spread, hotResult],
      sqs: {
        messages: SQS_MESSAGES,
        wallets: SQS_WALLETS,
        enqueueSeconds,
        seconds: sqsSeconds,
        throughput: SQS_MESSAGES / sqsSeconds,
        p50: percentile(sqsLatencies, 50),
        p95: percentile(sqsLatencies, 95),
        p99: percentile(sqsLatencies, 99),
        retries: sumMetric(after3, "sqs_retries_total"),
        dlq: sumMetric(after3, "sqs_dlq_total"),
      },
      conflicts: {
        lockWaitCount: lockWait.count,
        lockWaitMeanMs: lockWait.mean,
        lockWaitP95SpreadMs: lockWait.p95Spread,
        lockWaitP95AllMs: lockWait.p95All,
        hotLockMeanMs,
        lockTimeouts: sumMetric(after3, "wallet_lock_timeouts_total"),
        uniqueRetries: sumMetric(after3, "wager_unique_race_retries_total"),
        duplicates: sumMetric(after3, "wager_duplicates_total"),
        duplicatesBeforeHot: sumMetric(after1, "wager_duplicates_total") - sumMetric(before1, "wager_duplicates_total"),
      },
      outbox: {
        maxLag: lags.at(-1) ?? 0,
        p95Lag: lags.length ? lags[Math.ceil(0.95 * lags.length) - 1]! : 0,
        maxPending: Math.max(0, ...lagSamples.map((s) => s.pending)),
        drainSeconds: outboxDrainSeconds,
        events: totals.events,
      },
      invariants: { ...invariants, duplicatedEntries: dupes.count, ...totals },
      parameters: { DURATION_S, VUS, HOT_VUS, INSTANCES, WALLETS, SQS_MESSAGES, SQS_WALLETS, DB_POOL_MAX },
    });
    await Bun.write("docs/load-test-results.md", report);
    console.log(report);

    if (invariants.negative !== 0 || invariants.divergent !== 0 || dupes.count !== 0) {
      console.error("INVARIANTE VIOLADO");
      process.exitCode = 1;
    }
  } finally {
    sampling = false;
    await Promise.all(instances.map((i) => i.kill().catch(() => undefined)));
    await queues.drop();
    await db.drop();
  }
}

interface ReportInput {
  environment: Record<string, string>;
  scenarios: ScenarioResult[];
  sqs: {
    messages: number;
    wallets: number;
    enqueueSeconds: number;
    seconds: number;
    throughput: number;
    p50: number;
    p95: number;
    p99: number;
    retries: number;
    dlq: number;
  };
  conflicts: Record<string, number>;
  outbox: { maxLag: number; p95Lag: number; maxPending: number; drainSeconds: number; events: number };
  invariants: Record<string, number>;
  parameters: Record<string, number>;
}

function renderReport(r: ReportInput): string {
  const scenarioRows = r.scenarios
    .map(
      (s) =>
        `| ${s.name} | ${s.requests} | ${s.throughput.toFixed(0)} req/s | ${ms(s.p50)} | ${ms(s.p95)} | ${ms(s.p99)} | ${ms(s.max)} | ${(s.errorRate * 100).toFixed(2)}% | ${Object.entries(s.statuses)
          .map(([k, v]) => `${k}: ${v}`)
          .join(", ")} |`,
    )
    .join("\n");
  return `# Resultado do teste de carga

Gerado por \`bun run test:load\` em ${new Date().toISOString()}. Metodologia e analise em [load-test.md](load-test.md).

## Ambiente

| | |
|---|---|
| CPU | ${r.environment.cpu} |
| Memoria | ${r.environment.memory} |
| Sistema | ${r.environment.os} |
| Bun | ${r.environment.bun} |
| Banco | ${r.environment.postgres} (container local) |
| SQS | MiniStack (container local) |
| Parametros | ${Object.entries(r.parameters).map(([k, v]) => `${k}=${v}`).join(", ")} |

## HTTP (latencia medida no cliente, VUs em laco fechado)

| Cenario | Requisicoes | Vazao | p50 | p95 | p99 | max | Erros (5xx/rede) | Status |
|---|---|---|---|---|---|---|---|---|
${scenarioRows}

## SQS (${r.sqs.messages} mensagens em ${r.sqs.wallets} wallets)

| | |
|---|---|
| Tempo para enfileirar | ${r.sqs.enqueueSeconds.toFixed(1)} s |
| Tempo ate todas processadas | ${r.sqs.seconds.toFixed(1)} s |
| Vazao de consumo | ${r.sqs.throughput.toFixed(0)} msg/s |
| Latencia envio -> commit (p50 / p95 / p99) | ${ms(r.sqs.p50)} / ${ms(r.sqs.p95)} / ${ms(r.sqs.p99)} |
| Retries / DLQ | ${r.sqs.retries} / ${r.sqs.dlq} |

## Conflitos de concorrencia

| | |
|---|---|
| Aquisicoes de lock de wallet | ${r.conflicts.lockWaitCount} |
| Espera media pelo lock (tudo) | ${ms(r.conflicts.lockWaitMeanMs!)} |
| Espera p95 pelo lock, wallets distribuidas | ${ms(r.conflicts.lockWaitP95SpreadMs!)} |
| Espera media pelo lock, wallet quente | ${ms(r.conflicts.hotLockMeanMs!)} |
| Lock timeouts (503) | ${r.conflicts.lockTimeouts} |
| Corridas em indice unico tentadas de novo | ${r.conflicts.uniqueRetries} |
| Duplicatas detectadas (replay) | ${r.conflicts.duplicates} |

## Outbox

| | |
|---|---|
| Eventos gravados | ${r.outbox.events} |
| Lag maximo durante a carga | ${r.outbox.maxLag.toFixed(2)} s |
| Lag p95 das amostras | ${r.outbox.p95Lag.toFixed(2)} s |
| Pendentes no pico | ${r.outbox.maxPending} |
| Tempo para zerar apos a carga | ${r.outbox.drainSeconds.toFixed(1)} s |

## Invariantes ao final

| | |
|---|---|
| Wallets | ${r.invariants.wallets} |
| Saldo negativo | ${r.invariants.negative} |
| Saldo diferente do ledger | ${r.invariants.divergent} |
| Transacao com mais de um lancamento | ${r.invariants.duplicatedEntries} |
| Transacoes / lancamentos | ${r.invariants.transactions} / ${r.invariants.entries} |
`;
}

await main();
