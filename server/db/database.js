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
  },
  {
    version: 6,
    sql: `
      CREATE TABLE IF NOT EXISTS plugins (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        config TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS plugins_type_idx ON plugins(type);
      CREATE INDEX IF NOT EXISTS plugins_enabled_idx ON plugins(enabled);
    `
  },
  {
    // Plugins are now a curated catalog of MCP servers, so every row has to name one of the
    // shipped presets. That leaves two kinds of stale row: the original GitHub OAuth plugin
    // (type 'github', an OAuth token in config) and the first-cut MCP plugin that could point at
    // an arbitrary URL or command (preset 'custom'). Neither shape can be connected any more, so
    // both are rewritten as a fresh GitHub MCP plugin. The stored credential is deliberately not
    // carried over: an OAuth token does not authenticate against the MCP endpoint, and a custom
    // server's header/env secrets have no place in a preset config.
    version: 7,
    apply(db) {
      for (const row of db.prepare('SELECT id, type, config FROM plugins').all()) {
        let config = {};
        try { config = JSON.parse(row.config) || {}; } catch { config = {}; }
        const preset = String(config.preset || '').toLowerCase();
        if (String(row.type).toLowerCase() === 'mcp' && preset && preset !== 'custom') continue;
        const next = { preset: 'github', github: { mode: 'remote' } };
        db.prepare('UPDATE plugins SET type = ?, config = ?, updated_at = ? WHERE id = ?')
          .run('mcp', JSON.stringify(next), now(), row.id);
      }
    }
  },
  {
    // Workspace preferences that outlive a request but are not environment configuration, so
    // they belong in the database rather than in .env. One row per named setting, JSON value.
    version: 8,
    sql: `
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `
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
