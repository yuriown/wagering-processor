import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, HttpStatus } from "@nestjs/common";
import type { Response } from "express";
import {
  ApplicationError,
  IdempotencyConflictError,
  InboxConflictError,
  TransactionNotFoundError,
  TransientInfrastructureError,
  UniqueViolationError,
  ValidationError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from "../../application/errors";
import type { AppLogger } from "../../application/ports";
import { DomainError } from "../../domain/shared/domain-error";

/** Segundos sugeridos ao provedor antes de reenviar uma falha transitoria. */
export const RETRY_AFTER_SECONDS = 1;

export interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

/**
 * Um status por situacao, igual em todos os endpoints, para o provedor decidir
 * sem interpretar texto:
 *   400 payload invalido            -> corrigir
 *   404 recurso inexistente         -> corrigir
 *   409 conflito (idempotencia, wallet duplicada) -> nao reenviar igual
 *   422 rejeicao de regra de negocio (corpo da transacao, com failureCode)
 *   202 aceito, aguardando referencia
 *   503 falha transitoria, com Retry-After -> reenviar a mesma requisicao
 *   500 erro inesperado
 */
@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  constructor(private readonly logger: AppLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const { status, body } = this.map(exception);
    if (status === HttpStatus.SERVICE_UNAVAILABLE) {
      response.setHeader("Retry-After", String(RETRY_AFTER_SECONDS));
    }
    if (status >= 500) {
      this.logger.error("falha ao atender requisicao", {
        status,
        code: body.error.code,
        error: exception instanceof Error ? exception.name : typeof exception,
        detail: exception instanceof Error ? exception.message : undefined,
      });
    }
    response.status(status).json(body);
  }

  private map(exception: unknown): { status: number; body: ErrorBody } {
    const error = (code: string, message: string, details?: unknown): ErrorBody => ({
      error: details === undefined ? { code, message } : { code, message, details },
    });

    if (exception instanceof ValidationError) {
      return { status: HttpStatus.BAD_REQUEST, body: error(exception.code, "payload invalido", exception.issues) };
    }
    if (exception instanceof DomainError) {
      return { status: HttpStatus.BAD_REQUEST, body: error("VALIDATION_FAILED", exception.message) };
    }
    if (exception instanceof IdempotencyConflictError) {
      return {
        status: HttpStatus.CONFLICT,
        body: error(exception.code, exception.message, { transactionId: exception.existingTransactionId }),
      };
    }
    if (exception instanceof WalletAlreadyExistsError || exception instanceof InboxConflictError) {
      return { status: HttpStatus.CONFLICT, body: error(exception.code, exception.message) };
    }
    if (exception instanceof WalletNotFoundError || exception instanceof TransactionNotFoundError) {
      return { status: HttpStatus.NOT_FOUND, body: error(exception.code, exception.message) };
    }
    if (exception instanceof TransientInfrastructureError || exception instanceof UniqueViolationError) {
      // UniqueViolation que sobrou depois do retry interno: concorrencia extrema; reenviar resolve (vira replay).
      return { status: HttpStatus.SERVICE_UNAVAILABLE, body: error("TEMPORARILY_UNAVAILABLE", "tente novamente") };
    }
    if (exception instanceof ApplicationError) {
      return { status: HttpStatus.INTERNAL_SERVER_ERROR, body: error(exception.code, exception.message) };
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();
      if (typeof payload === "object" && payload !== null && "error" in payload && typeof payload.error === "object") {
        return { status, body: payload as ErrorBody };
      }
      // Erros do proprio Nest/Express (JSON malformado, rota inexistente) no mesmo formato.
      const code = status === 400 ? "VALIDATION_FAILED" : status === 404 ? "NOT_FOUND" : `HTTP_${status}`;
      return { status, body: error(code, exception.message) };
    }
    return { status: HttpStatus.INTERNAL_SERVER_ERROR, body: error("INTERNAL_ERROR", "erro inesperado") };
  }
}
