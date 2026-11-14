import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261113233550_minor_devos",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`message_bookmark\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`message_id\` text NOT NULL,
          \`text\` text NOT NULL,
          \`created\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_message_bookmark_session_id_session_v2_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`my_message\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`message_id\` text NOT NULL,
          \`ordinal\` integer NOT NULL,
          \`text\` text NOT NULL,
          \`created\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_my_message_session_id_session_v2_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`message_bookmark_session_message_idx\` ON \`message_bookmark\` (\`session_id\`,\`message_id\`);`,
      )
      yield* tx.run(`CREATE INDEX \`message_bookmark_session_idx\` ON \`message_bookmark\` (\`session_id\`);`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`my_message_session_message_ordinal_idx\` ON \`my_message\` (\`session_id\`,\`message_id\`,\`ordinal\`);`,
      )
      yield* tx.run(`CREATE INDEX \`my_message_session_idx\` ON \`my_message\` (\`session_id\`);`)
    })
  },
}

export default migration
