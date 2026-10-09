import { expect } from "bun:test";
import { SQL } from "bun";
import { MikroORM } from "@mikro-orm/postgresql";
import { loadConfig } from "../../src/config";
import { ormConfig } from "../../src/infrastructure/persistence/orm.config";

export interface TestDatabase {
  readonly url: string;
  readonly orm: MikroORM;
  readonly sql: SQL;
  drop(): Promise<void>;
}

/**
 * Banco novo e isolado por arquivo de teste, com as migrations aplicadas.
 * Postgres real do docker compose: nada de mock.
 */
export async function createTestDatabase(options: { migrate?: boolean } = {}): Promise<TestDatabase> {
  const baseUrl = loadConfig().databaseUrl;
  const name = `test_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;

  await withAdmin(baseUrl, (admin) => admin.unsafe(`create database "${name}"`));

  const url = new URL(baseUrl);
  url.pathname = `/${name}`;
  const orm = await MikroORM.init(ormConfig(url.toString()));
  if (options.migrate ?? true) {
    await orm.migrator.up();
  }
  const sql = new SQL(url.toString());

  return {
    url: url.toString(),
    orm,
    sql,
    async drop() {
      await sql.close();
      await orm.close();
      await withAdmin(baseUrl, (admin) => admin.unsafe(`drop database if exists "${name}" with (force)`));
    },
  };
}

async function withAdmin(url: string, run: (admin: SQL) => Promise<unknown>): Promise<void> {
  const admin = new SQL(url);
  try {
    await run(admin);
  } finally {
    await admin.close();
  }
}

/**
 * `expect(query).rejects` com a query do Bun SQL direto nunca resolve no bun test 1.4
 * (a query e um thenable preguicoso). Embrulhar numa Promise de verdade resolve.
 */
export function expectAsync(value: PromiseLike<unknown>) {
  return expect(Promise.resolve(value));
}
