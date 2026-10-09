import type { MigrationObject } from "@mikro-orm/core";
import { Migration20261008120000_wallets_and_transactions } from "./Migration20261008120000_wallets_and_transactions";
import { Migration20261008120100_wallet_ledger } from "./Migration20261008120100_wallet_ledger";
import { Migration20261008120200_inbox_outbox } from "./Migration20261008120200_inbox_outbox";
import { Migration20261008120300_balance_ledger_consistency } from "./Migration20261008120300_balance_ledger_consistency";

/**
 * Lista explicita, em ordem. Migracao nova = entrada nova no fim;
 * nunca editar uma que ja rodou em algum ambiente.
 */
export const MIGRATIONS: MigrationObject[] = [
  { name: "Migration20261008120000_wallets_and_transactions", class: Migration20261008120000_wallets_and_transactions },
  { name: "Migration20261008120100_wallet_ledger", class: Migration20261008120100_wallet_ledger },
  { name: "Migration20261008120200_inbox_outbox", class: Migration20261008120200_inbox_outbox },
  { name: "Migration20261008120300_balance_ledger_consistency", class: Migration20261008120300_balance_ledger_consistency },
];
