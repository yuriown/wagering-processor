import { SendMessageBatchCommand, type SQSClient } from "@aws-sdk/client-sqs";
import type { ClaimedOutboxMessage, EventPublisher, PublishResult } from "../../application/ports";

/** Limite do SendMessageBatch. */
const SQS_BATCH = 10;

/**
 * Publica eventos de integracao numa fila FIFO de eventos.
 * - MessageGroupId = aggregateId (walletId).
 * - MessageDeduplicationId = eventId: o SQS descarta republicacoes em ate 5 min. E otimizacao;
 *   a garantia para o consumidor continua sendo deduplicar por eventId.
 * Os blocos de 10 saem em paralelo; por isso a ordem entre blocos nao e estrita (ver ARCHITECTURE.md).
 */
export class SqsEventPublisher implements EventPublisher {
  constructor(
    private readonly sqs: SQSClient,
    private readonly queueUrl: () => Promise<string>,
  ) {}

  async publish(messages: readonly ClaimedOutboxMessage[]): Promise<PublishResult[]> {
    const queueUrl = await this.queueUrl();
    const chunks: ClaimedOutboxMessage[][] = [];
    for (let start = 0; start < messages.length; start += SQS_BATCH) {
      chunks.push(messages.slice(start, start + SQS_BATCH));
    }
    const results = await Promise.all(chunks.map((chunk) => this.publishChunk(queueUrl, chunk)));
    return results.flat();
  }

  private async publishChunk(queueUrl: string, chunk: ClaimedOutboxMessage[]): Promise<PublishResult[]> {
    const entries = chunk.map((message, index) => ({
      Id: String(index),
      MessageBody: JSON.stringify(message.payload),
      MessageGroupId: message.aggregateId,
      MessageDeduplicationId: message.id,
      MessageAttributes: { eventType: { DataType: "String", StringValue: message.eventType } },
    }));
    const response = await this.sqs.send(new SendMessageBatchCommand({ QueueUrl: queueUrl, Entries: entries }));
    const failed = new Map((response.Failed ?? []).map((f) => [f.Id, f.Message ?? f.Code ?? "falha"]));
    return chunk.map((message, index) => {
      const error = failed.get(String(index));
      return error === undefined ? { id: message.id, ok: true } : { id: message.id, ok: false, error };
    });
  }
}
