import { hostname } from "node:os";

export type WorkerName = "consumer" | "outbox" | "references";
const WORKER_NAMES: readonly WorkerName[] = ["consumer", "outbox", "references"];

export interface AppConfig {
  readonly port: number;
  readonly databaseUrl: string;
  /** Identifica esta instancia (lease da outbox, logs). */
  readonly instanceId: string;
  /** Quanto uma transacao espera pelo lock de uma wallet antes de responder 503. */
  readonly lockTimeoutMs: number;
  /** Workers que este processo roda alem da API. Varias instancias podem rodar todos. */
  readonly workers: readonly WorkerName[];
  readonly sqs: {
    readonly endpoint: string;
    readonly region: string;
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
    readonly queueName: string;
    readonly dlqName: string;
    readonly eventsQueueName: string;
    readonly waitTimeSeconds: number;
    readonly maxMessages: number;
    readonly maxReceiveCount: number;
    readonly consumers: number;
  };
  readonly outbox: {
    readonly batchSize: number;
    readonly leaseMs: number;
    readonly idleDelayMs: number;
  };
  readonly references: {
    readonly idleDelayMs: number;
  };
  /** Somente testes de falha: "crash-after-commit" mata o processo entre o commit e o ack. */
  readonly faultInjection: "crash-after-commit" | undefined;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  return {
    port: integer(env.PORT, 3000),
    databaseUrl: env.DATABASE_URL ?? "postgres://wagering:wagering@localhost:55432/wagering",
    instanceId: env.INSTANCE_ID ?? `${hostname()}-${process.pid}`,
    lockTimeoutMs: integer(env.LOCK_TIMEOUT_MS, 5_000),
    workers: workers(env.WORKERS),
    sqs: {
      endpoint: env.SQS_ENDPOINT ?? "http://localhost:4566",
      region: env.AWS_REGION ?? "us-east-1",
      accessKeyId: env.AWS_ACCESS_KEY_ID ?? "test",
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY ?? "test",
      queueName: env.SQS_QUEUE_NAME ?? "wager-transactions.fifo",
      dlqName: env.SQS_DLQ_NAME ?? "wager-transactions-dlq.fifo",
      eventsQueueName: env.SQS_EVENTS_QUEUE_NAME ?? "wager-events.fifo",
      waitTimeSeconds: integer(env.SQS_WAIT_TIME_SECONDS, 20),
      maxMessages: integer(env.SQS_MAX_MESSAGES, 10),
      maxReceiveCount: integer(env.SQS_MAX_RECEIVE_COUNT, 5),
      consumers: integer(env.SQS_CONSUMERS, 2),
    },
    outbox: {
      batchSize: integer(env.OUTBOX_BATCH_SIZE, 50),
      leaseMs: integer(env.OUTBOX_LEASE_MS, 30_000),
      idleDelayMs: integer(env.OUTBOX_IDLE_DELAY_MS, 500),
    },
    references: {
      idleDelayMs: integer(env.REFERENCES_IDLE_DELAY_MS, 1_000),
    },
    faultInjection: env.FAULT_INJECTION === "crash-after-commit" ? "crash-after-commit" : undefined,
  };
}

function integer(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 0 || String(value) !== raw.trim()) {
    throw new Error(`configuracao invalida: esperado inteiro >= 0, recebido "${raw}"`);
  }
  return value;
}

function workers(raw: string | undefined): WorkerName[] {
  if (raw === undefined) return [...WORKER_NAMES];
  if (raw.trim() === "" || raw.trim() === "none") return [];
  const names = raw.split(",").map((n) => n.trim());
  for (const name of names) {
    if (!(WORKER_NAMES as readonly string[]).includes(name)) {
      throw new Error(`WORKERS invalido: "${name}" (use ${WORKER_NAMES.join(",")} ou none)`);
    }
  }
  return names as WorkerName[];
}
