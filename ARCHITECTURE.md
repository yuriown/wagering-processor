# Arquitetura

Documento vivo: cada fase acrescenta as decisoes que tomou. Secoes marcadas *(a fazer)* ainda nao foram implementadas.

## Camadas

```
src/
  domain/          regras puras: sem NestJS, sem ORM, sem relogio, sem I/O
  application/     casos de uso; orquestram dominio e portas        (a fazer)
  infrastructure/  MikroORM, SQS, metricas: implementam as portas    (a fazer)
  interfaces/      HTTP (controllers) e SQS (consumer)
```

O dominio recebe ids e horario de fora (`at: Date`, `entryId`, `eventId`). Isso o torna deterministico:
os testes de unidade nao precisam de relogio falso nem de mock.

## Money

- Valor guardado em **`bigint` de centavos**, moeda em ISO-4217. Com escala fixa de 2 casas a representacao e exata;
  `number` nunca participa da conta (o TypeScript recusa misturar `bigint` com `number`).
- Preferido a `decimal.js` porque a escala e fixa: nao ha divisao nem arredondamento no dominio, entao um decimal
  de precisao arbitraria seria dependencia sem uso. Se um dia houver moeda com outra escala (JPY, BHD), a escala
  passa a ser por moeda e a troca fica contida em `Money`.
- Entrada (`Money.from`) aceita `^(0|[1-9]\d{0,17})(\.\d{1,2})?$`: recusa `""`, `NaN`, `Infinity`, notacao
  cientifica, sinal, zero a esquerda, mais de 2 casas e mais de 18 digitos inteiros (o limite de `numeric(20,2)`).
  Menos de 2 casas e aceito e normalizado (`"25.5"` vira `"25.50"`).
- Saida sempre com 2 casas. Valor negativo so existe internamente (`subtract`, `negate`); nunca vem de contrato.
- Operacao entre moedas diferentes lanca `CurrencyMismatchError`.

## Wallet e ledger

- O saldo so muda por `Wallet.debit`/`credit`, e cada chamada **devolve o lancamento** do ledger. Nao ha caminho
  que mude saldo sem lancamento, nem lancamento sem mudar saldo.
- `version` comeca em 1 (abertura, inclusive com o credito OPENING) e sobe 1 por lancamento. O lancamento guarda a
  `walletVersion` que produziu: no banco, `UNIQUE (wallet_id, wallet_version)` transforma o ledger numa corrente
  sem buracos nem duplicatas.
- `WalletLedgerEntry` e estruturalmente imutavel: campos `readonly`, instancia congelada, sem metodo de transicao.
  `create` valida `balanceBefore +/- money == balanceAfter`, valor positivo e saldo nao negativo.
- LOSS e transacoes REJECTED nao geram lancamento.

## WagerTransaction: estados

```
PENDING ──────────► PROCESSED | REJECTED | FAILED
PENDING ──────────► PENDING_REFERENCE
PENDING_REFERENCE ► PENDING_REFERENCE (nova tentativa) | PROCESSED | REJECTED | FAILED
```

PROCESSED, REJECTED e FAILED sao terminais. Tentar transicionar a partir deles lanca `InvalidTransactionStateError`
(erro de programacao, nao de negocio). A liquidacao recusa transacao terminal **antes** de tocar a wallet:
um teste pegou o caso em que a wallet era debitada e so depois a transicao falhava.

A transacao guarda o **saldo observado** na decisao (`observedBalance`). E o que o replay devolve (regra 7),
em vez do saldo atual.

## Regras de negocio

| Operacao | Saldo | Referencia |
|---|---|---|
| BET | debito | nao aceita |
| WIN | credito | opcional, so BET da mesma rodada; valor livre |
| LOSS | nenhum | opcional, so BET; valor pode ser zero |
| REFUND | credito | obrigatoria, so BET, mesmo valor |
| ROLLBACK | inverso da referencia | obrigatoria: BET, WIN ou REFUND, mesmo valor |

A referencia e resolvida por `(providerId, referenceExternalTransactionId)` e precisa ter o mesmo provider,
player, wallet, moeda e rodada.

### Interpretacoes adotadas

- **Uma reversao por referencia, de qualquer tipo.** O enunciado proibe reverter duas vezes "pelo mesmo tipo".
  Seguido a letra, uma BET poderia receber um REFUND e tambem um ROLLBACK, creditando o valor duas vezes.
  Adotei a leitura mais estrita: a BET aceita um unico REFUND **ou** ROLLBACK. Desfazer um REFUND continua possivel
  com um ROLLBACK que referencia o REFUND (outra referencia).
- **Referencia que ainda esta esperando** (ela propria PENDING_REFERENCE) mantem a dependente em espera.
  Referencia REJECTED ou FAILED rejeita a dependente com `REFERENCE_NOT_PROCESSED`.
- **Valor da operacao**: positivo em tudo, exceto LOSS, que pode registrar zero.

### Referencia fora de ordem

Ate 8 verificacoes com atraso de 5s, 10s, 20s ... limitado a 5 min (~15 min no total). Cobre reordenacao e
atraso normais de fila sem deixar a transacao pendurada por horas. Esgotado o limite: REJECTED com
`REFERENCE_NOT_FOUND`. Backoff sem jitter no dominio: quem espalha instancias concorrentes e o `SKIP LOCKED`.

## Codigos de falha

| Codigo | Acao do provedor | Quando |
|---|---|---|
| `INSUFFICIENT_FUNDS` | nova transacao | BET maior que o saldo |
| `REVERSAL_WOULD_OVERDRAW` | desistir | ROLLBACK de credito ja gasto (saldo ficaria negativo) |
| `REFERENCE_NOT_FOUND` | corrigir | referencia nao chegou no prazo |
| `REFERENCE_NOT_PROCESSED` | desistir | referencia foi rejeitada ou falhou |
| `REFERENCE_MISMATCH` | corrigir | referencia de outro player, wallet, moeda ou rodada |
| `INVALID_REFERENCE_KIND` | corrigir | tipo de referencia nao permitido |
| `REFERENCE_ALREADY_REVERSED` | desistir | referencia ja revertida |
| `AMOUNT_MISMATCH` | corrigir | reversao com valor diferente da referencia |
| `CURRENCY_MISMATCH` | corrigir | moeda diferente da wallet |
| `WALLET_PLAYER_MISMATCH` | corrigir | wallet de outro player |
| `PROCESSING_FAILED` | desistir | erro permanente de infraestrutura (FAILED) |

Toda rejeicao e terminal para aquela idempotency key: reenviar devolve a mesma rejeicao. "Nova transacao"
e "corrigir" significam enviar outra operacao, com outro `externalTransactionId`.

## Idempotencia: payloadHash

`payloadHash = SHA-256 (hex minusculo)` do **JSON canonico** dos campos de negocio:
`providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money`
e `referenceExternalTransactionId` (se houver).

- Chaves ordenadas por code unit, sem espacos, campos ausentes omitidos.
- `money` passa por `Money` antes, entao `"25.5"` e `"25.50"` sao a mesma operacao.
- Header `Idempotency-Key`, `messageId` e outros metadados de transporte ficam fora.

Mesma key com hash diferente e conflito, nunca replay.

## Eventos

Envelope abstrato `IntegrationEvent<T>` com `eventType` e `version` fixos em cada subclasse:
`WagerTransactionProcessed` (inclusive LOSS), `WagerTransactionRejected`, `WagerTransactionPendingReference`
e `WalletBalanceChanged` (so quando o saldo muda). `data` leva `MoneyProps`, nunca `Money`.

`aggregateId` e a **walletId** em todos: e a unidade de concorrencia e sera o `MessageGroupId` dos eventos
publicados, preservando a ordem por wallet. `OutboxMessage.id` = `eventId`, para o consumidor deduplicar,
ja que a outbox publica pelo menos uma vez.

## A fazer nas proximas fases

- Schema, constraints e migrations (fase 2).
- Estrategia transacional e de lock (fase 3).
- Consumer SQS, outbox e workers (fase 4).
- Autenticacao: nao implementada; desenho e ponto de extensao (fase 3).
