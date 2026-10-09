import { CurrencyMismatchError, Money } from "../money";
import { DomainError, InvariantViolationError, assertNonEmpty } from "../shared/domain-error";
import { LedgerDirection } from "./ledger-direction";
import { WalletLedgerEntry } from "./wallet-ledger-entry";

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  /** Id da transacao interna OPENING; so e usado se o saldo inicial for positivo. */
  openingTransactionId: string;
  openingEntryId: string;
  at: Date;
}

export interface OpenedWallet {
  wallet: Wallet;
  /** Presente quando o saldo inicial e positivo: o credito de abertura tambem vai ao ledger. */
  openingEntry: WalletLedgerEntry | undefined;
}

export interface MovementProps {
  entryId: string;
  transactionId: string;
  money: Money;
  at: Date;
}

export class InsufficientFundsError extends DomainError {
  readonly code = "INSUFFICIENT_FUNDS";
}

/**
 * Aggregate root do saldo. O saldo so muda por `debit`/`credit`, e cada um
 * devolve o lancamento do ledger correspondente: nao ha como alterar o saldo
 * sem produzir o lancamento, nem produzir lancamento sem alterar o saldo.
 */
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: OpenWalletProps): OpenedWallet {
    assertNonEmpty(props.id, "id");
    assertNonEmpty(props.playerId, "playerId");
    if (props.initialBalance.isNegative()) {
      throw new InvariantViolationError("saldo inicial nao pode ser negativo");
    }
    const currency = props.initialBalance.currency;
    const wallet = new Wallet(props.id, props.playerId, currency, props.initialBalance, 1, props.at, props.at);
    const openingEntry = props.initialBalance.isPositive()
      ? WalletLedgerEntry.create({
          id: props.openingEntryId,
          walletId: props.id,
          transactionId: props.openingTransactionId,
          direction: LedgerDirection.Credit,
          money: props.initialBalance,
          balanceBefore: Money.zero(currency),
          balanceAfter: props.initialBalance,
          walletVersion: 1,
          createdAt: props.at,
        })
      : undefined;
    return { wallet, openingEntry };
  }

  /** Reconstrucao a partir da persistencia: nao revalida transicoes. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      new Date(state.createdAt),
      new Date(state.updatedAt),
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  canDebit(money: Money): boolean {
    this.assertSameCurrency(money);
    return !this._balance.isLessThan(money);
  }

  debit(props: MovementProps): WalletLedgerEntry {
    if (!this.canDebit(props.money)) {
      throw new InsufficientFundsError(`saldo ${this._balance} insuficiente para debitar ${props.money}`);
    }
    return this.apply(LedgerDirection.Debit, props);
  }

  credit(props: MovementProps): WalletLedgerEntry {
    this.assertSameCurrency(props.money);
    return this.apply(LedgerDirection.Credit, props);
  }

  private apply(direction: LedgerDirection, props: MovementProps): WalletLedgerEntry {
    const before = this._balance;
    const after = direction === LedgerDirection.Credit ? before.add(props.money) : before.subtract(props.money);
    const nextVersion = this._version + 1;
    // A factory valida a aritmetica e a nao-negatividade antes de qualquer mutacao.
    const entry = WalletLedgerEntry.create({
      id: props.entryId,
      walletId: this.id,
      transactionId: props.transactionId,
      direction,
      money: props.money,
      balanceBefore: before,
      balanceAfter: after,
      walletVersion: nextVersion,
      createdAt: props.at,
    });
    this._balance = after;
    this._version = nextVersion;
    this._updatedAt = props.at;
    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
