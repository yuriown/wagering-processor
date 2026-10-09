import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { loadConfig } from "./config";

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const app = await NestFactory.create(AppModule);
  // Repassa SIGTERM/SIGINT aos hooks onModuleDestroy/beforeApplicationShutdown.
  app.enableShutdownHooks();
  await app.listen(config.port);
}

void bootstrap();
