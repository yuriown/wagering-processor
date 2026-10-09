import type { BackoffPolicy } from "../shared/backoff";
import { InvariantViolationError } from "../shared/domain-error";
import { LedgerDirection } from "../wallet/ledger-direction";
import type { Wallet } from "../wallet/wallet";
import type { WalletLedgerEntry } from "../wallet/wallet-ledger-entry";
import { FailureCode } from "./failure-code";
import { InvalidTransactionStateError, type WagerTransaction, WagerTransactionStatus } from "./wager-transaction";

/**
 * Espera por referencia ausente: 8 verificacoes com atraso 5s, 10s, 20s ... ate 5 min,
 * somando ~15 min. Cobre reordenacao e atraso normais de fila sem deixar
 * a transacao pendurada por horas.
 */
export const REFERENCE_RETRY_POLICY: BackoffPolicy = { baseMs: 5_000, maxMs: 300_000 };
export const REFERENCE_MAX_ATTEMPTS = 8;

export interface SettlementInput {
  transaction: WagerTransaction;
  /** Wallet da transacao, ja travada pelo chamador para esta unidade de trabalho. */
  wallet: Wallet;
  /** Resolvida por (providerId, referenceExternalTransactionId); undefined se ainda nao chegou. */
  reference: WagerTransaction | undefined;
  /** Ja existe REFUND/ROLLBACK PROCESSED apontando para a referencia? */
  referenceAlreadyReversed: boolean;
  /** Id para o lancamento, caso a operacao mova saldo. */
  entryId: string;
  at: Date;
  referenceRetryPolicy?: BackoffPolicy;
}

export type SettlementResult =
  | { status: WagerTransactionStatus.Processed; entry: WalletLedgerEntry | undefined }
  | { status: WagerTransactionStatus.Rejected; failureCode: FailureCode }
  | { status: WagerTransactionStatus.PendingReference };

/**
 * Aplica uma transacao PENDING (ou PENDING_REFERENCE) a wallet. Muta a transacao
 * e a wallet, e devolve o lancamento quando o saldo muda. Rejeicao nunca toca o saldo.
 */
export function settleWagerTransaction(input: SettlementInput): SettlementResult {
  const { transaction, wallet, at } = input;
  // Antes de qualquer mutacao: senao a wallet seria debitada e so depois a transicao falharia.
  if (transaction.isTerminal()) {
    throw new InvalidTransactionStateError(`transacao ${transaction.id} ja esta ${transaction.status}; nao se liquida de novo`);
  }
  if (transaction.walletId !== wallet.id) {
    throw new InvariantViolationError(`transacao ${transaction.id} nao pertence a wallet ${wallet.id}`);
  }

  const reject = (failureCode: FailureCode): SettlementResult => {
    transaction.reject(failureCode, wallet.balance, at);
    return { status: WagerTransactionStatus.Rejected, failureCode };
  };

  if (transaction.playerId !== wallet.playerId) {
    return reject(FailureCode.WalletPlayerMismatch);
  }
  if (transaction.money.currency !== wallet.currency) {
    return reject(FailureCode.CurrencyMismatch);
  }

  const reference = input.reference;
  if (transaction.referenceExternalTransactionId !== undefined) {
    if (reference === undefined || !reference.isTerminal()) {
      // Ausente, ou ela propria ainda esperando: volta a verificar depois.
      transaction.markPendingReference(at, input.referenceRetryPolicy ?? REFERENCE_RETRY_POLICY);
      return { status: WagerTransactionStatus.PendingReference };
    }
    const failure = referenceFailure(transaction, reference, input.referenceAlreadyReversed);
    if (failure !== undefined) {
      return reject(failure);
    }
  }

  const referenceTransactionId = reference?.id;
  if (!transaction.affectsBalance()) {
    transaction.markProcessed({ referenceTransactionId, observedBalance: wallet.balance, at });
    return { status: WagerTransactionStatus.Processed, entry: undefined };
  }

  const direction = transaction.ledgerDirectionFor(reference);
  const movement = { entryId: input.entryId, transactionId: transaction.id, money: transaction.money, at };
  if (direction === LedgerDirection.Debit && !wallet.canDebit(transaction.money)) {
    // Aposta sem saldo e reversao de credito ja gasto sao situacoes operacionais diferentes.
    return reject(transaction.isReversal() ? FailureCode.ReversalWouldOverdraw : FailureCode.InsufficientFunds);
  }
  const entry = direction === LedgerDirection.Debit ? wallet.debit(movement) : wallet.credit(movement);
  transaction.markProcessed({ referenceTransactionId, observedBalance: wallet.balance, at });
  return { status: WagerTransactionStatus.Processed, entry };
}

/** Esgotou o prazo de espera pela referencia: REJECTED com REFERENCE_NOT_FOUND. */
export function expirePendingReference(transaction: WagerTransaction, wallet: Wallet, at: Date): void {
  transaction.reject(FailureCode.ReferenceNotFound, wallet.balance, at);
}

function referenceFailure(
  transaction: WagerTransaction,
  reference: WagerTransaction,
  alreadyReversed: boolean,
): FailureCode | undefined {
  if (reference.status !== WagerTransactionStatus.Processed) {
    return FailureCode.ReferenceNotProcessed;
  }
  const sameContext =
    reference.providerId === transaction.providerId &&
    reference.playerId === transaction.playerId &&
    reference.walletId === transaction.walletId &&
    reference.money.currency === transaction.money.currency &&
    reference.roundId === transaction.roundId;
  if (!sameContext) {
    return FailureCode.ReferenceMismatch;
  }
  if (!reference.canBeReferencedBy(transaction.kind)) {
    return FailureCode.InvalidReferenceKind;
  }
  if (transaction.isReversal()) {
    if (!reference.money.equals(transaction.money)) {
      return FailureCode.AmountMismatch;
    }
    if (alreadyReversed) {
      return FailureCode.ReferenceAlreadyReversed;
    }
  }
  return undefined;
}
