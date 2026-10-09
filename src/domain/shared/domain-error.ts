/**
 * Violacao de regra de negocio ou de contrato de entrada.
 * `code` e estavel e legivel por maquina; a mensagem e so para humanos.
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * Erro de programacao: o codigo tentou algo que o modelo proibe
 * (ex.: transicionar uma transacao terminal). Nunca e caminho de negocio.
 */
export class InvariantViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export function assertNonEmpty(value: string, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InvariantViolationError(`${field} nao pode ser vazio`);
  }
}
