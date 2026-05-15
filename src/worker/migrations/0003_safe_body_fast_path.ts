import type { MigrationDefinition } from './types';

export const migration: MigrationDefinition = {
  name: 'safe_body_fast_path',
  statements: [
    `CREATE TABLE IF NOT EXISTS mail_safe_bodies (
      mail_id TEXT PRIMARY KEY,
      text_body TEXT,
      html_body TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`,
    `INSERT OR REPLACE INTO mail_safe_bodies (mail_id, text_body, html_body, created_at)
     SELECT mail_id, text_body, html_body, created_at
     FROM mail_public_bodies`,
    `DROP TABLE IF EXISTS mail_public_bodies`
  ]
};
