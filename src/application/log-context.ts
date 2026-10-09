import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Campos de correlacao que acompanham a execucao: todo log emitido dentro dela os carrega,
 * sem que cada chamada precise repassa-los. So identificadores; nunca valores nem payloads.
 */
export interface LogFields {
  correlationId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
}

const storage = new AsyncLocalStorage<LogFields>();

/** Executa `fn` com um contexto novo (herdando o atual). */
export function withLogContext<T>(fields: LogFields, fn: () => T): T {
  return storage.run({ ...storage.getStore(), ...fields }, fn);
}

/** Acrescenta campos ao contexto em curso (ex.: transactionId depois que ela nasce). */
export function annotateLogContext(fields: LogFields): void {
  const store = storage.getStore();
  if (store !== undefined) Object.assign(store, fields);
}

export function currentLogContext(): LogFields {
  return { ...storage.getStore() };
}

/**
 * Executa `fn` num contexto novo e devolve tambem o objeto vivo desse contexto, que
 * acumula o que for anotado durante a execucao (para logar no fim, fora do fluxo async).
 */
export function withTrackedLogContext<T>(fields: LogFields, fn: (live: LogFields) => T): T {
  const live: LogFields = { ...storage.getStore(), ...fields };
  return storage.run(live, () => fn(live));
}
