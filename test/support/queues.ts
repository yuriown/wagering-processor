import {
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  type Message,
  ReceiveMessageCommand,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import { loadConfig } from "../../src/config";
import { createSqsClient } from "../../src/infrastructure/messaging/sqs-client";

export interface TestQueues {
  sqs: SQSClient;
  queueName: string;
  dlqName: string;
  eventsName: string;
  queueUrl: string;
  dlqUrl: string;
  eventsUrl: string;
  maxReceiveCount: number;
  drop(): Promise<void>;
}

/**
 * Filas proprias por arquivo de teste (nada compartilhado com o dev nem entre arquivos),
 * no MiniStack real. Visibilidade curta para provar redelivery sem esperar 30 s.
 */
export async function createTestQueues(options: { visibilityTimeoutSeconds?: number; maxReceiveCount?: number } = {}) {
  const sqs = createSqsClient(loadConfig().sqs);
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
  const maxReceiveCount = options.maxReceiveCount ?? 3;
  const create = async (name: string, attributes: Record<string, string>) =>
    (await sqs.send(new CreateQueueCommand({ QueueName: name, Attributes: { FifoQueue: "true", ...attributes } }))).QueueUrl!;
  const arn = async (url: string) =>
    (await sqs.send(new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ["QueueArn"] }))).Attributes!.QueueArn!;

  const dlqName = `t-${suffix}-dlq.fifo`;
  const queueName = `t-${suffix}.fifo`;
  const eventsName = `t-${suffix}-events.fifo`;
  const dlqUrl = await create(dlqName, {});
  const queueUrl = await create(queueName, {
    VisibilityTimeout: String(options.visibilityTimeoutSeconds ?? 2),
    RedrivePolicy: JSON.stringify({ deadLetterTargetArn: await arn(dlqUrl), maxReceiveCount: String(maxReceiveCount) }),
  });
  const eventsUrl = await create(eventsName, {});

  return {
    sqs,
    queueName,
    dlqName,
    eventsName,
    queueUrl,
    dlqUrl,
    eventsUrl,
    maxReceiveCount,
    async drop() {
      for (const url of [queueUrl, dlqUrl, eventsUrl]) {
        await sqs.send(new DeleteQueueCommand({ QueueUrl: url })).catch(() => undefined);
      }
      sqs.destroy();
    },
  } satisfies TestQueues;
}

/** Mensagens visiveis + em voo. Zero = tudo confirmado. */
export async function queueDepth(sqs: SQSClient, url: string): Promise<{ visible: number; inFlight: number }> {
  const { Attributes } = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: url,
      AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"],
    }),
  );
  return {
    visible: Number.parseInt(Attributes?.ApproximateNumberOfMessages ?? "0", 10),
    inFlight: Number.parseInt(Attributes?.ApproximateNumberOfMessagesNotVisible ?? "0", 10),
  };
}

/** Le (e confirma) tudo o que houver na fila, ate uma leitura vazia. */
export async function drain(sqs: SQSClient, url: string): Promise<Message[]> {
  const all: Message[] = [];
  for (;;) {
    const { Messages = [] } = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: url, MaxNumberOfMessages: 10, WaitTimeSeconds: 1, AttributeNames: ["All"], MessageAttributeNames: ["All"] }),
    );
    if (Messages.length === 0) return all;
    all.push(...Messages);
    for (const m of Messages) await sqs.send(new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: m.ReceiptHandle }));
  }
}
