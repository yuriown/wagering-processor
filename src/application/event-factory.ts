import type { EventContext, IntegrationEvent } from "../domain/events/integration-event";
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
} from "../domain/events/wager-transaction-events";
import { WalletBalanceChanged } from "../domain/events/wallet-balance-changed";
import { OutboxMessage } from "../domain/messaging/outbox-message";
import { type WagerTransaction, WagerTransactionStatus } from "../domain/wagering/wager-transaction";
import type { Wallet } from "../domain/wallet/wallet";
import type { WalletLedgerEntry } from "../domain/wallet/wallet-ledger-entry";
import type { Clock, IdGenerator, RequestContext } from "./ports";

/** Monta os eventos de integracao de um desfecho, ja como mensagens de outbox. */
export class EventFactory {
  constructor(
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  /** Evento do estado atual da transacao + WalletBalanceChanged se houve lancamento. */
  forOutcome(
    transaction: WagerTransaction,
    wallet: Wallet,
    entry: WalletLedgerEntry | undefined,
    request: RequestContext,
  ): OutboxMessage[] {
    const events: IntegrationEvent<unknown>[] = [];
    switch (transaction.status) {
      case WagerTransactionStatus.Processed:
        events.push(WagerTransactionProcessed.from(transaction, this.context(request)));
        break;
      case WagerTransactionStatus.Rejected:
        events.push(WagerTransactionRejected.from(transaction, this.context(request)));
        break;
      case WagerTransactionStatus.PendingReference:
        events.push(WagerTransactionPendingReference.from(transaction, this.context(request)));
        break;
      default:
        break;
    }
    if (entry !== undefined) {
      events.push(WalletBalanceChanged.from(wallet, entry, this.context(request)));
    }
    return events.map((event) => OutboxMessage.enqueue(event));
  }

  private context(request: RequestContext): EventContext {
    return {
      eventId: this.ids.next(),
      correlationId: request.correlationId,
      causationId: request.causationId,
      occurredAt: this.clock.now(),
    };
  }
}
