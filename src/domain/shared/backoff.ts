export interface BackoffPolicy {
  readonly baseMs: number;
  readonly maxMs: number;
}

/**
 * Atraso antes da tentativa seguinte a `attempt` (1, 2, 3...): base * 2^(attempt-1), limitado a maxMs.
 * Sem jitter de proposito: o dominio fica deterministico e testavel; espalhar
 * instancias concorrentes e papel do SKIP LOCKED no banco, nao do relogio.
 */
export function backoffDelayMs(attempt: number, policy: BackoffPolicy): number {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new RangeError(`attempt deve ser inteiro >= 1, recebido ${attempt}`);
  }
  return Math.min(policy.maxMs, policy.baseMs * 2 ** (attempt - 1));
}

export function nextAttemptAt(now: Date, attempt: number, policy: BackoffPolicy): Date {
  return new Date(now.getTime() + backoffDelayMs(attempt, policy));
}
