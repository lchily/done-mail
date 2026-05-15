import type { MigrationDefinition } from './types';

export const migration: MigrationDefinition = {
  name: 'public_body_fast_path',
  statements: [
    `CREATE TABLE IF NOT EXISTS mail_public_bodies (
      mail_id TEXT PRIMARY KEY,
      text_body TEXT,
      html_body TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`
  ]
};
