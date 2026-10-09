import type { MoneyProps } from "../domain/money";
import { WalletNotFoundError } from "./errors";
import type { AppLogger, Metrics, TransactionRunner } from "./ports";

export interface ReconciliationReport {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

/**
 * Compara o saldo materializado com o saldo reconstruido pelo ledger.
 * Le os dois no mesmo snapshot (REPEATABLE READ, so leitura): um lancamento
 * confirmado no meio da conta nao gera falsa divergencia.
 * Divergencia nunca e corrigida aqui: e logada, contada e devolvida.
 */
export class ReconcileWallet {
  constructor(
    private readonly runner: TransactionRunner,
    private readonly logger: AppLogger,
    private readonly metrics: Metrics,
  ) {}

  async execute(walletId: string): Promise<ReconciliationReport> {
    const report = await this.runner.run(
      async (uow) => {
        const wallet = await uow.wallets.findById(walletId);
        if (wallet === undefined) throw new WalletNotFoundError(`wallet ${walletId} nao existe`);
        const summary = await uow.ledger.summarize(walletId, wallet.currency);
        const difference = wallet.balance.subtract(summary.total);
        return {
          walletId,
          storedBalance: wallet.balance.toJSON(),
          calculatedBalance: summary.total.toJSON(),
          difference: difference.toJSON(),
          consistent: difference.isZero(),
          checkedEntries: summary.entries,
        };
      },
      { isolation: "repeatable read", readOnly: true },
    );

    this.metrics.increment("reconciliations_total", { result: report.consistent ? "consistent" : "divergent" });
    if (!report.consistent) {
      this.metrics.increment("reconciliation_divergences_total");
      this.logger.error("divergencia entre saldo e ledger", {
        walletId,
        difference: report.difference.amount,
        checkedEntries: report.checkedEntries,
      });
    }
    return report;
  }
}
