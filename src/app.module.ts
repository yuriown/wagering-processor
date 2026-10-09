import { SQSClient } from "@aws-sdk/client-sqs";
import {
  type DynamicModule,
  Inject,
  type MiddlewareConsumer,
  Module,
  type NestModule,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import { MikroORM } from "@mikro-orm/postgresql";
import { CreateWallet } from "./application/create-wallet";
import { EventFactory } from "./application/event-factory";
import type {
  AppLogger,
  Clock,
  EventPublisher,
  IdGenerator,
  Metrics,
  OutboxStore,
  PendingReferenceFinder,
  TransactionRunner,
} from "./application/ports";
import { PublishOutbox } from "./application/publish-outbox";
import { PendingReferenceSweep, ResolvePendingReference } from "./application/resolve-pending-reference";
import { ProcessWagerTransaction } from "./application/process-wager-transaction";
import { WalletQueries } from "./application/queries";
import { ReconcileWallet } from "./application/reconcile-wallet";
import type { AppConfig } from "./config";
import { ReadinessProbe } from "./infrastructure/health/readiness";
import { QueueUrls } from "./infrastructure/messaging/queue-urls";
import { createSqsClient } from "./infrastructure/messaging/sqs-client";
import { SqsEventPublisher } from "./infrastructure/messaging/sqs-event-publisher";
import { MikroOrmTransactionRunner } from "./infrastructure/persistence/mikro-orm-unit-of-work";
import { ormConfig } from "./infrastructure/persistence/orm.config";
import { SqlOutboxStore, SqlPendingReferenceFinder } from "./infrastructure/persistence/sql-outbox-store";
import { operationalGauges } from "./infrastructure/observability/gauges";
import { JsonLogger } from "./infrastructure/observability/json-logger";
import { PrometheusMetrics } from "./infrastructure/observability/prometheus-metrics";
import { SystemClock, UuidV7Generator } from "./infrastructure/system";
import { PROVIDER_IDENTITY, ProviderAuthGuard, UnauthenticatedProviderIdentity } from "./interfaces/http/auth";
import { correlationMiddleware } from "./interfaces/http/correlation";
import { HealthController } from "./interfaces/http/health.controller";
import { HttpErrorFilter } from "./interfaces/http/http-error.filter";
import { MetricsController } from "./interfaces/http/metrics.controller";
import { WageringController } from "./interfaces/http/wagering.controller";
import { WalletsController } from "./interfaces/http/wallets.controller";
import { type ConsumerHooks, WagerTransactionConsumer } from "./interfaces/sqs/wager-consumer";
import { BackgroundWorkers, type WorkerDefinition } from "./interfaces/workers";

export const APP_CONFIG = Symbol("AppConfig");
export const CLOCK = Symbol("Clock");
export const ID_GENERATOR = Symbol("IdGenerator");
export const TRANSACTION_RUNNER = Symbol("TransactionRunner");
export const METRICS = Symbol("Metrics");
export const LOGGER = Symbol("AppLogger");
export const OUTBOX_STORE = Symbol("OutboxStore");
export const EVENT_PUBLISHER = Symbol("EventPublisher");
export const PENDING_REFERENCE_FINDER = Symbol("PendingReferenceFinder");

export const CONSUMER_NAME = "wager-transactions-consumer";

/** Fecha conexoes de banco e SQS no shutdown (SIGTERM chega aqui via enableShutdownHooks). */
class ResourceCloser implements OnApplicationShutdown {
  constructor(
    private readonly orm: MikroORM,
    private readonly sqs: SQSClient,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    this.sqs.destroy();
    await this.orm.close();
  }
}

/**
 * Composicao: o dominio e a aplicacao nao conhecem o NestJS; tudo e ligado aqui
 * por factories. Trocar MikroORM, relogio ou IdP muda so este arquivo.
 */
@Module({})
export class AppModule implements NestModule {
  constructor(
    @Inject(LOGGER) private readonly logger: AppLogger,
    @Inject(METRICS) private readonly metrics: Metrics,
  ) {}

  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController, MetricsController, WalletsController, WageringController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: CLOCK, useClass: SystemClock },
        { provide: ID_GENERATOR, useClass: UuidV7Generator },
        {
          provide: PrometheusMetrics,
          inject: [MikroORM, SQSClient, QueueUrls],
          useFactory: (orm: MikroORM, sqs: SQSClient, urls: QueueUrls) => {
            const metrics = new PrometheusMetrics({ instanceId: config.instanceId });
            for (const gauge of operationalGauges(orm, sqs, urls, config.sqs.dlqName)) metrics.addGauge(gauge);
            return metrics;
          },
        },
        { provide: METRICS, useExisting: PrometheusMetrics },
        { provide: LOGGER, useValue: new JsonLogger("http") },
        { provide: MikroORM, useFactory: () => MikroORM.init(ormConfig(config.databaseUrl, { pool: { min: 0, max: config.dbPoolMax } })) },
        { provide: SQSClient, useFactory: () => createSqsClient(config.sqs) },
        {
          provide: TRANSACTION_RUNNER,
          inject: [MikroORM, CLOCK, METRICS],
          useFactory: (orm: MikroORM, clock: Clock, metrics: Metrics) =>
            new MikroOrmTransactionRunner(orm, clock, { lockTimeoutMs: config.lockTimeoutMs }, metrics),
        },
        {
          provide: EventFactory,
          inject: [ID_GENERATOR, CLOCK],
          useFactory: (ids: IdGenerator, clock: Clock) => new EventFactory(ids, clock),
        },
        {
          provide: ProcessWagerTransaction,
          inject: [TRANSACTION_RUNNER, ID_GENERATOR, CLOCK, EventFactory, METRICS],
          useFactory: (runner: TransactionRunner, ids: IdGenerator, clock: Clock, events: EventFactory, metrics: Metrics) =>
            new ProcessWagerTransaction(runner, ids, clock, events, metrics),
        },
        {
          provide: CreateWallet,
          inject: [TRANSACTION_RUNNER, ID_GENERATOR, CLOCK, EventFactory],
          useFactory: (runner: TransactionRunner, ids: IdGenerator, clock: Clock, events: EventFactory) =>
            new CreateWallet(runner, ids, clock, events),
        },
        {
          provide: WalletQueries,
          inject: [TRANSACTION_RUNNER],
          useFactory: (runner: TransactionRunner) => new WalletQueries(runner),
        },
        {
          provide: ReconcileWallet,
          inject: [TRANSACTION_RUNNER, LOGGER, METRICS],
          useFactory: (runner: TransactionRunner, logger: AppLogger, metrics: Metrics) =>
            new ReconcileWallet(runner, logger, metrics),
        },
        {
          provide: ReadinessProbe,
          inject: [MikroORM, SQSClient],
          useFactory: (orm: MikroORM, sqs: SQSClient) => new ReadinessProbe(orm, sqs, config.sqs.queueName),
        },
        {
          provide: ResourceCloser,
          inject: [MikroORM, SQSClient],
          useFactory: (orm: MikroORM, sqs: SQSClient) => new ResourceCloser(orm, sqs),
        },
        { provide: QueueUrls, inject: [SQSClient], useFactory: (sqs: SQSClient) => new QueueUrls(sqs) },
        { provide: OUTBOX_STORE, inject: [MikroORM], useFactory: (orm: MikroORM) => new SqlOutboxStore(orm) },
        {
          provide: PENDING_REFERENCE_FINDER,
          inject: [MikroORM],
          useFactory: (orm: MikroORM) => new SqlPendingReferenceFinder(orm),
        },
        {
          provide: EVENT_PUBLISHER,
          inject: [SQSClient, QueueUrls],
          useFactory: (sqs: SQSClient, urls: QueueUrls) => new SqsEventPublisher(sqs, () => urls.get(config.sqs.eventsQueueName)),
        },
        {
          provide: PublishOutbox,
          inject: [OUTBOX_STORE, EVENT_PUBLISHER, CLOCK, METRICS, LOGGER],
          useFactory: (store: OutboxStore, publisher: EventPublisher, clock: Clock, metrics: Metrics, logger: AppLogger) =>
            new PublishOutbox(store, publisher, clock, metrics, logger, {
              owner: config.instanceId,
              batchSize: config.outbox.batchSize,
              leaseMs: config.outbox.leaseMs,
            }),
        },
        {
          provide: ResolvePendingReference,
          inject: [TRANSACTION_RUNNER, ID_GENERATOR, CLOCK, EventFactory, METRICS],
          useFactory: (runner: TransactionRunner, ids: IdGenerator, clock: Clock, events: EventFactory, metrics: Metrics) =>
            new ResolvePendingReference(runner, ids, clock, events, metrics),
        },
        {
          provide: PendingReferenceSweep,
          inject: [PENDING_REFERENCE_FINDER, ResolvePendingReference, CLOCK],
          useFactory: (finder: PendingReferenceFinder, resolver: ResolvePendingReference, clock: Clock) =>
            new PendingReferenceSweep(finder, resolver, clock),
        },
        {
          provide: WagerTransactionConsumer,
          inject: [SQSClient, QueueUrls, ProcessWagerTransaction, METRICS],
          useFactory: (sqs: SQSClient, urls: QueueUrls, process: ProcessWagerTransaction, metrics: Metrics) =>
            new WagerTransactionConsumer(
              sqs,
              urls,
              process,
              new JsonLogger("sqs-consumer"),
              metrics,
              {
                consumerName: CONSUMER_NAME,
                queueName: config.sqs.queueName,
                dlqName: config.sqs.dlqName,
                maxMessages: config.sqs.maxMessages,
                waitTimeSeconds: config.sqs.waitTimeSeconds,
                maxReceiveCount: config.sqs.maxReceiveCount,
                retryBaseSeconds: 2,
                retryMaxSeconds: 60,
              },
              faultHooks(config),
            ),
        },
        {
          provide: BackgroundWorkers,
          inject: [WagerTransactionConsumer, PublishOutbox, PendingReferenceSweep],
          useFactory: (consumer: WagerTransactionConsumer, outbox: PublishOutbox, sweep: PendingReferenceSweep) =>
            new BackgroundWorkers(workerDefinitions(config, consumer, outbox, sweep), new JsonLogger("workers")),
        },
        { provide: PROVIDER_IDENTITY, useClass: UnauthenticatedProviderIdentity },
        { provide: APP_GUARD, useClass: ProviderAuthGuard },
        {
          provide: APP_FILTER,
          inject: [LOGGER],
          useFactory: (logger: AppLogger) => new HttpErrorFilter(logger),
        },
      ],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(correlationMiddleware(this.logger, this.metrics)).forRoutes("*");
  }
}

function workerDefinitions(
  config: AppConfig,
  consumer: WagerTransactionConsumer,
  outbox: PublishOutbox,
  sweep: PendingReferenceSweep,
): WorkerDefinition[] {
  const definitions: WorkerDefinition[] = [];
  if (config.workers.includes("consumer")) {
    for (let i = 0; i < config.sqs.consumers; i++) {
      definitions.push({
        name: `sqs-consumer-${i}`,
        run: (signal) => consumer.pollOnce(signal),
        idleDelayMs: 0,
        stop: () => consumer.stop(),
      });
    }
  }
  if (config.workers.includes("outbox")) {
    definitions.push({ name: "outbox-relay", run: () => outbox.runOnce(), idleDelayMs: config.outbox.idleDelayMs });
  }
  if (config.workers.includes("references")) {
    definitions.push({ name: "pending-references", run: () => sweep.runOnce(), idleDelayMs: config.references.idleDelayMs });
  }
  return definitions;
}

/** Injecao de falha so para o teste de crash: morte imediata (SIGKILL), sem shutdown gracioso. */
function faultHooks(config: AppConfig): ConsumerHooks {
  if (config.faultInjection !== "crash-after-commit") return {};
  return {
    afterCommit: () => {
      process.kill(process.pid, "SIGKILL");
    },
  };
}
