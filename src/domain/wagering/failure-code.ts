/**
 * Motivo estavel, legivel por maquina, de uma transacao REJECTED ou FAILED.
 * O provedor decide pelo codigo, nunca pela mensagem.
 */
export enum FailureCode {
  InsufficientFunds = "INSUFFICIENT_FUNDS",
  ReversalWouldOverdraw = "REVERSAL_WOULD_OVERDRAW",
  ReferenceNotFound = "REFERENCE_NOT_FOUND",
  ReferenceNotProcessed = "REFERENCE_NOT_PROCESSED",
  ReferenceMismatch = "REFERENCE_MISMATCH",
  InvalidReferenceKind = "INVALID_REFERENCE_KIND",
  ReferenceAlreadyReversed = "REFERENCE_ALREADY_REVERSED",
  AmountMismatch = "AMOUNT_MISMATCH",
  CurrencyMismatch = "CURRENCY_MISMATCH",
  WalletPlayerMismatch = "WALLET_PLAYER_MISMATCH",
  ProcessingFailed = "PROCESSING_FAILED",
}

/**
 * O que o provedor deve fazer. Toda rejeicao e terminal para aquela
 * idempotency key: reenviar a mesma key devolve a mesma rejeicao (replay).
 * - NEW_TRANSACTION: a situacao pode mudar; uma transacao nova (outra key) pode passar.
 * - FIX_PAYLOAD: o pedido esta errado; corrigir e enviar como transacao nova.
 * - GIVE_UP: nao ha o que fazer; registrar e encerrar.
 */
export type ProviderAction = "NEW_TRANSACTION" | "FIX_PAYLOAD" | "GIVE_UP";

export const FAILURE_CODES: Readonly<Record<FailureCode, { action: ProviderAction; description: string }>> = {
  [FailureCode.InsufficientFunds]: {
    action: "NEW_TRANSACTION",
    description: "BET maior que o saldo disponivel",
  },
  [FailureCode.ReversalWouldOverdraw]: {
    action: "GIVE_UP",
    description: "ROLLBACK de credito ja gasto: reverter deixaria o saldo negativo; exige tratamento operacional",
  },
  [FailureCode.ReferenceNotFound]: {
    action: "FIX_PAYLOAD",
    description: "a transacao referenciada nao chegou dentro do prazo de espera",
  },
  [FailureCode.ReferenceNotProcessed]: {
    action: "GIVE_UP",
    description: "a transacao referenciada foi rejeitada ou falhou; nao ha o que reverter",
  },
  [FailureCode.ReferenceMismatch]: {
    action: "FIX_PAYLOAD",
    description: "a referencia pertence a outro player, wallet, moeda ou rodada",
  },
  [FailureCode.InvalidReferenceKind]: {
    action: "FIX_PAYLOAD",
    description: "tipo de referencia invalido (REFUND so referencia BET; ROLLBACK referencia BET, WIN ou REFUND)",
  },
  [FailureCode.ReferenceAlreadyReversed]: {
    action: "GIVE_UP",
    description: "a referencia ja foi revertida por outra transacao",
  },
  [FailureCode.AmountMismatch]: {
    action: "FIX_PAYLOAD",
    description: "valor da reversao difere do valor da referencia (reversao parcial nao e suportada)",
  },
  [FailureCode.CurrencyMismatch]: {
    action: "FIX_PAYLOAD",
    description: "moeda da operacao difere da moeda da wallet",
  },
  [FailureCode.WalletPlayerMismatch]: {
    action: "FIX_PAYLOAD",
    description: "a wallet informada pertence a outro player",
  },
  [FailureCode.ProcessingFailed]: {
    action: "GIVE_UP",
    description: "erro permanente de infraestrutura; transacao marcada FAILED para auditoria",
  },
};
