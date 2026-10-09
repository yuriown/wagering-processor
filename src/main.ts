import { loadConfig } from "./config";
import { createHttpApp } from "./http-app";

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const app = await createHttpApp(config);
  await app.listen(config.port);
}

void bootstrap();
