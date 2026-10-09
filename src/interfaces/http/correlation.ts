import type { NextFunction, Request, Response } from "express";
import { withLogContext, withTrackedLogContext } from "../../application/log-context";
import type { AppLogger, Metrics } from "../../application/ports";

export const CORRELATION_HEADER = "x-correlation-id";
const VALID = /^[A-Za-z0-9._:-]{1,128}$/;

export interface CorrelatedRequest extends Request {
  correlationId: string;
}

/**
 * Aceita o correlation id do chamador (se bem formado) ou gera um, devolve no header e
 * executa o resto da requisicao dentro do contexto de log: todo log dela sai com o id.
 * No fim, uma linha de acesso (com o que o handler anotou: walletId, transactionId...)
 * e as metricas HTTP, rotuladas pela rota como template, nunca pelo id concreto.
 */
export function correlationMiddleware(logger: AppLogger, metrics: Metrics) {
  return (request: Request, response: Response, next: NextFunction): void => {
    const incoming = request.header(CORRELATION_HEADER);
    const correlationId = incoming !== undefined && VALID.test(incoming) ? incoming : Bun.randomUUIDv7();
    (request as CorrelatedRequest).correlationId = correlationId;
    response.setHeader(CORRELATION_HEADER, correlationId);
    const started = performance.now();

    withTrackedLogContext({ correlationId }, (live) => {
      response.on("finish", () => {
        const route = (request.route as { path?: string } | undefined)?.path ?? "unmatched";
        const labels = { method: request.method, route, status: String(response.statusCode) };
        const seconds = (performance.now() - started) / 1000;
        metrics.increment("http_requests_total", labels);
        metrics.observe("http_request_duration_seconds", seconds, labels);
        if (route === "/metrics" || route.startsWith("/health")) return;
        withLogContext(live, () =>
          logger.info("http", {
            method: request.method,
            route,
            status: response.statusCode,
            durationMs: Math.round(seconds * 1000),
          }),
        );
      });
      next();
    });
  };
}
