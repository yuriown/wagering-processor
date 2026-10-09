import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import type { AppConfig } from "./config";
import { NestJsonLogger } from "./infrastructure/observability/json-logger";

/** Monta a aplicacao HTTP. Usado pelo main e pelos testes (com um banco proprio). */
export async function createHttpApp(config: AppConfig, options: { logger?: false } = {}): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule.forRoot(config), {
    // Logs do proprio Nest no mesmo JSON da aplicacao.
    logger: options.logger === false ? false : new NestJsonLogger(),
    bodyParser: true,
  });
  // Repassa SIGTERM/SIGINT aos hooks de shutdown (fecha banco e SQS).
  app.enableShutdownHooks();
  return app;
}
