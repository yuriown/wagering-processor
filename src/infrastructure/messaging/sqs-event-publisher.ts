import { SendMessageBatchCommand, type SQSClient } from "@aws-sdk/client-sqs";
import type { ClaimedOutboxMessage, EventPublisher, PublishResult } from "../../application/ports";

/** Limite do SendMessageBatch. */
const SQS_BATCH = 10;

/**
 * Publica eventos de integracao numa fila FIFO de eventos.
 * - MessageGroupId = aggregateId (walletId): ordem preservada por wallet dentro de um mesmo publicador.
 * - MessageDeduplicationId = eventId: o SQS descarta republicacoes em ate 5 min. E otimizacao;
 *   a garantia para o consumidor continua sendo deduplicar por eventId.
 */
export class SqsEventPublisher implements EventPublisher {
  constructor(
    private readonly sqs: SQSClient,
    private readonly queueUrl: () => Promise<string>,
  ) {}

  async publish(messages: readonly ClaimedOutboxMessage[]): Promise<PublishResult[]> {
    const queueUrl = await this.queueUrl();
    const results: PublishResult[] = [];
    for (let start = 0; start < messages.length; start += SQS_BATCH) {
      const chunk = messages.slice(start, start + SQS_BATCH);
      const entries = chunk.map((message, index) => ({
        Id: String(index),
        MessageBody: JSON.stringify(message.payload),
        MessageGroupId: message.aggregateId,
        MessageDeduplicationId: message.id,
        MessageAttributes: { eventType: { DataType: "String", StringValue: message.eventType } },
      }));
      const response = await this.sqs.send(new SendMessageBatchCommand({ QueueUrl: queueUrl, Entries: entries }));
      const failed = new Map((response.Failed ?? []).map((f) => [f.Id, f.Message ?? f.Code ?? "falha"]));
      chunk.forEach((message, index) => {
        const error = failed.get(String(index));
        results.push(error === undefined ? { id: message.id, ok: true } : { id: message.id, ok: false, error });
      });
    }
    return results;
  }
}
