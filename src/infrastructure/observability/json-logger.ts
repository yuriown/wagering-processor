import type { LoggerService } from "@nestjs/common";
import { currentLogContext } from "../../application/log-context";
import type { AppLogger } from "../../application/ports";

export type LogSink = (line: string, level: string) => void;

const defaultSink: LogSink = (line, level) => {
  (level === "error" ? process.stderr : process.stdout).write(`${line}\n`);
};

/** Campos que nunca saem em log, mesmo se alguem os passar por engano. */
const REDACTED = new Set(["money", "amount", "balance", "payload", "body", "authorization", "password", "token"]);

/**
 * Uma linha JSON por evento: time, level, context, message, os campos de correlacao do
 * contexto corrente (correlationId, messageId, transactionId, walletId, providerId) e os
 * campos da chamada. Valores financeiros e payloads sao mascarados.
 */
export class JsonLogger implements AppLogger {
  /** Destino das linhas; os testes trocam para capturar. */
  static sink: LogSink = defaultSink;

  constructor(private readonly context: string) {}

  info(message: string, fields: Record<string, unknown> = {}): void {
    this.write("info", message, fields);
  }

  warn(message: string, fields: Record<string, unknown> = {}): void {
    this.write("warn", message, fields);
  }

  error(message: string, fields: Record<string, unknown> = {}): void {
    this.write("error", message, fields);
  }

  private write(level: string, message: string, fields: Record<string, unknown>): void {
    const safe: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) safe[key] = REDACTED.has(key.toLowerCase()) ? "[redacted]" : value;
    }
    const line = JSON.stringify({
      time: new Date().toISOString(),
      level,
      context: this.context,
      message,
      ...currentLogContext(),
      ...safe,
    });
    JsonLogger.sink(line, level);
  }
}

/** Faz os logs internos do NestJS sairem no mesmo formato JSON. */
export class NestJsonLogger implements LoggerService {
  private readonly logger = new JsonLogger("nest");

  log(message: unknown, context?: string): void {
    this.logger.info(String(message), { source: context });
  }
  error(message: unknown, trace?: string, context?: string): void {
    this.logger.error(String(message), { source: context, trace });
  }
  warn(message: unknown, context?: string): void {
    this.logger.warn(String(message), { source: context });
  }
  debug(): void {}
  verbose(): void {}
}
