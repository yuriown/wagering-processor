import { Migration } from "@mikro-orm/migrations";

/**
 * "Toda alteracao de saldo tem lancamento, e vice-versa", garantido no commit.
 *
 * Constraint triggers DEFERRABLE INITIALLY DEFERRED rodam no COMMIT, quando
 * wallet, lancamento e transacao ja foram todos escritos. Se um deles faltar ou
 * divergir, o commit inteiro falha e nada e confirmado:
 *  - saldo e versao da wallet = balance_after e wallet_version do ultimo lancamento
 *    (ou zero e versao 1 se nao houver lancamento);
 *  - lancamento so existe para transacao PROCESSED que move saldo, com o mesmo
 *    valor, moeda, wallet e direcao coerente com o tipo;
 *  - transacao PROCESSED que move saldo tem o seu lancamento.
 */
export class Migration20261008120300_balance_ledger_consistency extends Migration {
  override name = "Migration20261008120300_balance_ledger_consistency";

  override up(): void {
    this.addSql(`
      create function assert_wallet_matches_ledger(p_wallet_id uuid) returns void
      language plpgsql as $$
      declare
        w record;
        last_entry record;
      begin
        select balance, version into w from wallets where id = p_wallet_id;
        select balance_after, wallet_version into last_entry
          from wallet_ledger_entries
         where wallet_id = p_wallet_id
         order by wallet_version desc
         limit 1;
        if not found then
          if w.balance <> 0 or w.version <> 1 then
            raise exception 'wallet % tem saldo % (versao %) sem lancamento no ledger', p_wallet_id, w.balance, w.version
              using errcode = 'integrity_constraint_violation';
          end if;
        elsif last_entry.balance_after <> w.balance or last_entry.wallet_version <> w.version then
          raise exception 'wallet % diverge do ledger: saldo % versao %, ledger % versao %',
            p_wallet_id, w.balance, w.version, last_entry.balance_after, last_entry.wallet_version
            using errcode = 'integrity_constraint_violation';
        end if;
      end;
      $$;
    `);

    this.addSql(`
      create function wallets_check_ledger() returns trigger
      language plpgsql as $$
      begin
        perform assert_wallet_matches_ledger(new.id);
        return null;
      end;
      $$;
    `);
    this.addSql(`
      create constraint trigger wallets_match_ledger
        after insert or update on wallets
        deferrable initially deferred
        for each row execute function wallets_check_ledger();
    `);

    this.addSql(`
      create function wallet_ledger_entries_check_transaction() returns trigger
      language plpgsql as $$
      declare
        t record;
        expected_direction text;
      begin
        select kind, status, wallet_id, amount, currency, reference_transaction_id into t
          from wager_transactions where id = new.transaction_id;

        if t.status <> 'PROCESSED' or t.kind = 'LOSS' or t.wallet_id <> new.wallet_id
           or t.amount <> new.amount or t.currency <> new.currency then
          raise exception 'lancamento % nao corresponde a transacao % (% %, % %)',
            new.id, new.transaction_id, t.kind, t.status, t.amount, t.currency
            using errcode = 'integrity_constraint_violation';
        end if;

        expected_direction := case t.kind
          when 'BET' then 'DEBIT'
          when 'ROLLBACK' then (
            select case e.direction when 'DEBIT' then 'CREDIT' else 'DEBIT' end
              from wallet_ledger_entries e
             where e.transaction_id = t.reference_transaction_id)
          else 'CREDIT'
        end;
        if new.direction is distinct from expected_direction then
          raise exception 'lancamento % e % mas % exige %', new.id, new.direction, t.kind, expected_direction
            using errcode = 'integrity_constraint_violation';
        end if;

        perform assert_wallet_matches_ledger(new.wallet_id);
        return null;
      end;
      $$;
    `);
    this.addSql(`
      create constraint trigger wallet_ledger_entries_match_transaction
        after insert on wallet_ledger_entries
        deferrable initially deferred
        for each row execute function wallet_ledger_entries_check_transaction();
    `);

    this.addSql(`
      create function wager_transactions_check_ledger() returns trigger
      language plpgsql as $$
      begin
        if not exists (
          select 1 from wallet_ledger_entries where transaction_id = new.id and wallet_id = new.wallet_id
        ) then
          raise exception 'transacao % PROCESSED (%) sem lancamento no ledger', new.id, new.kind
            using errcode = 'integrity_constraint_violation';
        end if;
        return null;
      end;
      $$;
    `);
    this.addSql(`
      create constraint trigger wager_transactions_have_ledger_entry
        after insert or update on wager_transactions
        deferrable initially deferred
        for each row
        when (new.status = 'PROCESSED' and new.kind <> 'LOSS')
        execute function wager_transactions_check_ledger();
    `);
  }

  override down(): void {
    this.addSql(`drop trigger wager_transactions_have_ledger_entry on wager_transactions;`);
    this.addSql(`drop function wager_transactions_check_ledger();`);
    this.addSql(`drop trigger wallet_ledger_entries_match_transaction on wallet_ledger_entries;`);
    this.addSql(`drop function wallet_ledger_entries_check_transaction();`);
    this.addSql(`drop trigger wallets_match_ledger on wallets;`);
    this.addSql(`drop function wallets_check_ledger();`);
    this.addSql(`drop function assert_wallet_matches_ledger(uuid);`);
  }
}
