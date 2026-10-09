import { Controller, Get } from "@nestjs/common";

@Controller("health")
export class HealthController {
  /** Processo vivo. Nao toca dependencias: falha aqui significa reiniciar o processo. */
  @Get("live")
  live(): { status: "ok" } {
    return { status: "ok" };
  }
}
