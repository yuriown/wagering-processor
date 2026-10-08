import { SQSClient } from "@aws-sdk/client-sqs";
import type { AppConfig } from "../../config";

export function createSqsClient(config: AppConfig["sqs"]): SQSClient {
  return new SQSClient({
    endpoint: config.endpoint,
    region: config.region,
    // Credenciais do emulador local; em AWS real viriam da cadeia padrao (role da instancia).
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    maxAttempts: 3,
  });
}
