# Teste de carga

```bash
bun run infra:up
bun run test:load
```

O resultado bruto da ultima execucao fica em [`load-test-results.md`](load-test-results.md). Este documento descreve o
metodo, compara tres rodadas e diz o que os numeros permitem e o que nao permitem concluir.

## Ambiente

| | |
|---|---|
| Maquina | notebook, Intel Core i5-1334U (10 nucleos, 12 threads), 15,7 GiB |
| Sistema | Windows 11 (Docker Desktop com WSL2) |
| Runtime | Bun 1.4.2 |
| Banco | PostgreSQL 17.11 em container, configuracao padrao da imagem |
| SQS | MiniStack em container |

**Tudo na mesma maquina**: banco, emulador de SQS, as 3 instancias da aplicacao e o gerador de carga disputam os
mesmos 12 threads. Os numeros medem esta montagem, nao uma capacidade de producao.

## Metodo

`scripts/load-test.ts` e autocontido. Cria um banco e filas proprios, aplica as migrations e sobe **3 instancias da
aplicacao como processos separados**, cada uma com API e todos os workers (consumidor SQS, relay da outbox, worker de
referencias). Depois roda, em sequencia:

1. **Aquecimento**: 3 s com 8 usuarios virtuais, descartado.
2. **HTTP com wallets distribuidas**: 48 usuarios virtuais em laco fechado (cada um manda a proxima requisicao assim
   que a anterior volta), por 20 s, em 300 wallets, alternando entre as 3 instancias. Mistura de 70% BET e 30% WIN,
   e 5% de reenvios de operacoes ja enviadas, para exercitar o replay sob carga.
3. **HTTP numa unica wallet** (wallet quente): 16 usuarios virtuais, 20 s. E o pior caso do lock por wallet.
4. **SQS**: 2.000 mensagens em 100 wallets (grupos FIFO), enfileiradas em rajada; mede ate a ultima ser confirmada.
5. Durante tudo, o **lag da outbox** e amostrado no banco a cada 500 ms. Depois da carga, mede quanto tempo a outbox
   leva para zerar.

A latencia HTTP e medida **no cliente** (inclui rede local, Express, Nest e banco). Contencao e retries vem do
`/metrics` das 3 instancias (somados). No fim, o script confere os invariantes no banco: nenhum saldo negativo, saldo
igual ao ledger em todas as wallets e nenhuma transacao com mais de um lancamento. Se algum falhar, o processo sai com
erro.

Parametros ajustaveis: `LOAD_DURATION_S`, `LOAD_VUS`, `LOAD_HOT_VUS`, `LOAD_INSTANCES`, `LOAD_WALLETS`,
`LOAD_SQS_MESSAGES`, `LOAD_SQS_WALLETS`, `LOAD_DB_POOL_MAX`.

## Resultados

Tres rodadas com os mesmos parametros:

- **A, linha de base**: o codigo como estava ao fim da fase 7.
- **B, otimizada**: depois das duas mudancas descritas abaixo, guiadas pela rodada A.
- **C, pool 20**: igual a B, com 20 conexoes por instancia em vez de 10, para testar uma hipotese.

| Metrica | A (base) | **B (otimizada)** | C (pool 20) |
|---|---|---|---|
| HTTP distribuido: vazao | 94 req/s | **93 req/s** | 99 req/s |
| HTTP distribuido: p50 / p95 / p99 | 477 / 917 / 1217 ms | **489 / 914 / 1190 ms** | 451 / 984 / 1339 ms |
| HTTP distribuido: erros | 0% | **0%** | 0,10% (2 falhas de rede) |
| Wallet quente: vazao | 27 req/s | **40 req/s** | 35 req/s |
| Wallet quente: p50 / p99 | 601 / 827 ms | **439 / 638 ms** | 461 / 1956 ms |
| Espera media pelo lock, wallet quente | 556 ms | **378 ms** | 429 ms |
| Espera p95 pelo lock, wallets distribuidas | 100 ms | **100 ms** | 250 ms |
| Lock timeouts (503) / corridas em indice unico | 0 / 0 | **0 / 0** | 0 / 0 |
| Duplicatas detectadas (replay) | 112 | **152** | 159 |
| SQS: vazao de consumo | 70 msg/s | **58 msg/s** | 40 msg/s |
| SQS: retries / DLQ | 0 / 0 | **0 / 0** | 0 / 0 |
| Outbox: lag maximo / p95 | 17,9 / 17,6 s | **5,9 / 4,0 s** | 6,7 / 6,1 s |
| Outbox: pendentes no pico | 3.119 | **802** | 1.316 |
| Outbox: tempo para zerar apos a carga | 16,6 s | **0 s** | 0 s |
| Invariantes (negativo / divergente / lancamento duplicado) | 0 / 0 / 0 | **0 / 0 / 0** | 0 / 0 / 0 |

Durante a rodada B, uma amostra de `docker stats` mostrou o **Postgres em 112% de CPU** e o MiniStack em 46%, com as 3
instancias e o gerador de carga rodando ao lado.

## O que mudou entre A e B

A rodada A apontou dois gargalos.

**1. Outbox atrasando ate 18 s.** O relay marcava cada evento publicado com um `UPDATE` proprio (50 por lote) e
enviava os blocos de 10 ao SQS em sequencia. Agora o lote inteiro e marcado num unico `UPDATE ... WHERE id IN (...)`
(continua exigindo que o lease seja do mesmo dono) e os blocos saem em paralelo. Resultado: lag maximo de 17,9 s para
5,9 s, e a outbox zera junto com o fim da carga em vez de 16 s depois.

**2. Round-trips com o lock da wallet na mao.** Na wallet quente, a vazao e `1 / tempo com o lock`: 27 req/s significa
cerca de 37 ms por transacao com a linha travada. Duas idas ao banco sairam desse trecho:

- as buscas pela idempotency key e pela operacao do provedor viraram **uma** consulta (`WHERE provider_id = ? AND
  (idempotency_key = ? OR external_transaction_id = ?)`);
- a antecipacao das pendencias que esperavam por esta operacao saiu de dentro da transacao para **depois do COMMIT**.
  E so uma otimizacao: se falhar, o worker acha a pendencia pelo agendamento.

Resultado: wallet quente de 27 para 40 req/s (+48%), com a espera media pelo lock caindo de 556 para 378 ms. A suite
inteira (270 testes) continuou verde depois das duas mudancas.

## Analise

**O teto da wallet quente e intencional.** Operacoes da mesma wallet sao serializadas pelo `SELECT ... FOR UPDATE`, que
e o que impede lost update e saldo negativo. O limite e `1 / tempo com o lock` e nao cresce com mais instancias. Com
40 req/s, uma unica wallet aguenta cerca de 2.400 operacoes por minuto, muito acima do ritmo de um jogador humano. Para
ir alem disso seria preciso encurtar a transacao (menos round-trips, triggers deferred mais baratas) ou mudar o
modelo (por exemplo, sub-saldos por wallet), sempre com o mesmo controle de concorrencia.

**Com wallets distribuidas, o gargalo e a CPU da maquina, nao o lock.** Com 300 wallets e 48 usuarios, quase nunca duas
requisicoes disputam a mesma wallet. Mesmo assim a espera p95 pelo `FOR UPDATE` foi de 100 ms, porque a consulta
espera na fila de um Postgres em 112% de CPU. A rodada C confirma: dobrar o pool nao aumentou a vazao (93 para 99
req/s, dentro do ruido), piorou a cauda (p99 de 1,2 para 1,3 s; espera p95 pelo lock de 100 para 250 ms), derrubou a
vazao do SQS e trouxe as primeiras falhas de rede. Mais conexoes so aumentam a disputa por um banco que ja esta sem
CPU. O padrao ficou em 10.

**SQS.** A vazao de consumo (40 a 70 msg/s) variou entre rodadas mais do que o codigo do consumidor mudou: o
consumidor disputa a mesma CPU com o relay da outbox, que na rodada B passou a trabalhar mais rapido. A latencia
"envio -> commit" (p50 de 15 a 30 s) e quase toda **fila**: 2.000 mensagens chegam em rajada em ~8 s e sao consumidas a
~60 msg/s. Ela mede o backlog, nao o tempo de processar uma mensagem, que fica na metrica `sqs_processing_seconds`.

**Correcao sob carga.** Em todas as rodadas: zero saldo negativo, zero divergencia entre saldo e ledger, zero
lancamento duplicado, zero lock timeout, zero mensagem na DLQ, e todos os reenvios responderam replay.

## Limitacoes do experimento

- **Uma maquina so.** Cliente, aplicacao, banco e emulador competem por CPU. Com o banco em maquina propria, a vazao
  distribuida subiria. Quanto, este teste nao mede.
- **Windows e Docker com WSL2** acrescentam latencia de rede entre a aplicacao e os containers. Linux nativo seria mais
  rapido.
- **MiniStack nao e o SQS.** Vazao, latencia e limites do SQS real sao outros.
- **Postgres com configuracao padrao.** Nada de `shared_buffers`, `synchronous_commit` ou `wal_*` foi ajustado.
- **Rodadas curtas (20 s) e uma execucao por configuracao.** Diferencas abaixo de ~10% (como 93 contra 99 req/s)
  estao dentro do ruido. As conclusoes acima se apoiam so em diferencas grandes (27 para 40 req/s; 18 s para 6 s de
  lag) ou em direcoes consistentes (pool 20 piorando a cauda em todos os cenarios).
- **Laco fechado** mede vazao maxima com N clientes, nao latencia sob uma taxa fixa de chegada. Um teste em laco aberto
  (taxa constante) mostraria a latencia antes da saturacao.
