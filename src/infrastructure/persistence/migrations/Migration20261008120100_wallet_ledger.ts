import { Migration } from "@mikro-orm/migrations";

/**
 * Ledger imutavel. Cada lancamento confere a propria aritmetica (CHECK) e o
 * encadeamento com o anterior (trigger): o balance_before de um lancamento e o
 * balance_after do lancamento de versao imediatamente anterior da mesma wallet.
 */
export class Migration20261008120100_wallet_ledger extends Migration {
  override name = "Migration20261008120100_wallet_ledger";

  override up(): void {
    this.addSql(`
      create table wallet_ledger_entries (
        id uuid primary key,
        wallet_id uuid not null references wallets (id),
        transaction_id uuid not null references wager_transactions (id),
        direction text not null,
        amount numeric(20, 2) not null,
        currency text not null,
        balance_before numeric(20, 2) not null,
        balance_after numeric(20, 2) not null,
        wallet_version integer not null,
        created_at timestamptz not null,

        constraint wallet_ledger_entries_direction_check check (direction in ('DEBIT', 'CREDIT')),
        constraint wallet_ledger_entries_amount_positive check (amount > 0),
        constraint wallet_ledger_entries_currency_check check (currency ~ '^[A-Z]{3}$'),
        constraint wallet_ledger_entries_balance_before_non_negative check (balance_before >= 0),
        constraint wallet_ledger_entries_balance_after_non_negative check (balance_after >= 0),
        constraint wallet_ledger_entries_wallet_version_check check (wallet_version >= 1),
        constraint wallet_ledger_entries_balanced
          check (balance_after = balance_before + case direction when 'CREDIT' then amount else -amount end),

        -- No maximo um lancamento por transacao em cada wallet.
        constraint wallet_ledger_entries_transaction_wallet_key unique (transaction_id, wallet_id),
        -- Corrente sem duplicata: uma versao, um lancamento. Tambem e a ordem estavel da paginacao.
        constraint wallet_ledger_entries_wallet_version_key unique (wallet_id, wallet_version)
      );
    `);

    this.addSql(`
      create function wallet_ledger_entries_check_chain() returns trigger
      language plpgsql as $$
      declare
        wallet_currency text;
        previous_after numeric(20, 2);
      begin
        select currency into wallet_currency from wallets where id = new.wallet_id;
        if wallet_currency is distinct from new.currency then
          raise exception 'lancamento em % para wallet % em %', new.currency, new.wallet_id, wallet_currency
            using errcode = 'integrity_constraint_violation';
        end if;

        select balance_after into previous_after
          from wallet_ledger_entries
         where wallet_id = new.wallet_id and wallet_version = new.wallet_version - 1;

        if found then
          if new.balance_before <> previous_after then
            raise exception 'lancamento % quebra a corrente da wallet %: parte de % e o anterior terminou em %',
              new.id, new.wallet_id, new.balance_before, previous_after
              using errcode = 'integrity_constraint_violation';
          end if;
        else
          -- Primeiro lancamento: versao 1 (credito de abertura) ou 2 (wallet aberta com zero).
          if exists (select 1 from wallet_ledger_entries where wallet_id = new.wallet_id)
             or new.wallet_version > 2
             or new.balance_before <> 0 then
            raise exception 'lancamento % fora de sequencia na wallet % (versao %)',
              new.id, new.wallet_id, new.wallet_version
              using errcode = 'integrity_constraint_violation';
          end if;
        end if;
        return new;
      end;
      $$;
    `);
    this.addSql(`
      create trigger wallet_ledger_entries_check_chain before insert on wallet_ledger_entries
        for each row execute function wallet_ledger_entries_check_chain();
    `);

    // Imutabilidade: lancamento nao se edita nem se apaga; correcao e outro lancamento.
    this.addSql(`
      create trigger wallet_ledger_entries_no_update before update or delete on wallet_ledger_entries
        for each row execute function forbid_modification();
    `);
    this.addSql(`
      create trigger wallet_ledger_entries_no_truncate before truncate on wallet_ledger_entries
        for each statement execute function forbid_modification();
    `);
    this.addSql(`create index wallet_ledger_entries_transaction_id on wallet_ledger_entries (transaction_id);`);
  }

  override down(): void {
    this.addSql(`drop table wallet_ledger_entries;`);
    this.addSql(`drop function wallet_ledger_entries_check_chain();`);
  }
}
