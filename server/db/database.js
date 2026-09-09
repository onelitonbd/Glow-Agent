import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const migrations = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS providers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL COLLATE NOCASE UNIQUE,
        base_url TEXT NOT NULL,
        credential_data TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS provider_models (
        id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
        model_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(provider_id, model_id)
      );
      CREATE INDEX IF NOT EXISTS provider_models_provider_id_idx ON provider_models(provider_id);
      CREATE TABLE IF NOT EXISTS skills (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL COLLATE NOCASE UNIQUE,
        description TEXT NOT NULL,
        instructions TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
        content TEXT NOT NULL,
        provider_id TEXT REFERENCES providers(id) ON DELETE SET NULL,
        model_id TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS messages_conversation_id_created_at_idx ON messages(conversation_id, created_at);
    `
  },
  {
    version: 2,
    sql: `ALTER TABLE messages ADD COLUMN tool_events TEXT;`
  },
  {
    version: 3,
    apply(db) {
      const columns = db.prepare('PRAGMA table_info(providers)').all();
      if (columns.some((column) => column.name === 'credential_ciphertext')) {
        db.exec('ALTER TABLE providers RENAME COLUMN credential_ciphertext TO credential_data;');
      }
    }
  },
  {
    version: 4,
    sql: `ALTER TABLE messages ADD COLUMN reasoning TEXT;`
  },
  {
    version: 5,
    sql: `ALTER TABLE messages ADD COLUMN timeline TEXT;`
  }
];

export function now() {
  return new Date().toISOString();
}

export function createDatabase(databasePath) {
  mkdirSync(dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);');
  const applied = new Set(db.prepare('SELECT version FROM schema_migrations').all().map((row) => row.version));
  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    db.exec('BEGIN IMMEDIATE;');
    try {
      if (migration.apply) migration.apply(db);
      else db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(migration.version, now());
      db.exec('COMMIT;');
    } catch (error) {
      db.exec('ROLLBACK;');
      throw error;
    }
  }
  return db;
}
