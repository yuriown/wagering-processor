# Distributed Wagering Processor

Servico financeiro que processa transacoes de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`)
vindas de varios provedores, por HTTP e por SQS, mantendo saldo, ledger, inbox e outbox consistentes
mesmo com mensagens duplicadas, fora de ordem e varias instancias concorrentes.

Decisoes, trade-offs e limitacoes: [`ARCHITECTURE.md`](ARCHITECTURE.md).

## Requisitos

- [Bun](https://bun.sh) 1.4+
- Docker com Compose v2

## Subindo

```bash
bun install
bun run infra:up   # PostgreSQL (porta 55432) + MiniStack/SQS (porta 4566) + criacao das filas
bun run db:migrate # aplica as migrations
bun run start      # API em http://localhost:3000
```

Migrations: `bun run db:status`, `bun run db:rollback` (desfaz a ultima), `bun run db:rollback -- --all`.

`bun run infra:down` derruba tudo e apaga os volumes.

## Testes

```bash
bun run typecheck
bun run test:unit  # so dominio, sem infraestrutura
bun test           # tudo; exige a infraestrutura de pe: integracao usa Postgres e SQS reais
                   # (cada arquivo de integracao cria e apaga o proprio banco)
```

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

Status por situacao (201, 200 replay, 202, 400, 404, 409, 422, 503) em [`ARCHITECTURE.md`](ARCHITECTURE.md#api-http-status).

```bash
curl -X POST localhost:3000/wallets -H 'content-type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'
```

## Filas

| Fila | Papel |
|---|---|
| `wager-transactions.fifo` | entrada de `WagerTransactionRequested` |
| `wager-transactions-dlq.fifo` | mensagens que esgotaram as tentativas (`maxReceiveCount` = 5) |

O SQS e emulado pelo [MiniStack](https://ministack.org), compativel com a API do LocalStack:
o SQS do LocalStack Community passou para o plano pago.
