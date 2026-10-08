import type { BeforeApplicationShutdown, OnApplicationBootstrap } from "@nestjs/common";
import type { AppLogger } from "../application/ports";
import { PollingLoop } from "../infrastructure/polling-loop";

export interface WorkerDefinition {
  name: string;
  run: (signal: AbortSignal) => Promise<number>;
  idleDelayMs: number;
  /** Chamado no shutdown antes de esperar o loop (ex.: consumidor devolve mensagens). */
  stop?: () => Promise<void>;
}

/**
 * Sobe os workers depois que a aplicacao inicia e os para antes de fechar banco e SQS:
 * SIGTERM -> beforeApplicationShutdown (para de buscar, termina o que comecou) -> onApplicationShutdown (fecha conexoes).
 */
export class BackgroundWorkers implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly loops: { definition: WorkerDefinition; loop: PollingLoop }[];

  constructor(
    definitions: WorkerDefinition[],
    private readonly logger: AppLogger,
  ) {
    this.loops = definitions.map((definition) => ({
      definition,
      loop: new PollingLoop(definition.run, logger, {
        name: definition.name,
        idleDelayMs: definition.idleDelayMs,
        errorDelayMs: 1_000,
      }),
    }));
  }

  onApplicationBootstrap(): void {
    for (const { definition, loop } of this.loops) {
      loop.start();
      this.logger.info("worker iniciado", { worker: definition.name });
    }
  }

  async beforeApplicationShutdown(signal?: string): Promise<void> {
    this.logger.info("parando workers", { signal, workers: this.loops.length });
    await Promise.all(
      this.loops.map(async ({ definition, loop }) => {
        await definition.stop?.();
        await loop.stop();
      }),
    );
    this.logger.info("workers parados");
  }
}
