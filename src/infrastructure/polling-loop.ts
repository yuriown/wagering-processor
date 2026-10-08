import type { AppLogger } from "../application/ports";

export interface PollingLoopOptions {
  name: string;
  /** Pausa quando a rodada nao encontrou trabalho. */
  idleDelayMs: number;
  /** Pausa depois de um erro (banco fora, por exemplo). */
  errorDelayMs: number;
}

/**
 * Executa `work` em loop ate `stop()`. Rodada que encontrou trabalho emenda na proxima;
 * rodada vazia espera idleDelayMs. `stop()` interrompe a espera e aguarda a rodada em curso terminar.
 */
export class PollingLoop {
  private running = false;
  private current: Promise<void> | undefined;
  private wake: (() => void) | undefined;

  constructor(
    private readonly work: (signal: AbortSignal) => Promise<number>,
    private readonly logger: AppLogger,
    private readonly options: PollingLoopOptions,
    private readonly abort = new AbortController(),
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.current = this.loop();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.abort.abort();
    this.wake?.();
    await this.current;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      let delay = 0;
      try {
        const done = await this.work(this.abort.signal);
        if (done === 0) delay = this.options.idleDelayMs;
      } catch (error) {
        if (!this.running) break;
        delay = this.options.errorDelayMs;
        this.logger.error("rodada do worker falhou", {
          worker: this.options.name,
          error: error instanceof Error ? error.name : typeof error,
          detail: error instanceof Error ? error.message : undefined,
        });
      }
      if (delay > 0 && this.running) await this.sleep(delay);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        resolve();
      }
      this.wake = done;
    });
  }
}
