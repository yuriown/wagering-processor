import { describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { GetQueueAttributesCommand, GetQueueUrlCommand, SQSClient } from "@aws-sdk/client-sqs";
import { loadConfig } from "../../src/config";

// Prova que a pilha do docker-compose esta de pe: os testes de integracao
// das proximas fases dependem de Postgres e SQS reais, nunca de mocks.
const config = loadConfig();

describe("infraestrutura local", () => {
  test("PostgreSQL responde", async () => {
    const sql = new SQL(config.databaseUrl);
    try {
      const [row] = await sql`select 1 as ok`;
      expect(row.ok).toBe(1);
    } finally {
      await sql.close();
    }
  });

  test("fila FIFO com redrive para a DLQ", async () => {
    const sqs = new SQSClient({
      endpoint: config.sqs.endpoint,
      region: config.sqs.region,
      credentials: { accessKeyId: "test", secretAccessKey: "test" },
    });

    const { QueueUrl: dlqUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: config.sqs.dlqName }));
    const { Attributes: dlq } = await sqs.send(
      new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ["QueueArn", "FifoQueue"] }),
    );

    const { QueueUrl: queueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: config.sqs.queueName }));
    const { Attributes: queue } = await sqs.send(
      new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ["FifoQueue", "RedrivePolicy"] }),
    );

    expect(dlq?.FifoQueue).toBe("true");
    expect(queue?.FifoQueue).toBe("true");
    const redrive = JSON.parse(queue?.RedrivePolicy ?? "{}");
    expect(redrive.deadLetterTargetArn).toBe(dlq?.QueueArn);
    expect(Number(redrive.maxReceiveCount)).toBeGreaterThan(0);
  });
});
