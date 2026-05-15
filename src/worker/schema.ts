import { migrations, type Migration } from './migrations';
import type { Env } from './types';

const migrationLeaseMs = 30_000;
const migrationPollMs = 250;
const migrationWaitMs = 10_000;
const schemaReadyKey = 'schema:ready';
const schemaReady = new WeakMap<Env, Promise<void>>();
const schemaReadyMarker = new WeakMap<Env, true>();

interface MigrationRow {
  version: number;
  checksum: string;
}

interface LockRow {
  owner: string;
  expires_at: string;
}

function nowIso(ms = Date.now()) {
  return new Date(ms).toISOString();
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function migrationChecksum(migration: Migration) {
  const input = `${migration.version}:${migration.name}:${JSON.stringify(migration.statements)}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function ensureMigrationTables(env: Env) {
  await env.DB.batch([
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )`
    ),
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS schema_lock (
        name TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        expires_at TEXT NOT NULL
      )`
    )
  ]);
}

async function acquireMigrationLock(env: Env, owner: string) {
  const expiresAt = nowIso(Date.now() + migrationLeaseMs);
  const result = await env.DB.prepare(
    `INSERT INTO schema_lock (name, owner, expires_at)
     VALUES ('migrations', ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       owner = excluded.owner,
       expires_at = excluded.expires_at
     WHERE schema_lock.expires_at <= ?`
  )
    .bind(owner, expiresAt, nowIso())
    .run();
  return Number(result.meta.changes || 0) > 0;
}

async function releaseMigrationLock(env: Env, owner: string) {
  await env.DB.prepare(`DELETE FROM schema_lock WHERE name = 'migrations' AND owner = ?`).bind(owner).run();
}

async function readAppliedMigrations(env: Env) {
  const rows = await env.DB.prepare(`SELECT version, checksum FROM schema_migrations ORDER BY version ASC`).all<MigrationRow>();
  return new Map((rows.results || []).map((row) => [Number(row.version), String(row.checksum || '')]));
}

async function hasPendingMigrations(env: Env) {
  const applied = await readAppliedMigrations(env);
  for (const migration of migrations) {
    if (!applied.has(migration.version)) return true;
    const checksum = await migrationChecksum(migration);
    if (applied.get(migration.version) !== checksum) {
      throw new Error(`数据库迁移 ${migration.version} 校验不一致，请检查部署版本`);
    }
  }
  return false;
}

function latestMigrationVersion() {
  return migrations[migrations.length - 1]?.version || 0;
}

export async function hasSchemaReadyMarker(env: Env) {
  if (schemaReadyMarker.get(env)) return true;
  const value = await env.KV.get(schemaReadyKey);
  if (value === String(latestMigrationVersion())) {
    schemaReadyMarker.set(env, true);
    return true;
  }
  return false;
}

async function waitForMigration(env: Env) {
  const deadline = Date.now() + migrationWaitMs;
  while (Date.now() < deadline) {
    if (!(await hasPendingMigrations(env))) return;
    await sleep(migrationPollMs);
  }
  const lock = await env.DB.prepare(`SELECT owner, expires_at FROM schema_lock WHERE name = 'migrations'`).first<LockRow>();
  throw new Error(`数据库正在初始化，请稍后重试${lock?.owner ? `（${lock.owner}）` : ''}`);
}

async function applyPendingMigrations(env: Env) {
  const applied = await readAppliedMigrations(env);
  for (const migration of migrations) {
    const checksum = await migrationChecksum(migration);
    const currentChecksum = applied.get(migration.version);
    if (currentChecksum) {
      if (currentChecksum !== checksum) {
        throw new Error(`数据库迁移 ${migration.version} 校验不一致，请检查部署版本`);
      }
      continue;
    }

    await env.DB.batch([
      ...migration.statements.map((sql) => env.DB.prepare(sql)),
      env.DB.prepare(
        `INSERT INTO schema_migrations (version, name, checksum, applied_at)
         VALUES (?, ?, ?, ?)`
      ).bind(migration.version, migration.name, checksum, nowIso())
    ]);
    applied.set(migration.version, checksum);
  }
}

export async function ensureMigrated(env: Env) {
  const ready = schemaReady.get(env);
  if (ready) return ready;

  const next = ensureMigratedOnce(env).catch((error) => {
    schemaReady.delete(env);
    throw error;
  });
  schemaReady.set(env, next);
  return next;
}

async function ensureMigratedOnce(env: Env) {
  await ensureMigrationTables(env);
  if (!(await hasPendingMigrations(env))) {
    await env.KV.put(schemaReadyKey, String(latestMigrationVersion()));
    schemaReadyMarker.set(env, true);
    return;
  }

  const owner = crypto.randomUUID();
  if (!(await acquireMigrationLock(env, owner))) {
    await waitForMigration(env);
    return;
  }

  try {
    await applyPendingMigrations(env);
    await env.KV.put(schemaReadyKey, String(latestMigrationVersion()));
    schemaReadyMarker.set(env, true);
  } finally {
    await releaseMigrationLock(env, owner).catch(() => undefined);
  }
}
