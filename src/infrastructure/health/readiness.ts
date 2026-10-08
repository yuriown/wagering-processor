import { GetQueueUrlCommand, type SQSClient } from "@aws-sdk/client-sqs";
import type { MikroORM } from "@mikro-orm/postgresql";

export type DependencyStatus = "up" | "down";

export interface ReadinessReport {
  ready: boolean;
  checks: { postgres: DependencyStatus; sqs: DependencyStatus };
}

const CHECK_TIMEOUT_MS = 2_000;

/** Prontidao = PostgreSQL e SQS alcancaveis agora. Cada checagem tem prazo curto. */
export class ReadinessProbe {
  constructor(
    private readonly orm: MikroORM,
    private readonly sqs: SQSClient,
    private readonly queueName: string,
  ) {}

  async check(): Promise<ReadinessReport> {
    const [postgres, sqs] = await Promise.all([
      this.probe(() => this.orm.em.fork().execute("select 1")),
      this.probe((signal) => this.sqs.send(new GetQueueUrlCommand({ QueueName: this.queueName }), { abortSignal: signal })),
    ]);
    return { ready: postgres === "up" && sqs === "up", checks: { postgres, sqs } };
  }

  private async probe(run: (signal: AbortSignal) => Promise<unknown>): Promise<DependencyStatus> {
    const signal = AbortSignal.timeout(CHECK_TIMEOUT_MS);
    try {
      await Promise.race([
        run(signal),
        new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
      ]);
      return "up";
    } catch {
      return "down";
    }
  }
}
