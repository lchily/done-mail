import { describe, expect, it, vi } from 'vitest';
import { getMailBody, listSafeMailBodies } from './mail-bodies';
import type { Env } from './types';

function createEnv(options: { safeBody?: Record<string, unknown> | null; safeRows?: Record<string, unknown>[] } = {}) {
  const calls: string[] = [];
  const batch = vi.fn(async () => []);
  const prepare = vi.fn((sql: string) => {
    calls.push(sql);
    const statement = {
      sql,
      bind: vi.fn(() => statement),
      first: vi.fn(async () => {
        if (sql.includes('FROM mail_bodies')) return { headersJson: '{"from":"a@example.com"}' };
        if (sql.includes('FROM mail_safe_bodies')) return options.safeBody ?? null;
        return null;
      }),
      all: vi.fn(async () => ({
        results: sql.includes('FROM mail_safe_bodies')
          ? options.safeRows || (options.safeBody ? [{ mailId: 'mail_1', ...options.safeBody }] : [])
          : [
            { mailId: 'mail_1', kind: 'text', chunkIndex: 0, content: '慢正文' },
            { mailId: 'mail_1', kind: 'html', chunkIndex: 0, content: '<p>慢正文<script>alert(1)</script></p>' },
            { mailId: 'mail_2', kind: 'text', chunkIndex: 0, content: '第二封' },
            { mailId: 'mail_2', kind: 'html', chunkIndex: 0, content: '<p>第二封<script>alert(2)</script></p>' }
          ]
      })),
      run: vi.fn(async () => ({ meta: { changes: 1 } }))
    };
    return statement;
  });
  return {
    env: {
      DB: { prepare, batch }
    } as unknown as Env,
    calls,
    batch
  };
}

describe('mail bodies', () => {
  it('详情正文优先读取快读表，不扫描分块正文', async () => {
    const { env, calls } = createEnv({
      safeBody: { textBody: '快正文', htmlBody: '<p>快正文</p>' }
    });

    const body = await getMailBody(env, 'mail_1');

    expect(body).toMatchObject({
      textBody: '快正文',
      htmlBody: '<p>快正文</p>',
      headersJson: '{"from":"a@example.com"}'
    });
    expect(calls.some((sql) => sql.includes('FROM mail_body_chunks'))).toBe(false);
  });

  it('旧邮件缺少快读正文时回退分块正文，并后台补快读表', async () => {
    const { env, calls, batch } = createEnv({ safeBody: null });
    const waitUntil = vi.fn();

    const body = await getMailBody(env, 'mail_1', { waitUntil });

    expect(body.textBody).toBe('慢正文');
    expect(body.htmlBody).toBe('<p>慢正文</p>');
    expect(calls.some((sql) => sql.includes('FROM mail_body_chunks'))).toBe(true);
    expect(calls.some((sql) => sql.includes('INSERT OR REPLACE INTO mail_safe_bodies'))).toBe(true);
    expect(waitUntil).toHaveBeenCalledTimes(1);
    await waitUntil.mock.calls[0][0];
    expect(batch).toHaveBeenCalledTimes(1);
  });

  it('批量正文缺少快读行时只回退缺失邮件，并后台补快读表', async () => {
    const { env, calls, batch } = createEnv({
      safeRows: [{ mailId: 'mail_1', textBody: '已有快正文', htmlBody: '<p>已有快正文</p>' }]
    });
    const waitUntil = vi.fn();

    const bodies = await listSafeMailBodies(env, ['mail_1', 'mail_2'], { waitUntil });

    expect(bodies.get('mail_1')).toEqual({ textBody: '已有快正文', htmlBody: '<p>已有快正文</p>' });
    expect(bodies.get('mail_2')).toEqual({ textBody: '第二封', htmlBody: '<p>第二封</p>' });
    const chunkCall = calls.find((sql) => sql.includes('FROM mail_body_chunks'));
    expect(chunkCall).toBeTruthy();
    expect(calls.some((sql) => sql.includes('INSERT OR REPLACE INTO mail_safe_bodies'))).toBe(true);
    expect(waitUntil).toHaveBeenCalledTimes(1);
    await waitUntil.mock.calls[0][0];
    expect(batch).toHaveBeenCalledTimes(1);
  });
});
