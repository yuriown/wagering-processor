import { Money } from "../money";
import { InvariantViolationError, assertNonEmpty } from "../shared/domain-error";
import { LedgerDirection } from "./ledger-direction";

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  /** Versao da wallet produzida por este lancamento: forma uma corrente sem buracos por wallet. */
  walletVersion: number;
  createdAt: Date;
}

export type CreateLedgerEntryProps = LedgerEntryState;

/**
 * Lancamento imutavel: todos os campos sao readonly, a instancia e congelada
 * e nao existe metodo de transicao. Corrigir um erro e lancar outro, nunca editar.
 */
export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly walletVersion: number,
    public readonly createdAt: Date,
  ) {
    Object.freeze(this);
  }

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    assertNonEmpty(props.id, "id");
    assertNonEmpty(props.walletId, "walletId");
    assertNonEmpty(props.transactionId, "transactionId");
    if (!props.money.isPositive()) {
      throw new InvariantViolationError("lancamento precisa de valor positivo");
    }
    if (props.balanceBefore.isNegative() || props.balanceAfter.isNegative()) {
      throw new InvariantViolationError("lancamento nao pode partir de nem levar a saldo negativo");
    }
    if (!Number.isInteger(props.walletVersion) || props.walletVersion < 1) {
      throw new InvariantViolationError("walletVersion deve ser inteiro >= 1");
    }
    const entry = WalletLedgerEntry.rehydrate(props);
    if (!entry.isBalanced()) {
      throw new InvariantViolationError(
        `lancamento desbalanceado: ${props.balanceBefore} ${props.direction} ${props.money} != ${props.balanceAfter}`,
      );
    }
    return entry;
  }

  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.walletVersion,
      new Date(state.createdAt),
    );
  }

  /** balanceBefore +/- money === balanceAfter (tambem lanca se as moedas divergirem). */
  isBalanced(): boolean {
    return this.balanceBefore.add(this.signedAmount()).equals(this.balanceAfter);
  }

  /** Efeito do lancamento no saldo: positivo no credito, negativo no debito. */
  signedAmount(): Money {
    return this.direction === LedgerDirection.Credit ? this.money : this.money.negate();
  }
}
