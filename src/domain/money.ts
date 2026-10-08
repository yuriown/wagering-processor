import { DomainError } from "./shared/domain-error";

/** Contrato de entrada e saida: string decimal com escala 2 e codigo ISO-4217. */
export interface MoneyProps {
  amount: string;
  currency: string;
}

export class InvalidMoneyError extends DomainError {
  readonly code = "INVALID_MONEY";
}

export class CurrencyMismatchError extends DomainError {
  readonly code = "CURRENCY_MISMATCH";

  constructor(expected: string, received: string) {
    super(`moeda ${received} difere de ${expected}`);
  }
}

const SCALE = 2;
const FACTOR = 10n ** BigInt(SCALE);
/** 18 digitos inteiros + 2 decimais = numeric(20,2) no banco. */
const MAX_INTEGER_DIGITS = 18;
/**
 * Sem sinal, sem zero a esquerda, sem expoente, no maximo 2 casas.
 * Recusa por construcao: "", "NaN", "Infinity", "1e3", "-1.00", "1.234", " 1.00", "01.00".
 */
const AMOUNT_PATTERN = new RegExp(`^(0|[1-9]\\d{0,${MAX_INTEGER_DIGITS - 1}})(?:\\.(\\d{1,${SCALE}}))?$`);
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/**
 * Valor monetario imutavel. Guarda centavos em `bigint`: com escala fixa de 2
 * casas a representacao e exata e nao existe arredondamento (entrada com mais
 * casas e recusada). `number` nunca participa da conta.
 */
export class Money {
  private constructor(
    private readonly minorUnits: bigint,
    public readonly currency: string,
  ) {
    Object.freeze(this);
  }

  /** Contrato de entrada: recusa valor negativo e qualquer formato ambiguo. */
  static from(props: MoneyProps): Money {
    if (props === null || typeof props !== "object") {
      throw new InvalidMoneyError("money deve ser um objeto { amount, currency }");
    }
    const { amount, currency } = props;
    if (typeof amount !== "string") {
      throw new InvalidMoneyError("amount deve ser string decimal");
    }
    const match = AMOUNT_PATTERN.exec(amount);
    if (!match) {
      throw new InvalidMoneyError(`amount invalido: "${amount}"`);
    }
    const integer = BigInt(match[1] ?? "0");
    const fraction = BigInt((match[2] ?? "").padEnd(SCALE, "0"));
    return new Money(integer * FACTOR + fraction, Money.parseCurrency(currency));
  }

  static zero(currency: string): Money {
    return new Money(0n, Money.parseCurrency(currency));
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minorUnits + other.minorUnits, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minorUnits - other.minorUnits, this.currency);
  }

  negate(): Money {
    return new Money(-this.minorUnits, this.currency);
  }

  isZero(): boolean {
    return this.minorUnits === 0n;
  }

  isPositive(): boolean {
    return this.minorUnits > 0n;
  }

  isNegative(): boolean {
    return this.minorUnits < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minorUnits < other.minorUnits;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.minorUnits === other.minorUnits;
  }

  toJSON(): MoneyProps {
    return { amount: this.formatAmount(), currency: this.currency };
  }

  toString(): string {
    return `${this.formatAmount()} ${this.currency}`;
  }

  private formatAmount(): string {
    const negative = this.minorUnits < 0n;
    const abs = negative ? -this.minorUnits : this.minorUnits;
    const integer = abs / FACTOR;
    const fraction = (abs % FACTOR).toString().padStart(SCALE, "0");
    return `${negative ? "-" : ""}${integer}.${fraction}`;
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  private static parseCurrency(currency: unknown): string {
    if (typeof currency !== "string" || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError(`currency deve ser ISO-4217 (3 letras maiusculas), recebido "${String(currency)}"`);
    }
    return currency;
  }
}
