import { GetQueueAttributesCommand, type SQSClient } from "@aws-sdk/client-sqs";
import type { MikroORM } from "@mikro-orm/postgresql";
import type { QueueUrls } from "../messaging/queue-urls";
import type { GaugeSource } from "./prometheus-metrics";

async function scalar(orm: MikroORM, sql: string): Promise<number> {
  const [row] = (await orm.em.fork().execute(sql)) as { value: number | string | null }[];
  return row?.value === null || row?.value === undefined ? 0 : Number(row.value);
}

/** Gauges lidos na hora do scrape: refletem o estado do banco e da fila, nao a memoria desta instancia. */
export function operationalGauges(orm: MikroORM, sqs: SQSClient, urls: QueueUrls, dlqName: string): GaugeSource[] {
  return [
    {
      name: "outbox_lag_seconds",
      help: "Idade do evento mais antigo ainda nao publicado (0 se a outbox esta em dia)",
      read: () =>
        scalar(orm, `select coalesce(extract(epoch from now() - min(occurred_at)), 0) as value
                       from outbox_messages where published_at is null`),
    },
    {
      name: "outbox_pending_events",
      help: "Eventos gravados e ainda nao publicados",
      read: () => scalar(orm, `select count(*) as value from outbox_messages where published_at is null`),
    },
    {
      name: "pending_reference_transactions",
      help: "Transacoes esperando a referencia chegar",
      read: () => scalar(orm, `select count(*) as value from wager_transactions where status = 'PENDING_REFERENCE'`),
    },
    {
      name: "sqs_dlq_messages",
      help: "Mensagens paradas na DLQ (aproximado, segundo o SQS)",
      read: async () => {
        const { Attributes } = await sqs.send(
          new GetQueueAttributesCommand({ QueueUrl: await urls.get(dlqName), AttributeNames: ["ApproximateNumberOfMessages"] }),
        );
        return Number.parseInt(Attributes?.ApproximateNumberOfMessages ?? "0", 10);
      },
    },
  ];
}
