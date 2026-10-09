import { InvalidMoneyError, Money, type MoneyProps } from "../domain/money";
import { WagerTransaction } from "../domain/wagering/wager-transaction";
import { Wallet } from "../domain/wallet/wallet";
import { UniqueViolationError, ValidationError, WalletAlreadyExistsError } from "./errors";
import type { EventFactory } from "./event-factory";
import type { Clock, IdGenerator, RequestContext, TransactionRunner } from "./ports";

export interface CreateWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
}

export function parseCreateWalletCommand(body: unknown): CreateWalletCommand {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new ValidationError([{ field: "body", message: "deve ser um objeto JSON" }]);
  }
  const input = body as Record<string, unknown>;
  const issues = [];
  const playerId = input.playerId;
  if (typeof playerId !== "string" || playerId.trim().length === 0 || [...playerId].length > 128) {
    issues.push({ field: "playerId", message: "obrigatorio, texto de 1 a 128 caracteres" });
  }
  let initialBalance: MoneyProps = { amount: "", currency: "" };
  try {
    initialBalance = Money.from(input.initialBalance as MoneyProps).toJSON();
  } catch (error) {
    if (!(error instanceof InvalidMoneyError)) throw error;
    issues.push({ field: "initialBalance", message: error.message });
  }
  if (issues.length > 0) throw new ValidationError(issues);
  return { playerId: playerId as string, initialBalance };
}

/**
 * Abre a wallet. Saldo inicial positivo vira a transacao interna OPENING com
 * lancamento CREDIT, no mesmo COMMIT que cria a wallet.
 */
export class CreateWallet {
  constructor(
    private readonly runner: TransactionRunner,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly events: EventFactory,
  ) {}

  async execute(command: CreateWalletCommand, context: RequestContext): Promise<Wallet> {
    const initialBalance = Money.from(command.initialBalance);
    try {
      return await this.runner.run(async (uow) => {
        const existing = await uow.wallets.findByPlayerAndCurrency(command.playerId, initialBalance.currency);
        if (existing !== undefined) {
          throw new WalletAlreadyExistsError(
            `player ${command.playerId} ja tem wallet em ${initialBalance.currency} (${existing.id})`,
          );
        }
        const now = this.clock.now();
        const walletId = this.ids.next();
        const openingTransactionId = this.ids.next();
        const { wallet, openingEntry } = Wallet.open({
          id: walletId,
          playerId: command.playerId,
          initialBalance,
          openingTransactionId,
          openingEntryId: this.ids.next(),
          at: now,
        });
        uow.wallets.add(wallet);
        if (openingEntry !== undefined) {
          const opening = WagerTransaction.opening({
            id: openingTransactionId,
            walletId,
            playerId: command.playerId,
            money: initialBalance,
            at: now,
          });
          uow.transactions.add(opening);
          uow.ledger.append(openingEntry);
          for (const message of this.events.forOutcome(opening, wallet, openingEntry, context)) {
            uow.outbox.enqueue(message);
          }
        }
        return wallet;
      });
    } catch (error) {
      // Duas criacoes simultaneas: o indice unico decide, quem perde recebe conflito.
      if (error instanceof UniqueViolationError && error.constraint === "wallets_player_currency_key") {
        throw new WalletAlreadyExistsError(`player ${command.playerId} ja tem wallet em ${initialBalance.currency}`);
      }
      throw error;
    }
  }
}
