export interface AppConfig {
  readonly port: number;
  readonly databaseUrl: string;
  /** Quanto uma transacao espera pelo lock de uma wallet antes de responder 503. */
  readonly lockTimeoutMs: number;
  readonly sqs: {
    readonly endpoint: string;
    readonly region: string;
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
    readonly queueName: string;
    readonly dlqName: string;
  };
}

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  return {
    port: integer(env.PORT, 3000),
    databaseUrl: env.DATABASE_URL ?? "postgres://wagering:wagering@localhost:55432/wagering",
    lockTimeoutMs: integer(env.LOCK_TIMEOUT_MS, 5_000),
    sqs: {
      endpoint: env.SQS_ENDPOINT ?? "http://localhost:4566",
      region: env.AWS_REGION ?? "us-east-1",
      accessKeyId: env.AWS_ACCESS_KEY_ID ?? "test",
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY ?? "test",
      queueName: env.SQS_QUEUE_NAME ?? "wager-transactions.fifo",
      dlqName: env.SQS_DLQ_NAME ?? "wager-transactions-dlq.fifo",
    },
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
