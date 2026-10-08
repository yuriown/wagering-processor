import type { NextFunction, Request, Response } from "express";

export const CORRELATION_HEADER = "x-correlation-id";
const VALID = /^[A-Za-z0-9._:-]{1,128}$/;

export interface CorrelatedRequest extends Request {
  correlationId: string;
}

/** Aceita o correlation id do chamador (se bem formado) ou gera um; devolve no header da resposta. */
export function correlationMiddleware(request: Request, response: Response, next: NextFunction): void {
  const incoming = request.header(CORRELATION_HEADER);
  const correlationId = incoming !== undefined && VALID.test(incoming) ? incoming : Bun.randomUUIDv7();
  (request as CorrelatedRequest).correlationId = correlationId;
  response.setHeader(CORRELATION_HEADER, correlationId);
  next();
}
