import { describe, expect, it } from 'vitest';
import worker from './index';
import { initializeAdminKey } from './auth';
import { createMailShare } from './mail-share';
import type { Env } from './types';

function createKv(initial: Record<string, string> = {}) {
  const calls: string[] = [];
  const store = new Map(Object.entries(initial));
  return {
    calls,
    get: async (key: string) => {
      calls.push(key);
      return store.get(key) || null;
    },
    put: async (key: string, value: string) => {
      calls.push(`put:${key}`);
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    }
  };
}

function createDb() {
  const rateLimits = new Map<string, { scope: string; count: number; reset_at: number; updated_at: number }>();
  const applied = new Map<number, string>();
  const result = { all: async () => ({ results: [] }), first: async () => null, run: async () => ({ meta: { changes: 0 } }) };
  return {
    prepare: (sql: string) => {
      if (sql.includes('SELECT version, checksum FROM schema_migrations')) {
        return {
          all: async () => ({ results: [...applied].map(([version, checksum]) => ({ version, checksum })) })
        };
      }
      if (sql.includes('INSERT INTO schema_lock')) {
        return {
          bind: () => ({
            run: async () => ({ meta: { changes: 1 } })
          })
        };
      }
      if (sql.includes("DELETE FROM schema_lock")) {
        return {
          bind: () => ({
            run: async () => ({ meta: { changes: 1 } })
          })
        };
      }
      if (sql.includes('INSERT INTO rate_limits')) {
        return {
          bind: (key: string, scope: string, resetAt: number, now: number) => ({
            first: async () => {
              const current = rateLimits.get(key);
              const next =
                !current || current.reset_at <= now
                  ? { scope, count: 1, reset_at: resetAt, updated_at: now }
                  : { scope: current.scope, count: current.count + 1, reset_at: current.reset_at, updated_at: now };
              rateLimits.set(key, next);
              return { count: next.count };
            }
          })
        };
      }
      if (sql.includes('SELECT id FROM mails')) {
        return {
          bind: () => ({
            first: async () => ({ id: 'mail_1' })
          })
        };
      }
      return {
        bind: () => result,
        ...result
      };
    },
    batch: async (statements: Array<{ sql?: string; __params?: unknown[] }>) => {
      for (const statement of statements) {
        const sql = String(statement.sql || '');
        if (sql.includes('INSERT INTO schema_migrations')) {
          applied.set(Number(statement.__params?.[0] || 0), String(statement.__params?.[2] || ''));
        }
      }
      return statements.map(() => ({ meta: { changes: 1 } }));
    }
  };
}

async function createEnv(system: Record<string, unknown>) {
  const env = {
    KV: createKv({
      'config:system': JSON.stringify({
        cleanupEnabled: true,
        mailRetentionDays: 30,
        acceptForwardedMail: true,
        adminBaseUrl: '',
        shareBaseUrl: '',
        mailShareTtlHours: 168,
        rateLimit: { login: 10, publicApi: 10, publicShare: 100 },
        ...system
      })
    }),
    DB: createDb(),
    ASSETS: {
      fetch: async (req: Request) => new Response(new URL(req.url).pathname, { status: 200 })
    }
  } as unknown as Env;
  await initializeAdminKey(env, 'admin-key-123');
  return env;
}

const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;

describe('worker entry guard', () => {
  it('未配置后台入口时不限制访问入口', async () => {
    const env = await createEnv({});
    const response = await worker.fetch(new Request('https://share.example.com/login'), env, ctx);

    expect(response.status).toBe(200);
  });

  it('分享入口不暴露后台页面', async () => {
    const env = await createEnv({
      adminBaseUrl: 'https://admin.example.com',
      shareBaseUrl: 'https://share.example.com'
    });
    const response = await worker.fetch(new Request('https://share.example.com/login'), env, ctx);

    expect(response.status).toBe(404);
  });

  it('后台入口允许访问后台页面', async () => {
    const env = await createEnv({
      adminBaseUrl: 'https://admin.example.com',
      shareBaseUrl: 'https://share.example.com'
    });
    const response = await worker.fetch(new Request('https://admin.example.com/login'), env, ctx);

    expect(response.status).toBe(200);
  });

  it('分享入口不暴露 API', async () => {
    const env = await createEnv({
      adminBaseUrl: 'https://admin.example.com',
      shareBaseUrl: 'https://share.example.com'
    });

    const response = await worker.fetch(new Request('https://share.example.com/api/mails'), env, ctx);

    expect(response.status).toBe(404);
  });

  it('静态资源直接走 Assets，不读取入口配置', async () => {
    const kv = createKv();
    const env = {
      KV: kv,
      DB: createDb(),
      ASSETS: {
        fetch: async (req: Request) => new Response(new URL(req.url).pathname, { status: 200 })
      }
    } as unknown as Env;

    const response = await worker.fetch(new Request('https://share.example.com/assets/index.js'), env, ctx);

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe('/assets/index.js');
    expect(kv.calls).toEqual([]);
  });

  it('未限制入口的 API 请求不读取系统配置，数据库未就绪时快速返回初始化中', async () => {
    const kv = createKv();
    const env = {
      KV: kv,
      DB: createDb(),
      ASSETS: {
        fetch: async (req: Request) => new Response(new URL(req.url).pathname, { status: 200 })
      }
    } as unknown as Env;

    const response = await worker.fetch(new Request('https://share.example.com/api/mails'), env, ctx);

    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('3');
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'schema_initializing' } });
    expect(kv.calls).not.toContain('config:system');
  });

  it('分享页访问使用分享链接访问限流', async () => {
    const env = await createEnv({
      adminBaseUrl: 'https://admin.example.com',
      shareBaseUrl: 'https://share.example.com',
      rateLimit: { login: 10, publicApi: 10, publicShare: 1 }
    });
    const share = await createMailShare(env, 'mail_1');
    const init = { headers: { 'CF-Connecting-IP': '203.0.113.20' } };

    const first = await worker.fetch(new Request(`https://share.example.com/mail/${share.token}`, init), env, ctx);
    const second = await worker.fetch(new Request(`https://share.example.com/mail/${share.token}`, init), env, ctx);

    expect(first.status).toBe(404);
    expect(second.status).toBe(429);
    await expect(second.text()).resolves.toContain('访问过于频繁');
  });

  it('分享附件下载使用分享链接访问限流', async () => {
    const env = await createEnv({
      adminBaseUrl: 'https://admin.example.com',
      shareBaseUrl: 'https://share.example.com',
      rateLimit: { login: 10, publicApi: 10, publicShare: 1 }
    });
    const share = await createMailShare(env, 'mail_1');
    const init = { headers: { 'CF-Connecting-IP': '203.0.113.21' } };

    const first = await worker.fetch(new Request(`https://share.example.com/mail/${share.token}/attachments/att_1`, init), env, ctx);
    const second = await worker.fetch(new Request(`https://share.example.com/mail/${share.token}/attachments/att_1`, init), env, ctx);

    expect(first.status).toBe(404);
    expect(second.status).toBe(429);
    await expect(second.text()).resolves.toContain('访问过于频繁');
  });
});
