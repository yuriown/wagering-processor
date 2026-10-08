import type { AppLogger, Clock, IdGenerator, Metrics } from "../application/ports";

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/** UUIDv7: ordenavel pelo tempo, o que mantem os indices de PK compactos. */
export class UuidV7Generator implements IdGenerator {
  next(): string {
    return Bun.randomUUIDv7();
  }
}

/** Uma linha JSON por evento de log. A fase de observabilidade troca por pino com correlacao automatica. */
export class JsonLogger implements AppLogger {
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
    const line = JSON.stringify({ time: new Date().toISOString(), level, context: this.context, message, ...fields });
    (level === "error" ? process.stderr : process.stdout).write(`${line}\n`);
  }
}

/** Placeholder ate a fase de observabilidade (prom-client); a interface ja e a definitiva. */
export class NoopMetrics implements Metrics {
  increment(): void {}
  observe(): void {}
}
