import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import type { AppConfig } from "./config";

/** Monta a aplicacao HTTP. Usado pelo main e pelos testes (com um banco proprio). */
export async function createHttpApp(config: AppConfig, options: { logger?: false } = {}): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule.forRoot(config), {
    ...(options.logger === false ? { logger: false } : {}),
    bodyParser: true,
  });
  // Repassa SIGTERM/SIGINT aos hooks de shutdown (fecha banco e SQS).
  app.enableShutdownHooks();
  return app;
}
