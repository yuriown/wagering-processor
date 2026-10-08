import { Controller, Get, Inject, Res } from "@nestjs/common";
import type { Response } from "express";
import { PrometheusMetrics } from "../../infrastructure/observability/prometheus-metrics";
import { Public } from "./auth";

/** Formato texto do Prometheus. Aberto como os health checks (operacao, nao provedor). */
@Public()
@Controller("metrics")
export class MetricsController {
  constructor(@Inject(PrometheusMetrics) private readonly metrics: PrometheusMetrics) {}

  @Get()
  async scrape(@Res() response: Response): Promise<void> {
    const { contentType, body } = await this.metrics.render();
    response.setHeader("content-type", contentType);
    response.send(body);
  }
}
