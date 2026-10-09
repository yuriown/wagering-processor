export interface AppConfig {
  readonly port: number;
  readonly databaseUrl: string;
  readonly sqs: {
    readonly endpoint: string;
    readonly region: string;
    readonly queueName: string;
    readonly dlqName: string;
  };
}

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  return {
    port: Number(env.PORT ?? 3000),
    databaseUrl: env.DATABASE_URL ?? "postgres://wagering:wagering@localhost:55432/wagering",
    sqs: {
      endpoint: env.SQS_ENDPOINT ?? "http://localhost:4566",
      region: env.AWS_REGION ?? "us-east-1",
      queueName: env.SQS_QUEUE_NAME ?? "wager-transactions.fifo",
      dlqName: env.SQS_DLQ_NAME ?? "wager-transactions-dlq.fifo",
    },
  };
}
