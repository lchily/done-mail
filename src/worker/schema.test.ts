import { describe, expect, it, vi } from 'vitest';
import { ensureMigrated, hasSchemaReadyMarker } from './schema';
import { migrations } from './migrations';
import appHandler from './index';
import type { Env } from './types';

interface MigrationRecord {
  version: number;
  name: string;
  checksum: string;
  applied_at: string;
}

interface DbCall {
  sql: string;
  params: unknown[];
}

function createEnv(initialMigrations: MigrationRecord[] = []) {
  const calls: DbCall[] = [];
  const applied = new Map(initialMigrations.map((row) => [row.version, row]));
  const locks = new Map<string, { owner: string; expires_at: string }>();

  const prepare = vi.fn((sql: string) => {
    const statement = {
      sql,
      bind: vi.fn((...params: unknown[]) => {
        calls.push({ sql, params });
        return statement;
      }),
      run: vi.fn(async () => {
        calls.push({ sql, params: [] });
        if (sql.includes('INSERT INTO schema_lock')) {
          const current = locks.get('migrations');
          const expired = !current || current.expires_at <= String(statement.__params[2] || new Date().toISOString());
          if (expired) {
            locks.set('migrations', { owner: String(statement.__params[0]), expires_at: String(statement.__params[1]) });
          }
          return { meta: { changes: expired ? 1 : 0 } };
        }
        if (sql.includes('schema_lock') && sql.startsWith('DELETE')) {
          const owner = String(statement.__params?.[0] || '');
          const current = locks.get('migrations');
          if (current?.owner === owner) locks.delete('migrations');
          return { meta: { changes: current?.owner === owner ? 1 : 0 } };
        }
        return { meta: { changes: 1 } };
      }),
      all: vi.fn(async () => {
        calls.push({ sql, params: [] });
        if (sql.includes('FROM schema_migrations')) {
          return { results: [...applied.values()].sort((a, b) => a.version - b.version) };
        }
        return { results: [] };
      }),
      first: vi.fn(async () => {
        calls.push({ sql, params: [] });
        if (sql.includes('FROM schema_lock')) return locks.get('migrations') || null;
        return null;
      }),
      __params: [] as unknown[]
    };

    statement.bind = vi.fn((...params: unknown[]) => {
      statement.__params = params;
      calls.push({ sql, params });
      return statement;
    });
    return statement;
  });

  const batch = vi.fn(async (statements: Array<{ sql?: string; __params?: unknown[] }>) => {
    for (const statement of statements) {
      const sql = String(statement.sql || '');
      const params = statement.__params || [];
      calls.push({ sql, params });
      if (sql.includes('INSERT INTO schema_migrations')) {
        applied.set(Number(params[0]), {
          version: Number(params[0]),
          name: String(params[1]),
          checksum: String(params[2]),
          applied_at: String(params[3])
        });
      }
      if (sql.includes('INSERT INTO schema_lock')) {
        const current = locks.get('migrations');
        const expired = !current || current.expires_at <= new Date().toISOString();
        if (expired) {
          locks.set('migrations', { owner: String(params[0]), expires_at: String(params[1]) });
        }
      }
    }
    return statements.map(() => ({ meta: { changes: 1 } }));
  });

  return {
    env: {
      DB: { prepare, batch },
      KV: { get: vi.fn(async () => null), put: vi.fn(async () => undefined), delete: vi.fn(async () => undefined) },
      ASSETS: { fetch: vi.fn(async () => new Response('', { status: 404 })) }
    } as unknown as Env,
    prepare,
    batch,
    calls,
    applied
  };
}

describe('schema migrations', () => {
  it('空 D1 首次访问会创建业务表和迁移记录', async () => {
    const { env, calls, applied } = createEnv();

    await ensureMigrated(env);

    expect(calls.some((call) => call.sql.includes('CREATE TABLE IF NOT EXISTS schema_migrations'))).toBe(true);
    expect(calls.some((call) => call.sql.includes('CREATE TABLE IF NOT EXISTS schema_lock'))).toBe(true);
    expect(calls.some((call) => call.sql.includes('CREATE TABLE IF NOT EXISTS mails'))).toBe(true);
    expect(calls.some((call) => call.sql.includes('CREATE VIRTUAL TABLE IF NOT EXISTS mails_fts') && call.sql.includes('subject') && call.sql.includes('addresses') && !call.sql.includes('content'))).toBe(true);
    expect(calls.some((call) => call.sql.includes('CREATE TABLE IF NOT EXISTS mail_body_chunks'))).toBe(true);
    expect(calls.some((call) => call.sql.includes('CREATE VIRTUAL TABLE IF NOT EXISTS mail_content_fts'))).toBe(true);
    expect(calls.some((call) => call.sql.includes('CREATE TABLE IF NOT EXISTS rate_limits'))).toBe(true);
    for (const migration of migrations) {
      expect(applied.has(migration.version)).toBe(true);
    }
    expect(calls.some((call) => call.sql.includes('CREATE TABLE IF NOT EXISTS mail_public_bodies'))).toBe(true);
    expect(calls.some((call) => call.sql.includes('CREATE TABLE IF NOT EXISTS mail_safe_bodies'))).toBe(true);
    expect(calls.some((call) => call.sql.includes('INSERT OR REPLACE INTO mail_safe_bodies') && call.sql.includes('FROM mail_public_bodies'))).toBe(true);
    expect(calls.some((call) => call.sql.includes('DROP TABLE IF EXISTS mail_public_bodies'))).toBe(true);
  });

  it('迁移完成后写入 schema ready marker，公开 API 可快速判定', async () => {
    const { env } = createEnv();

    await ensureMigrated(env);

    await expect(hasSchemaReadyMarker(env)).resolves.toBe(true);
    expect(env.KV.put).toHaveBeenCalledWith('schema:ready', String(migrations[migrations.length - 1].version));
  });

  it('同一个环境已迁移后不再查 D1', async () => {
    const { env, calls } = createEnv();

    await ensureMigrated(env);
    const count = calls.length;
    await ensureMigrated(env);

    expect(calls).toHaveLength(count);
  });

  it('并发触发迁移时共享同一个执行 Promise', async () => {
    const { env, batch } = createEnv();

    await Promise.all([ensureMigrated(env), ensureMigrated(env), ensureMigrated(env)]);

    const migrationBatches = batch.mock.calls.filter(([statements]) =>
      String((statements as Array<{ sql?: string }>)[(statements as Array<{ sql?: string }>).length - 1]?.sql || '').includes('INSERT INTO schema_migrations')
    );
    expect(migrationBatches).toHaveLength(migrations.length);
  });

  it('/api/health 不触发迁移', async () => {
    const { env, calls } = createEnv();

    const response = await appHandler.fetch(new Request('https://example.com/api/health'), env, {} as ExecutionContext);

    expect(response.status).toBe(200);
    expect(calls.some((call) => call.sql.includes('schema_migrations'))).toBe(false);
  });
});
