import { Migrator } from "@mikro-orm/migrations";
import { type Options, defineConfig } from "@mikro-orm/postgresql";
import { MIGRATIONS } from "./migrations";
import { ENTITY_SCHEMAS } from "./records";

export function ormConfig(databaseUrl: string, overrides: Options = {}): Options {
  return defineConfig({
    clientUrl: databaseUrl,
    entities: ENTITY_SCHEMAS,
    extensions: [Migrator],
    migrations: {
      tableName: "schema_migrations",
      migrationsList: MIGRATIONS,
      // Migrations sao escritas a mao (constraints, triggers, indices parciais): sem snapshot de diff.
      snapshot: false,
      snapshotOnMigrate: false,
      transactional: true,
      allOrNothing: true,
      silent: true,
    },
    debug: false,
    ...overrides,
  });
}
