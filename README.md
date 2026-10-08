# Distributed Wagering Processor

Servico financeiro que processa transacoes de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`)
vindas de varios provedores, por HTTP e por SQS, mantendo saldo, ledger, inbox e outbox consistentes
mesmo com mensagens duplicadas, fora de ordem e varias instancias concorrentes.

Decisoes, trade-offs, limitacoes e como cada falha eliminatoria e evitada: [`ARCHITECTURE.md`](ARCHITECTURE.md).

**Stack**: Bun 1.4, TypeScript estrito, NestJS 12, MikroORM 7, PostgreSQL 17, SQS (MiniStack), Docker Compose.

## Requisitos

- [Bun](https://bun.sh) 1.4+
- Docker com Compose v2

## Subindo tudo em containers (1 comando)

```bash
bun install           # so para os scripts auxiliares (smoke, sqs:send)
bun run stack:up      # Postgres + MiniStack + filas + migrations + 1 API (porta 3000) + 3 workers
bun run smoke         # verifica ponta a ponta: HTTP, replay, fila, workers, reconciliacao, outbox
bun run stack:down    # derruba e apaga os volumes
```

## Desenvolvimento local

```bash
bun install
bun run infra:up      # PostgreSQL (porta 55432) + MiniStack/SQS (porta 4566) + criacao das filas
bun run db:migrate    # aplica as migrations
bun run start         # API em http://localhost:3000 + workers
```

Migrations: `bun run db:status`, `bun run db:rollback` (desfaz a ultima), `bun run db:rollback -- --all`.
`bun run infra:down` derruba a infraestrutura e apaga os volumes.

## Testes

```bash
bun run typecheck
bun run test:unit          # dominio puro, sem infraestrutura (segundos)
bun run test:integration   # Postgres e SQS reais, um processo
bun run test:multiprocess  # 3+ instancias como processos separados (~1 min)
bun test                   # tudo
```

Integracao e multi-processo exigem `bun run infra:up`. Cada arquivo cria e apaga o proprio banco e as proprias filas:
nada e compartilhado com o ambiente de desenvolvimento nem entre arquivos. Nenhum teste substitui Postgres ou SQS
por mock.

### Onde esta cada teste obrigatorio

| Exigencia (secao 13) | Teste |
|---|---|
| Money: escala, arredondamento, entradas invalidas | `test/unit/domain/money.test.ts` |
| Invariantes da Wallet | `test/unit/domain/wallet.test.ts` |
| Regras de BET, WIN, LOSS, REFUND, ROLLBACK | `test/unit/domain/wager-settlement.test.ts` |
| Conflito de moeda | `money.test.ts`, `wallet.test.ts`, `wager-settlement.test.ts` |
| Idempotency key com payload divergente | `payload-hash.test.ts`, `integration/wagering.test.ts`, `http/api.test.ts` |
| Migrations e constraints | `integration/schema.test.ts` (viola cada garantia em SQL; up/down/up) |
| Atomicidade wallet, ledger, inbox, outbox | `schema.test.ts` (commit falha se faltar uma parte), `wagering.test.ts` |
| Inbox e redelivery | `integration/sqs-consumer.test.ts`, `multiprocess/cluster.test.ts` |
| Publishers concorrentes na mesma outbox | `outbox-and-references.test.ts` (2 publicadores), `cluster.test.ts` (3 instancias) |
| Retry e DLQ | `sqs-consumer.test.ts` (backoff, redrive apos maxReceiveCount, DLQ imediata) |
| Recuperacao apos reinicializacao | `cluster.test.ts` (3 instancias mortas por SIGKILL no meio do fluxo) |
| 1. Mesma aposta 50x em paralelo | `concurrency.test.ts` (um processo), `cluster.test.ts` (espalhada em 3 processos) |
| 2. Disputa pelo saldo da mesma wallet | `concurrency.test.ts`, `cluster.test.ts` (cenario 100 / 80 / 80) |
| 3. Wallets distintas em paralelo | `concurrency.test.ts`, `cluster.test.ts` |
| 4. 3 ou mais instancias simultaneas | `cluster.test.ts` |
| 5. Worker morto depois do commit e antes do ack | `sqs-consumer.test.ts` (simulado), `cluster.test.ts` (SIGKILL real) |
| 6. Dois publishers na mesma outbox | `outbox-and-references.test.ts` |
| 7. ROLLBACK/REFUND antes da referencia | `wagering.test.ts`, `outbox-and-references.test.ts` |
| 8. Reinicio com consistencia final | `cluster.test.ts` |

Todos os testes de integracao terminam conferindo `wallet.balance == saldo reconstruido pelo ledger`
(`expectLedgerConsistent`).

## API

| Metodo | Rota | |
|---|---|---|
| `POST` | `/wallets` | cria wallet (saldo inicial vira OPENING + credito no ledger) |
| `GET` | `/wallets/:walletId` | saldo e versao |
| `GET` | `/wallets/:walletId/ledger?cursor=&limit=50` | lancamentos, cursor opaco |
| `POST` | `/wallets/:walletId/reconciliation` | saldo armazenado x reconstruido pelo ledger |
| `POST` | `/wagering/transactions` | submete BET/WIN/LOSS/REFUND/ROLLBACK; header `Idempotency-Key` obrigatorio |
| `GET` | `/wagering/transactions/:transactionId` | por id interno |
| `GET` | `/providers/:providerId/wagering/transactions/:externalTransactionId` | por id do provedor |
| `GET` | `/health/live`, `/health/ready` | sem autenticacao |
| `GET` | `/metrics` | Prometheus; sem autenticacao |

Status por situacao (201, 200 replay, 202, 400, 404, 409, 422, 503) em [`ARCHITECTURE.md`](ARCHITECTURE.md#api-http-status).

```bash
curl -X POST localhost:3000/wallets -H 'content-type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'
```

## Filas e workers

| Fila | Papel |
|---|---|
| `wager-transactions.fifo` | entrada de `WagerTransactionRequested` (`MessageGroupId` = walletId) |
| `wager-transactions-dlq.fifo` | mensagens invalidas ou que esgotaram as tentativas (`maxReceiveCount` = 5) |
| `wager-events.fifo` | eventos de integracao publicados pela outbox |

`bun run start` sobe a API e os workers (`consumer`, `outbox`, `references`). Para separar papeis entre instancias:
`WORKERS=consumer,outbox` ou `WORKERS=none`.

Enviar uma transacao pela fila, como um provedor:

```bash
bun run sqs:send -- <walletId> <playerId> BET 25.00
```

| Variavel | Padrao | |
|---|---|---|
| `DATABASE_URL` | `postgres://wagering:wagering@localhost:55432/wagering` | |
| `SQS_ENDPOINT` | `http://localhost:4566` | MiniStack |
| `WORKERS` | `consumer,outbox,references` | `none` desliga |
| `SQS_CONSUMERS` | `2` | loops de long polling por instancia |
| `LOCK_TIMEOUT_MS` | `5000` | espera pelo lock da wallet antes de 503 |
| `OUTBOX_LEASE_MS` | `30000` | prazo para um publicador concluir o lote |

O SQS e emulado pelo [MiniStack](https://ministack.org), compativel com a API do LocalStack:
o SQS do LocalStack Community passou para o plano pago.
