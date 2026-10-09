import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Post, Query, Req } from "@nestjs/common";
import { CreateWallet, parseCreateWalletCommand } from "../../application/create-wallet";
import { WalletQueries, parseLedgerLimit } from "../../application/queries";
import { ReconcileWallet } from "../../application/reconcile-wallet";
import type { CorrelatedRequest } from "./correlation";
import { presentLedgerEntry, presentWallet } from "./presenters";
import { UuidParam } from "./uuid.pipe";

const walletIdParam = new UuidParam("walletId");

@Controller("wallets")
export class WalletsController {
  constructor(
    @Inject(CreateWallet) private readonly createWallet: CreateWallet,
    @Inject(WalletQueries) private readonly queries: WalletQueries,
    @Inject(ReconcileWallet) private readonly reconcile: ReconcileWallet,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() body: unknown, @Req() request: CorrelatedRequest) {
    const command = parseCreateWalletCommand(body);
    const wallet = await this.createWallet.execute(command, { correlationId: request.correlationId });
    return presentWallet(wallet);
  }

  @Get(":walletId")
  async get(@Param("walletId", walletIdParam) walletId: string) {
    return presentWallet(await this.queries.getWallet(walletId));
  }

  @Get(":walletId/ledger")
  async ledger(
    @Param("walletId", walletIdParam) walletId: string,
    @Query("cursor") cursor: string | undefined,
    @Query("limit") limit: string | undefined,
  ) {
    const page = await this.queries.getLedgerPage(walletId, cursor, parseLedgerLimit(limit));
    return {
      walletId,
      entries: page.entries.map(presentLedgerEntry),
      nextCursor: page.nextCursor ?? null,
    };
  }

  @Post(":walletId/reconciliation")
  @HttpCode(HttpStatus.OK)
  async reconciliation(@Param("walletId", walletIdParam) walletId: string) {
    return this.reconcile.execute(walletId);
  }
}
