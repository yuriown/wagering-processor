#!/bin/sh
# Cria wager-transactions.fifo com redrive para wager-transactions-dlq.fifo.
# Idempotente: CreateQueue com os mesmos atributos devolve a fila existente.
set -eu

aws_sqs() {
  aws --endpoint-url "$SQS_ENDPOINT" sqs "$@"
}

tries=0
until aws_sqs list-queues >/dev/null 2>&1; do
  tries=$((tries + 1))
  if [ "$tries" -ge 60 ]; then
    echo "SQS nao respondeu em $SQS_ENDPOINT" >&2
    exit 1
  fi
  sleep 1
done

dlq_url=$(aws_sqs create-queue \
  --queue-name wager-transactions-dlq.fifo \
  --attributes FifoQueue=true \
  --query QueueUrl --output text)

dlq_arn=$(aws_sqs get-queue-attributes \
  --queue-url "$dlq_url" \
  --attribute-names QueueArn \
  --query Attributes.QueueArn --output text)

cat > /tmp/attributes.json <<EOF
{
  "FifoQueue": "true",
  "VisibilityTimeout": "30",
  "RedrivePolicy": "{\"deadLetterTargetArn\":\"$dlq_arn\",\"maxReceiveCount\":\"$MAX_RECEIVE_COUNT\"}"
}
EOF

aws_sqs create-queue \
  --queue-name wager-transactions.fifo \
  --attributes file:///tmp/attributes.json \
  --query QueueUrl --output text

# Eventos de integracao publicados pela outbox (WagerTransactionProcessed, WalletBalanceChanged...).
aws_sqs create-queue \
  --queue-name wager-events.fifo \
  --attributes FifoQueue=true \
  --query QueueUrl --output text

echo "filas prontas"
