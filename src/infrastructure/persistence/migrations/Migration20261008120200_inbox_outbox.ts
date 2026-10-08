import { Migration } from "@mikro-orm/migrations";

/**
 * Inbox (deduplicacao persistente do consumidor SQS) e outbox (eventos gravados
 * no mesmo commit do efeito financeiro e publicados depois por um worker).
 */
export class Migration20261008120200_inbox_outbox extends Migration {
  override name = "Migration20261008120200_inbox_outbox";

  override up(): void {
    this.addSql(`
      create table inbox_messages (
        consumer_name text not null,
        message_id text not null,
        payload_hash text not null,
        transaction_id uuid references wager_transactions (id),
        received_at timestamptz not null,
        processed_at timestamptz,

        constraint inbox_messages_pkey primary key (consumer_name, message_id),
        constraint inbox_messages_consumer_name_check check (length(consumer_name) between 1 and 128),
        constraint inbox_messages_message_id_check check (length(message_id) between 1 and 256),
        constraint inbox_messages_payload_hash_check check (payload_hash ~ '^[0-9a-f]{64}$')
      );
    `);

    this.addSql(`
      create table outbox_messages (
        id uuid primary key,
        aggregate_id text not null,
        event_type text not null,
        payload jsonb not null,
        occurred_at timestamptz not null,
        attempts integer not null default 0,
        next_attempt_at timestamptz,
        -- Lease de publicacao: a instancia que pegou o evento tem ate locked_until para publicar.
        -- Se morrer, o lease expira e outra instancia assume.
        locked_by text,
        locked_until timestamptz,
        last_error text,
        published_at timestamptz,

        constraint outbox_messages_aggregate_id_check check (length(aggregate_id) between 1 and 256),
        constraint outbox_messages_event_type_check check (event_type ~ '^[A-Z][A-Za-z]+$'),
        constraint outbox_messages_payload_is_object check (jsonb_typeof(payload) = 'object'),
        constraint outbox_messages_payload_event_id
          check (payload ->> 'eventId' = id::text and payload ->> 'eventType' = event_type),
        constraint outbox_messages_attempts_check check (attempts >= 0),
        constraint outbox_messages_lease_check check ((locked_by is null) = (locked_until is null))
      );
    `);
    this.addSql(`
      create index outbox_messages_pending
        on outbox_messages (occurred_at)
        where published_at is null;
    `);

    // O evento gravado e o que foi confirmado: payload e identidade nao mudam;
    // depois de publicado, nada mais muda (a limpeza por retencao usa DELETE).
    this.addSql(`
      create function outbox_messages_guard_update() returns trigger
      language plpgsql as $$
      begin
        if old.published_at is not null then
          raise exception 'evento % ja publicado', old.id using errcode = 'integrity_constraint_violation';
        end if;
        if (new.id, new.aggregate_id, new.event_type, new.payload, new.occurred_at)
           is distinct from (old.id, old.aggregate_id, old.event_type, old.payload, old.occurred_at) then
          raise exception 'conteudo do evento % e imutavel', old.id using errcode = 'integrity_constraint_violation';
        end if;
        return new;
      end;
      $$;
    `);
    this.addSql(`
      create trigger outbox_messages_guard_update before update on outbox_messages
        for each row execute function outbox_messages_guard_update();
    `);
  }

  override down(): void {
    this.addSql(`drop table outbox_messages;`);
    this.addSql(`drop function outbox_messages_guard_update();`);
    this.addSql(`drop table inbox_messages;`);
  }
}
