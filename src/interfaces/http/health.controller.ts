import { Controller, Get, Inject, Res } from "@nestjs/common";
import type { Response } from "express";
import { ReadinessProbe } from "../../infrastructure/health/readiness";
import { Public } from "./auth";

@Public()
@Controller("health")
export class HealthController {
  constructor(@Inject(ReadinessProbe) private readonly readiness: ReadinessProbe) {}

  /** Processo vivo. Nao toca dependencias: falha aqui significa reiniciar o processo. */
  @Get("live")
  live(): { status: "ok" } {
    return { status: "ok" };
  }

  /** Pronto para receber trafego: PostgreSQL e SQS alcancaveis. 503 tira a instancia do balanceador. */
  @Get("ready")
  async ready(@Res({ passthrough: true }) response: Response) {
    const report = await this.readiness.check();
    response.status(report.ready ? 200 : 503);
    return { status: report.ready ? "ok" : "unavailable", checks: report.checks };
  }
}
