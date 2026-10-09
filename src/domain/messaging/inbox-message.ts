import { InvariantViolationError, assertNonEmpty } from "../shared/domain-error";

export interface ReceiveInboxProps {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt: Date;
}

export interface InboxMessageState extends ReceiveInboxProps {
  processedAt?: Date | undefined;
}

/**
 * Registro persistente de mensagem consumida, unico por (consumerName, messageId).
 * Gravado na mesma transacao SQL do efeito financeiro: se o commit acontece,
 * a redelivery encontra o registro e nao reaplica nada.
 */
export class InboxMessage {
  private constructor(
    public readonly messageId: string,
    public readonly consumerName: string,
    public readonly payloadHash: string,
    public readonly receivedAt: Date,
    private _processedAt: Date | undefined,
  ) {}

  static receive(props: ReceiveInboxProps): InboxMessage {
    assertNonEmpty(props.messageId, "messageId");
    assertNonEmpty(props.consumerName, "consumerName");
    assertNonEmpty(props.payloadHash, "payloadHash");
    return new InboxMessage(props.messageId, props.consumerName, props.payloadHash, props.receivedAt, undefined);
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(
      state.messageId,
      state.consumerName,
      state.payloadHash,
      new Date(state.receivedAt),
      state.processedAt === undefined ? undefined : new Date(state.processedAt),
    );
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  isProcessed(): boolean {
    return this._processedAt !== undefined;
  }

  /** Mesmo messageId com conteudo diferente nao e redelivery: e outra mensagem reusando o id. */
  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  markProcessed(at: Date): void {
    if (this.isProcessed()) {
      throw new InvariantViolationError(`mensagem ${this.consumerName}/${this.messageId} ja processada`);
    }
    this._processedAt = at;
  }
}
