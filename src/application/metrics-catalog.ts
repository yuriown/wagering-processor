/**
 * Catalogo de metricas: nome, tipo, descricao e rotulos fixos. A porta `Metrics` so aceita
 * estes nomes (erro de compilacao para nome errado) e o adaptador Prometheus registra
 * exatamente estes. Rotulos tem cardinalidade baixa e conhecida: nunca ids nem valores.
 */
export const COUNTERS = {
  wager_transactions_total: { help: "Transacoes decididas, por tipo e status", labels: ["kind", "status"] },
  wager_duplicates_total: { help: "Duplicatas detectadas (replay idempotente), por origem", labels: ["source"] },
  wager_unique_race_retries_total: { help: "Corridas perdidas em indice unico e tentadas de novo", labels: [] },
  wallet_lock_timeouts_total: { help: "Lock de wallet que nao saiu dentro do lock_timeout", labels: [] },
  sqs_messages_total: { help: "Mensagens SQS tratadas, por desfecho", labels: ["result"] },
  sqs_retries_total: { help: "Mensagens SQS devolvidas para nova tentativa", labels: [] },
  sqs_dlq_total: { help: "Mensagens SQS mandadas (ou a caminho) da DLQ, por motivo", labels: ["reason"] },
  outbox_published_total: { help: "Eventos publicados pela outbox", labels: ["eventType"] },
  outbox_publish_failures_total: { help: "Falhas de publicacao da outbox", labels: ["eventType"] },
  outbox_lease_lost_total: { help: "Lease da outbox perdido para outro publicador", labels: [] },
  pending_reference_resolutions_total: { help: "Reavaliacoes de PENDING_REFERENCE, por desfecho", labels: ["result"] },
  reconciliations_total: { help: "Reconciliacoes executadas, por resultado", labels: ["result"] },
  reconciliation_divergences_total: { help: "Reconciliacoes que encontraram saldo diferente do ledger", labels: [] },
  http_requests_total: { help: "Requisicoes HTTP, por rota e status", labels: ["method", "route", "status"] },
} as const;

/** Buckets em segundos: de 1 ms a 10 s. */
const LATENCY_BUCKETS = [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

export const HISTOGRAMS = {
  wager_processing_seconds: {
    help: "Latencia do caso de uso de transacao (inclui espera pelo lock), por origem e status",
    labels: ["source", "status"],
    buckets: LATENCY_BUCKETS,
  },
  wallet_lock_wait_seconds: {
    help: "Tempo esperando o lock da wallet (SELECT ... FOR UPDATE)",
    labels: [],
    buckets: LATENCY_BUCKETS,
  },
  sqs_processing_seconds: { help: "Latencia por mensagem SQS ate o ack", labels: [], buckets: LATENCY_BUCKETS },
  http_request_duration_seconds: {
    help: "Latencia HTTP, por rota e status",
    labels: ["method", "route", "status"],
    buckets: LATENCY_BUCKETS,
  },
} as const;

export type CounterName = keyof typeof COUNTERS;
export type HistogramName = keyof typeof HISTOGRAMS;

type LabelsOf<T extends { labels: readonly string[] }> = T["labels"][number] extends never
  ? Record<string, never>
  : { [K in T["labels"][number]]: string };

export type CounterLabels<N extends CounterName> = LabelsOf<(typeof COUNTERS)[N]>;
export type HistogramLabels<N extends HistogramName> = LabelsOf<(typeof HISTOGRAMS)[N]>;
