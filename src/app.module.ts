import { SQSClient } from "@aws-sdk/client-sqs";
import { type DynamicModule, type MiddlewareConsumer, Module, type NestModule, type OnApplicationShutdown } from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import { MikroORM } from "@mikro-orm/postgresql";
import { CreateWallet } from "./application/create-wallet";
import { EventFactory } from "./application/event-factory";
import type { AppLogger, Clock, IdGenerator, Metrics, TransactionRunner } from "./application/ports";
import { ProcessWagerTransaction } from "./application/process-wager-transaction";
import { WalletQueries } from "./application/queries";
import { ReconcileWallet } from "./application/reconcile-wallet";
import type { AppConfig } from "./config";
import { ReadinessProbe } from "./infrastructure/health/readiness";
import { createSqsClient } from "./infrastructure/messaging/sqs-client";
import { MikroOrmTransactionRunner } from "./infrastructure/persistence/mikro-orm-unit-of-work";
import { ormConfig } from "./infrastructure/persistence/orm.config";
import { JsonLogger, NoopMetrics, SystemClock, UuidV7Generator } from "./infrastructure/system";
import { PROVIDER_IDENTITY, ProviderAuthGuard, UnauthenticatedProviderIdentity } from "./interfaces/http/auth";
import { correlationMiddleware } from "./interfaces/http/correlation";
import { HealthController } from "./interfaces/http/health.controller";
import { HttpErrorFilter } from "./interfaces/http/http-error.filter";
import { WageringController } from "./interfaces/http/wagering.controller";
import { WalletsController } from "./interfaces/http/wallets.controller";

export const APP_CONFIG = Symbol("AppConfig");
export const CLOCK = Symbol("Clock");
export const ID_GENERATOR = Symbol("IdGenerator");
export const TRANSACTION_RUNNER = Symbol("TransactionRunner");
export const METRICS = Symbol("Metrics");
export const LOGGER = Symbol("AppLogger");

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
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController, WalletsController, WageringController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: CLOCK, useClass: SystemClock },
        { provide: ID_GENERATOR, useClass: UuidV7Generator },
        { provide: METRICS, useClass: NoopMetrics },
        { provide: LOGGER, useValue: new JsonLogger("http") },
        { provide: MikroORM, useFactory: () => MikroORM.init(ormConfig(config.databaseUrl)) },
        { provide: SQSClient, useFactory: () => createSqsClient(config.sqs) },
        {
          provide: TRANSACTION_RUNNER,
          inject: [MikroORM, CLOCK],
          useFactory: (orm: MikroORM, clock: Clock) =>
            new MikroOrmTransactionRunner(orm, clock, { lockTimeoutMs: config.lockTimeoutMs }),
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
    consumer.apply(correlationMiddleware).forRoutes("*");
  }
}
