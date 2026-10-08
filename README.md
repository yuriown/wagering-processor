# Distributed Wagering Processor

Servico financeiro que processa transacoes de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`)
vindas de varios provedores, por HTTP e por SQS, mantendo saldo, ledger, inbox e outbox consistentes
mesmo com mensagens duplicadas, fora de ordem e varias instancias concorrentes.

Decisoes, trade-offs e limitacoes: [`ARCHITECTURE.md`](ARCHITECTURE.md) (em construcao).

## Requisitos

- [Bun](https://bun.sh) 1.4+
- Docker com Compose v2

## Subindo

```bash
bun install
bun run infra:up   # PostgreSQL (porta 55432) + MiniStack/SQS (porta 4566) + criacao das filas
bun run start      # API em http://localhost:3000
```

`bun run infra:down` derruba tudo e apaga os volumes.

## Testes

```bash
bun run typecheck
bun test           # exige a infraestrutura de pe: integracao usa Postgres e SQS reais
```

## Filas

| Fila | Papel |
|---|---|
| `wager-transactions.fifo` | entrada de `WagerTransactionRequested` |
| `wager-transactions-dlq.fifo` | mensagens que esgotaram as tentativas (`maxReceiveCount` = 5) |

O SQS e emulado pelo [MiniStack](https://ministack.org), compativel com a API do LocalStack:
o SQS do LocalStack Community passou para o plano pago.
