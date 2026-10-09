import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import {
  IdempotencyConflictError,
  InboxConflictError,
  IntegrityViolationError,
  ValidationError,
  WalletNotFoundError,
} from "../../application/errors";
import { annotateLogContext, withTrackedLogContext } from "../../application/log-context";
import type { AppLogger, Metrics } from "../../application/ports";
import type { ProcessWagerTransaction } from "../../application/process-wager-transaction";
import { DomainError, InvariantViolationError } from "../../domain/shared/domain-error";
import type { QueueUrls } from "../../infrastructure/messaging/queue-urls";
import { parseWagerMessage } from "./wager-message";

export interface WagerConsumerOptions {
  consumerName: string;
  queueName: string;
  dlqName: string;
  maxMessages: number;
  waitTimeSeconds: number;
  /** Tentativas antes do redrive para a DLQ (tem de bater com o maxReceiveCount da fila). */
  maxReceiveCount: number;
  retryBaseSeconds: number;
  retryMaxSeconds: number;
}

/** Ganchos para teste de falha. Em producao ficam vazios. */
export interface ConsumerHooks {
  /** Chamado depois do COMMIT e antes do ack. Lancar SimulatedCrash abandona a mensagem sem ack. */
  afterCommit?: (messageId: string) => Promise<void> | void;
}

/** Simula o processo morrendo entre o commit e o ack: a mensagem nao e confirmada nem devolvida. */
export class SimulatedCrash extends Error {}

export type FailureKind = "business" | "transient" | "permanent";

/**
 * - business: regra de negocio que nao muda com nova tentativa -> ack (terminal).
 * - permanent: a mensagem esta errada (formato, messageId reusado) ou o banco recusou por integridade
 *   (bug ou dado corrompido): repetir nao muda nada -> DLQ ja.
 * - transient: o resto (banco fora, lock timeout, erro desconhecido) -> devolve com backoff;
 *   esgotado o maxReceiveCount, o redrive da fila manda para a DLQ.
 */
export function classifyFailure(error: unknown): FailureKind {
  if (error instanceof WalletNotFoundError || error instanceof IdempotencyConflictError) return "business";
  if (
    error instanceof ValidationError ||
    error instanceof IntegrityViolationError ||
    error instanceof InboxConflictError ||
    error instanceof DomainError ||
    error instanceof InvariantViolationError
  ) {
    return "permanent";
  }
  return "transient";
}

/**
 * Consumidor de `wager-transactions.fifo`. Usa o mesmo caso de uso do HTTP; a inbox
 * e gravada no mesmo COMMIT do efeito, e o ack (DeleteMessage) so acontece depois.
 * Se o processo morrer entre o commit e o ack, a redelivery cai na inbox e vira replay.
 */
export class WagerTransactionConsumer {
  private stopping = false;
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly sqs: SQSClient,
    private readonly urls: QueueUrls,
    private readonly process: ProcessWagerTransaction,
    private readonly logger: AppLogger,
    private readonly metrics: Metrics,
    private readonly options: WagerConsumerOptions,
    private readonly hooks: ConsumerHooks = {},
  ) {}

  /** Uma rodada de long polling. Devolve quantas mensagens recebeu. */
  async pollOnce(signal?: AbortSignal): Promise<number> {
    if (this.stopping) return 0;
    const queueUrl = await this.urls.get(this.options.queueName);
    let messages: Message[];
    try {
      const response = await this.sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: this.options.maxMessages,
          WaitTimeSeconds: this.options.waitTimeSeconds,
          AttributeNames: ["All"],
        }),
        signal === undefined ? {} : { abortSignal: signal },
      );
      messages = response.Messages ?? [];
    } catch (error) {
      if (signal?.aborted) return 0;
      throw error;
    }
    if (messages.length === 0) return 0;

    // FIFO: dentro de um grupo (wallet) em ordem; grupos diferentes em paralelo.
    const groups = new Map<string, Message[]>();
    for (const message of messages) {
      const group = message.Attributes?.MessageGroupId ?? message.MessageId ?? "";
      groups.set(group, [...(groups.get(group) ?? []), message]);
    }
    const batch = Promise.all([...groups.values()].map((group) => this.handleGroup(queueUrl, group)));
    const tracked = batch.then(() => undefined);
    this.inFlight.add(tracked);
    try {
      await tracked;
    } finally {
      this.inFlight.delete(tracked);
    }
    return messages.length;
  }

  /** SIGTERM: para de buscar, termina o que ja comecou e devolve o que nao comecou. */
  async stop(): Promise<void> {
    this.stopping = true;
    await Promise.all([...this.inFlight]);
  }

  private async handleGroup(queueUrl: string, group: Message[]): Promise<void> {
    for (let i = 0; i < group.length; i++) {
      const message = group[i]!;
      if (this.stopping) {
        await this.release(queueUrl, group.slice(i), "shutdown");
        return;
      }
      const settled = await this.handle(queueUrl, message);
      if (!settled) {
        // Falha transitoria no meio do grupo: as seguintes voltam para a fila, preservando a ordem.
        await this.release(queueUrl, group.slice(i + 1), "ordem do grupo");
        return;
      }
    }
  }

  /** Processa uma mensagem dentro do contexto de log dela. Devolve false se ficou pendente (sem ack). */
  private handle(queueUrl: string, message: Message): Promise<boolean> {
    return withTrackedLogContext({ messageId: message.MessageId ?? "?" }, () => this.handleInContext(queueUrl, message));
  }

  private async handleInContext(queueUrl: string, message: Message): Promise<boolean> {
    const started = performance.now();
    const receiveCount = Number.parseInt(message.Attributes?.ApproximateReceiveCount ?? "1", 10);
    let messageId = message.MessageId ?? "?";
    try {
      const parsed = parseWagerMessage(message.Body);
      messageId = parsed.messageId;
      annotateLogContext({ messageId: parsed.messageId, correlationId: parsed.correlationId });
      const outcome = await this.process.execute(parsed.command, {
        correlationId: parsed.correlationId,
        causationId: parsed.messageId,
        inbox: { consumerName: this.options.consumerName, messageId: parsed.messageId, payloadHash: parsed.payloadHash },
      });
      await this.hooks.afterCommit?.(parsed.messageId);
      await this.ack(queueUrl, message);
      const result = outcome.idempotentReplay ? "duplicate" : outcome.transaction.status;
      const seconds = (performance.now() - started) / 1000;
      this.metrics.increment("sqs_messages_total", { result });
      this.metrics.observe("sqs_processing_seconds", seconds);
      this.logger.info("mensagem processada", {
        result,
        kind: outcome.transaction.kind,
        failureCode: outcome.transaction.failureCode,
        receiveCount,
        durationMs: Math.round(seconds * 1000),
      });
      return true;
    } catch (error) {
      if (error instanceof SimulatedCrash) return false;
      return this.fail(queueUrl, message, messageId, receiveCount, error);
    }
  }

  private async fail(queueUrl: string, message: Message, messageId: string, receiveCount: number, error: unknown): Promise<boolean> {
    const kind = classifyFailure(error);
    const fields = {
      messageId,
      sqsMessageId: message.MessageId,
      receiveCount,
      kind,
      error: error instanceof Error ? error.name : typeof error,
      code: (error as { code?: unknown }).code,
    };
    if (kind === "business") {
      this.logger.warn("mensagem rejeitada por regra de negocio; ack", fields);
      await this.ack(queueUrl, message);
      this.metrics.increment("sqs_messages_total", { result: "business_error" });
      return true;
    }
    if (kind === "permanent") {
      this.logger.error("mensagem invalida; enviada para a DLQ", fields);
      await this.sendToDlq(message, error);
      await this.ack(queueUrl, message);
      this.metrics.increment("sqs_dlq_total", { reason: "permanent" });
      return true;
    }
    const delay = Math.min(this.options.retryMaxSeconds, this.options.retryBaseSeconds * 2 ** Math.max(0, receiveCount - 1));
    const last = receiveCount >= this.options.maxReceiveCount;
    this.logger.warn(last ? "falha transitoria na ultima tentativa; o redrive leva para a DLQ" : "falha transitoria; nova tentativa", {
      ...fields,
      retryInSeconds: delay,
    });
    this.metrics.increment("sqs_retries_total");
    if (last) this.metrics.increment("sqs_dlq_total", { reason: "max_receive" });
    await this.changeVisibility(queueUrl, message, delay);
    return false;
  }

  private async ack(queueUrl: string, message: Message): Promise<void> {
    await this.sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }));
  }

  private async release(queueUrl: string, messages: Message[], reason: string): Promise<void> {
    if (messages.length === 0) return;
    this.logger.info("devolvendo mensagens a fila", { count: messages.length, reason });
    await Promise.all(messages.map((m) => this.changeVisibility(queueUrl, m, 0)));
  }

  private async changeVisibility(queueUrl: string, message: Message, seconds: number): Promise<void> {
    try {
      await this.sqs.send(
        new ChangeMessageVisibilityCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle, VisibilityTimeout: seconds }),
      );
    } catch (error) {
      // Sem conseguir mudar a visibilidade, a mensagem volta sozinha quando o timeout da fila vencer.
      this.logger.warn("nao foi possivel mudar a visibilidade", { sqsMessageId: message.MessageId, error: String(error) });
    }
  }

  private async sendToDlq(message: Message, error: unknown): Promise<void> {
    const dlqUrl = await this.urls.get(this.options.dlqName);
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: dlqUrl,
        MessageBody: message.Body ?? "",
        MessageGroupId: message.Attributes?.MessageGroupId ?? "invalid",
        // Mesmo id do SQS: se cairmos aqui de novo em 5 min (crash antes do ack), a DLQ deduplica.
        MessageDeduplicationId: message.MessageId ?? crypto.randomUUID(),
        MessageAttributes: {
          failureReason: { DataType: "String", StringValue: error instanceof Error ? error.name : "unknown" },
          failureDetail: {
            DataType: "String",
            StringValue: (error instanceof Error ? error.message : String(error)).slice(0, 1000) || "-",
          },
        },
      }),
    );
  }
}
