# Resultado do teste de carga

Gerado por `bun run test:load` em 2026-10-08T22:43:52.459Z. Metodologia e analise em [load-test.md](load-test.md).

## Ambiente

| | |
|---|---|
| CPU | 13th Gen Intel(R) Core(TM) i5-1334U (12 threads) |
| Memoria | 15.7 GiB |
| Sistema | win32 10.0.26200 |
| Bun | 1.4.2 |
| Banco | PostgreSQL 17.11 (container local) |
| SQS | MiniStack (container local) |
| Parametros | DURATION_S=20, VUS=48, HOT_VUS=16, INSTANCES=3, WALLETS=300, SQS_MESSAGES=2000, SQS_WALLETS=100, DB_POOL_MAX=10 |

## HTTP (latencia medida no cliente, VUs em laco fechado)

| Cenario | Requisicoes | Vazao | p50 | p95 | p99 | max | Erros (5xx/rede) | Status |
|---|---|---|---|---|---|---|---|---|
| HTTP, wallets distribuidas | 1900 | 93 req/s | 489.3 ms | 914.1 ms | 1189.9 ms | 1516.6 ms | 0.00% | 200: 105, 201: 1795 |
| HTTP, wallet quente (1 wallet) | 816 | 40 req/s | 439.1 ms | 590.7 ms | 637.5 ms | 722.1 ms | 0.00% | 200: 46, 201: 770 |

## SQS (2000 mensagens em 100 wallets)

| | |
|---|---|
| Tempo para enfileirar | 8.3 s |
| Tempo ate todas processadas | 34.5 s |
| Vazao de consumo | 58 msg/s |
| Latencia envio -> commit (p50 / p95 / p99) | 19103.0 ms / 33088.0 ms / 34094.0 ms |
| Retries / DLQ | 0 / 0 |

## Conflitos de concorrencia

| | |
|---|---|
| Aquisicoes de lock de wallet | 4703 |
| Espera media pelo lock (tudo) | 81.2 ms |
| Espera p95 pelo lock, wallets distribuidas | 100.0 ms |
| Espera media pelo lock, wallet quente | 378.4 ms |
| Lock timeouts (503) | 0 |
| Corridas em indice unico tentadas de novo | 0 |
| Duplicatas detectadas (replay) | 152 |

## Outbox

| | |
|---|---|
| Eventos gravados | 9986 |
| Lag maximo durante a carga | 5.92 s |
| Lag p95 das amostras | 4.03 s |
| Pendentes no pico | 802 |
| Tempo para zerar apos a carga | 0.0 s |

## Invariantes ao final

| | |
|---|---|
| Wallets | 301 |
| Saldo negativo | 0 |
| Saldo diferente do ledger | 0 |
| Transacao com mais de um lancamento | 0 |
| Transacoes / lancamentos | 4692 / 4993 |
