import { Body, Controller, Get, Headers, Inject, Param, Post, Req, Res } from "@nestjs/common";
import type { Response } from "express";
import { ProcessWagerTransaction } from "../../application/process-wager-transaction";
import { WalletQueries } from "../../application/queries";
import { parseWagerCommand } from "../../application/wager-command";
import { type AuthenticatedRequest, assertActsAsProvider } from "./auth";
import type { CorrelatedRequest } from "./correlation";
import { presentTransaction, presentWagerOutcome } from "./presenters";
import { UuidParam } from "./uuid.pipe";

@Controller()
export class WageringController {
  constructor(
    @Inject(ProcessWagerTransaction) private readonly process: ProcessWagerTransaction,
    @Inject(WalletQueries) private readonly queries: WalletQueries,
  ) {}

  /** O header Idempotency-Key e obrigatorio e e a fonte da verdade da deduplicacao. */
  @Post("wagering/transactions")
  async submit(
    @Body() body: unknown,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Req() request: CorrelatedRequest & AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const command = parseWagerCommand(body, idempotencyKey);
    assertActsAsProvider(request, command.providerId);
    const outcome = await this.process.execute(command, {
      correlationId: request.correlationId,
      causationId: command.idempotencyKey,
    });
    const { status, body: result } = presentWagerOutcome(outcome);
    response.status(status);
    return result;
  }

  @Get("wagering/transactions/:transactionId")
  async get(@Param("transactionId", new UuidParam("transactionId")) transactionId: string) {
    return presentTransaction(await this.queries.getTransaction(transactionId));
  }

  @Get("providers/:providerId/wagering/transactions/:externalTransactionId")
  async getByProvider(
    @Param("providerId") providerId: string,
    @Param("externalTransactionId") externalTransactionId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    assertActsAsProvider(request, providerId);
    return presentTransaction(await this.queries.getProviderTransaction(providerId, externalTransactionId));
  }
}
