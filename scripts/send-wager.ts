import { GetQueueUrlCommand } from "@aws-sdk/client-sqs";
import type { WagerCommand } from "../src/application/wager-command";
import { loadConfig } from "../src/config";
import { createSqsClient } from "../src/infrastructure/messaging/sqs-client";
import { WagerRequestProducer } from "../src/interfaces/sqs/wager-request-producer";

// Publica um WagerTransactionRequested na fila, como um provedor faria.
//   bun run sqs:send -- <walletId> <playerId> <kind> <amount> [externalTransactionId] [referenceExternalTransactionId]
const [walletId, playerId, kind = "BET", amount = "10.00", external, reference] = process.argv.slice(2);
if (!walletId || !playerId) {
  console.error("uso: bun run sqs:send -- <walletId> <playerId> [kind] [amount] [externalTransactionId] [referenceExternalTransactionId]");
  process.exit(1);
}

const config = loadConfig();
const sqs = createSqsClient(config.sqs);
const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: config.sqs.queueName }));
const externalTransactionId = external ?? `tx-${crypto.randomUUID()}`;
const command: WagerCommand = {
  providerId: "provider-a",
  externalTransactionId,
  idempotencyKey: `provider-a:${externalTransactionId}`,
  playerId,
  walletId,
  roundId: "round-1",
  gameId: "fortune-chimp",
  kind: kind as WagerCommand["kind"],
  money: { amount, currency: "BRL" },
  referenceExternalTransactionId: reference,
};
const messageId = await new WagerRequestProducer(sqs, QueueUrl!).send(command);
console.log(JSON.stringify({ messageId, externalTransactionId }));
sqs.destroy();
