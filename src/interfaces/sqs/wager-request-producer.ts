import { SendMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import type { WagerCommand } from "../../application/wager-command";
import { WAGER_REQUESTED, type WagerTransactionRequested } from "./wager-message";

/**
 * Lado do provedor: publica WagerTransactionRequested. Usado em testes, no script
 * de envio manual e no teste de carga. MessageGroupId = walletId mantem a ordem por wallet.
 */
export class WagerRequestProducer {
  constructor(
    private readonly sqs: SQSClient,
    private readonly queueUrl: string,
  ) {}

  async send(command: WagerCommand, options: { messageId?: string; deduplicationId?: string } = {}): Promise<string> {
    const messageId = options.messageId ?? `msg-${crypto.randomUUID()}`;
    const envelope: WagerTransactionRequested = {
      messageId,
      type: WAGER_REQUESTED,
      occurredAt: new Date().toISOString(),
      data: { ...command },
    };
    await this.sendRaw(JSON.stringify(envelope), command.walletId, options.deduplicationId ?? messageId);
    return messageId;
  }

  async sendRaw(body: string, groupId: string, deduplicationId: string): Promise<void> {
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: body,
        MessageGroupId: groupId,
        MessageDeduplicationId: deduplicationId,
      }),
    );
  }
}
