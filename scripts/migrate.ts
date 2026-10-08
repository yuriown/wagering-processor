import { MikroORM } from "@mikro-orm/postgresql";
import { loadConfig } from "../src/config";
import { ormConfig } from "../src/infrastructure/persistence/orm.config";

// bun run db:migrate            aplica as pendentes
// bun run db:rollback           desfaz a ultima
// bun run db:rollback -- --all  desfaz todas
// bun run db:status             lista executadas e pendentes
const [command = "up", flag] = process.argv.slice(2);
const orm = await MikroORM.init(ormConfig(loadConfig().databaseUrl));

try {
  const migrator = orm.migrator;
  if (command === "up") {
    const applied = await migrator.up();
    console.log(applied.length ? applied.map((m) => `+ ${m.name}`).join("\n") : "nada pendente");
  } else if (command === "down") {
    const reverted = flag === "--all" ? await migrator.down({ to: 0 }) : await migrator.down();
    console.log(reverted.length ? reverted.map((m) => `- ${m.name}`).join("\n") : "nada para desfazer");
  } else if (command === "status") {
    for (const m of await migrator.getExecuted()) console.log(`executada  ${m.name}`);
    for (const m of await migrator.getPending()) console.log(`pendente   ${m.name}`);
  } else {
    console.error(`comando desconhecido: ${command} (use up, down ou status)`);
    process.exitCode = 1;
  }
} finally {
  await orm.close();
}
