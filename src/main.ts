import { loadConfig } from "./config";
import { createHttpApp } from "./http-app";
import { JsonLogger } from "./infrastructure/system";

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const logger = new JsonLogger("main");
  const app = await createHttpApp(config);
  await app.listen(config.port);
  // Com PORT=0 o sistema escolhe a porta; esta linha diz qual (os testes multi-processo leem daqui).
  logger.info("http pronto", { url: await app.getUrl(), instanceId: config.instanceId, workers: config.workers });
}

void bootstrap();
