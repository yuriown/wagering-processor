import { Migration } from "@mikro-orm/migrations";

/**
 * Wallets e transacoes de aposta. As garantias de unicidade, de nao-negatividade
 * e de estado terminal ficam no schema: valem mesmo que um bug na aplicacao
 * (ou um UPDATE manual) tente contorna-las.
 */
export class Migration20261008120000_wallets_and_transactions extends Migration {
  override name = "Migration20261008120000_wallets_and_transactions";

  override up(): void {
    // Proibe UPDATE/DELETE/TRUNCATE em tabelas de auditoria. Serve para qualquer tabela.
    this.addSql(`
      create function forbid_modification() returns trigger
      language plpgsql as $$
      begin
        raise exception '% em % nao e permitido: registro de auditoria', tg_op, tg_table_name
          using errcode = 'integrity_constraint_violation';
      end;
      $$;
    `);

    this.addSql(`
      create table wallets (
        id uuid primary key,
        player_id text not null,
        currency text not null,
        balance numeric(20, 2) not null,
        version integer not null,
        created_at timestamptz not null,
        updated_at timestamptz not null,
        constraint wallets_player_id_check check (length(player_id) between 1 and 128),
        constraint wallets_currency_check check (currency ~ '^[A-Z]{3}$'),
        constraint wallets_balance_non_negative check (balance >= 0),
        constraint wallets_version_check check (version >= 1),
        constraint wallets_player_currency_key unique (player_id, currency)
      );
    `);
    this.addSql(`
      create trigger wallets_no_delete before delete on wallets
        for each row execute function forbid_modification();
    `);
    this.addSql(`
      create trigger wallets_no_truncate before truncate on wallets
        for each statement execute function forbid_modification();
    `);

    this.addSql(`
      create table wager_transactions (
        id uuid primary key,
        provider_id text not null,
        external_transaction_id text not null,
        idempotency_key text not null,
        payload_hash text not null,
        wallet_id uuid not null references wallets (id),
        player_id text not null,
        round_id text not null,
        game_id text not null,
        kind text not null,
        amount numeric(20, 2) not null,
        currency text not null,
        reference_external_transaction_id text,
        reference_transaction_id uuid references wager_transactions (id),
        status text not null,
        failure_code text,
        observed_balance numeric(20, 2),
        processed_at timestamptz,
        reference_attempts integer not null default 0,
        next_reference_check_at timestamptz,
        created_at timestamptz not null,
        updated_at timestamptz not null,

        constraint wager_transactions_provider_id_check check (length(provider_id) between 1 and 128),
        constraint wager_transactions_external_id_check check (length(external_transaction_id) between 1 and 256),
        constraint wager_transactions_idempotency_key_check check (length(idempotency_key) between 1 and 512),
        constraint wager_transactions_payload_hash_check check (payload_hash ~ '^[0-9a-f]{64}$'),
        constraint wager_transactions_player_id_check check (length(player_id) between 1 and 128),
        constraint wager_transactions_round_id_check check (length(round_id) between 1 and 256),
        constraint wager_transactions_game_id_check check (length(game_id) between 1 and 256),
        constraint wager_transactions_kind_check
          check (kind in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        constraint wager_transactions_status_check
          check (status in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        constraint wager_transactions_currency_check check (currency ~ '^[A-Z]{3}$'),
        constraint wager_transactions_amount_check check (amount >= 0 and (kind = 'LOSS' or amount > 0)),
        constraint wager_transactions_observed_balance_check check (observed_balance >= 0),
        constraint wager_transactions_reference_attempts_check check (reference_attempts >= 0),
        constraint wager_transactions_failure_code_check check (failure_code ~ '^[A-Z][A-Z_]*$'),

        -- Unicidade: a operacao do provedor e a chave de idempotencia (escopo do provedor).
        constraint wager_transactions_provider_external_key unique (provider_id, external_transaction_id),
        constraint wager_transactions_provider_idempotency_key unique (provider_id, idempotency_key),

        -- OPENING e interno e so ele usa o provider 'internal'.
        constraint wager_transactions_opening_is_internal check ((kind = 'OPENING') = (provider_id = 'internal')),
        -- Referencia: obrigatoria em REFUND/ROLLBACK, proibida em BET/OPENING, nunca a si mesma.
        constraint wager_transactions_reference_required
          check (kind not in ('REFUND', 'ROLLBACK') or reference_external_transaction_id is not null),
        constraint wager_transactions_reference_forbidden
          check (kind not in ('BET', 'OPENING') or reference_external_transaction_id is null),
        constraint wager_transactions_no_self_reference
          check (reference_external_transaction_id is distinct from external_transaction_id),
        constraint wager_transactions_reference_resolved_only_when_processed
          check (reference_transaction_id is null
                 or (reference_external_transaction_id is not null and status = 'PROCESSED')),

        -- Coerencia de estado.
        constraint wager_transactions_failure_code_iff_failed
          check ((status in ('REJECTED', 'FAILED')) = (failure_code is not null)),
        constraint wager_transactions_processed_at_iff_terminal
          check ((status in ('PROCESSED', 'REJECTED', 'FAILED')) = (processed_at is not null)),
        constraint wager_transactions_observed_balance_when_processed
          check (status <> 'PROCESSED' or observed_balance is not null),
        constraint wager_transactions_next_check_iff_pending_reference
          check ((status = 'PENDING_REFERENCE') = (next_reference_check_at is not null))
      );
    `);

    // Regra 4: uma referencia so e revertida uma vez, por REFUND ou por ROLLBACK.
    this.addSql(`
      create unique index wager_transactions_one_reversal_per_reference
        on wager_transactions (reference_transaction_id)
        where status = 'PROCESSED' and kind in ('REFUND', 'ROLLBACK');
    `);
    this.addSql(`
      create unique index wager_transactions_one_opening_per_wallet
        on wager_transactions (wallet_id)
        where kind = 'OPENING';
    `);
    // Worker de referencias pendentes: proximas a verificar.
    this.addSql(`
      create index wager_transactions_pending_reference_due
        on wager_transactions (next_reference_check_at)
        where status = 'PENDING_REFERENCE';
    `);
    // Quando a referencia chega, acha quem estava esperando por ela.
    this.addSql(`
      create index wager_transactions_waiting_for_reference
        on wager_transactions (provider_id, reference_external_transaction_id)
        where status = 'PENDING_REFERENCE';
    `);
    this.addSql(`create index wager_transactions_wallet_id on wager_transactions (wallet_id, created_at);`);
    this.addSql(`
      create index wager_transactions_reference_transaction_id
        on wager_transactions (reference_transaction_id)
        where reference_transaction_id is not null;
    `);

    // Estado terminal e definitivo; identidade e conteudo da operacao nunca mudam.
    this.addSql(`
      create function wager_transactions_guard_update() returns trigger
      language plpgsql as $$
      begin
        if old.status in ('PROCESSED', 'REJECTED', 'FAILED') then
          raise exception 'wager_transaction % ja esta % (terminal) e nao pode mudar', old.id, old.status
            using errcode = 'integrity_constraint_violation';
        end if;
        if new.status = 'PENDING' and old.status <> 'PENDING' then
          raise exception 'wager_transaction % nao volta para PENDING', old.id
            using errcode = 'integrity_constraint_violation';
        end if;
        if (new.id, new.provider_id, new.external_transaction_id, new.idempotency_key, new.payload_hash,
            new.wallet_id, new.player_id, new.round_id, new.game_id, new.kind, new.amount, new.currency,
            new.reference_external_transaction_id, new.created_at)
           is distinct from
           (old.id, old.provider_id, old.external_transaction_id, old.idempotency_key, old.payload_hash,
            old.wallet_id, old.player_id, old.round_id, old.game_id, old.kind, old.amount, old.currency,
            old.reference_external_transaction_id, old.created_at) then
          raise exception 'campos da operacao em wager_transaction % sao imutaveis', old.id
            using errcode = 'integrity_constraint_violation';
        end if;
        if new.reference_attempts < old.reference_attempts then
          raise exception 'reference_attempts de % nao pode diminuir', old.id
            using errcode = 'integrity_constraint_violation';
        end if;
        return new;
      end;
      $$;
    `);
    this.addSql(`
      create trigger wager_transactions_guard_update before update on wager_transactions
        for each row execute function wager_transactions_guard_update();
    `);
    this.addSql(`
      create trigger wager_transactions_no_delete before delete on wager_transactions
        for each row execute function forbid_modification();
    `);
    this.addSql(`
      create trigger wager_transactions_no_truncate before truncate on wager_transactions
        for each statement execute function forbid_modification();
    `);
  }

  override down(): void {
    this.addSql(`drop table wager_transactions;`);
    this.addSql(`drop function wager_transactions_guard_update();`);
    this.addSql(`drop table wallets;`);
    this.addSql(`drop function forbid_modification();`);
  }
}
