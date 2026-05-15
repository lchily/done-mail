import { describe, expect, it, vi } from 'vitest';
import mailsRoutes, { publicMailsRoutes } from './mails';
import type { Env } from '../types';

interface DbCall {
  sql: string;
  params: unknown[];
}

function createEnv() {
  const calls: DbCall[] = [];
  const kv = new Map<string, string>();
  const rows = [
    {
      id: 'mail_2',
      messageId: 'msg_2',
      fromAddr: 'billing@stripe.example',
      fromName: 'Stripe 账单',
      toAddr: 'pay@example.com',
      domain: 'example.com',
      receivedByAddr: 'pay@example.com',
      isForwarded: 0,
      subject: 'Invoice June',
      bodyPreview: '六月账单',
      hasAttachments: 0,
      attachmentCount: 0,
      rawSize: 120,
      receivedAt: '2026-06-01T00:00:00.000Z',
      createdAt: '2026-06-01T00:00:00.000Z'
    },
    {
      id: 'mail_1',
      messageId: 'msg_1',
      fromAddr: 'billing@stripe.example',
      fromName: 'Stripe 账单',
      toAddr: 'pay@example.com',
      domain: 'example.com',
      receivedByAddr: 'pay@example.com',
      isForwarded: 0,
      subject: 'Invoice May',
      bodyPreview: '五月账单',
      hasAttachments: 1,
      attachmentCount: 1,
      rawSize: 188,
      receivedAt: '2026-05-01T00:00:00.000Z',
      createdAt: '2026-05-01T00:00:00.000Z'
    }
  ];
  const chunks = {
    results: [
      {
        mailId: 'mail_2',
        kind: 'text',
        chunkIndex: 0,
        content: '六月完整正文'
      },
      {
        mailId: 'mail_2',
        kind: 'html',
        chunkIndex: 0,
        content: '<p>六月完整正文</p>'
      },
      {
        mailId: 'mail_1',
        kind: 'text',
        chunkIndex: 0,
        content: '五月完整正文'
      },
      {
        mailId: 'mail_1',
        kind: 'html',
        chunkIndex: 0,
        content: '<p>五月完整正文<script>alert(1)</script></p>'
      }
    ]
  };
  const body = {
    headersJson: '{"x-test":"1"}'
  };
  const attachments = {
    results: [
      {
        id: 'att_1',
        mailId: 'mail_2',
        filename: 'invoice.pdf',
        mimeType: 'application/pdf',
        size: 1024,
        contentId: '',
        disposition: 'attachment',
        stored: 1
      }
    ]
  };

  const prepare = vi.fn((sql: string) => {
    const statement = {
      bind: vi.fn((...params: unknown[]) => {
        calls.push({ sql, params });
        return statement;
      }),
      first: vi.fn(async () => {
        if (sql.includes('FROM mail_bodies')) return body;
        if (sql.includes('FROM mails')) return rows[1];
        return null;
      }),
      all: vi.fn(async () => {
        if (sql.includes('FROM mail_attachments')) return attachments;
        if (sql.includes('FROM mail_safe_bodies')) return { results: [] };
        if (sql.includes('FROM mail_body_chunks')) return chunks;
        return { results: rows };
      })
    };
    return statement;
  });

  return {
    env: {
      DB: { prepare, batch: vi.fn(async () => []) },
      KV: {
        get: vi.fn(async (key: string) => kv.get(key) || (key === 'config:system' ? JSON.stringify({
          cleanupEnabled: true,
          mailRetentionDays: 30,
          acceptForwardedMail: true,
          shareBaseUrl: 'https://mail.example.com',
          mailShareTtlHours: 72,
          rateLimit: { login: 10, publicApi: 10, publicShare: 100 }
        }) : null)),
        put: vi.fn(async (key: string, value: string) => {
          kv.set(key, value);
        }),
        delete: vi.fn(async (key: string) => {
          kv.delete(key);
        })
      }
    } as unknown as Env,
    prepare,
    calls
  };
}

describe('public mails route', () => {
  it('公开邮件查询走字段化 FTS，不使用 LIKE，且默认不查附件元信息', async () => {
    const { env, calls } = createEnv();
    const cursor = btoa(JSON.stringify({ receivedAt: '2026-07-01T00:00:00.000Z', id: 'mail_3' }));
    const url = new URL('https://example.com/');
    url.searchParams.set('limit', '1');
    url.searchParams.set('cursor', cursor);
    url.searchParams.set('from', 'BILLING@STRIPE.EXAMPLE');
    url.searchParams.set('to', 'PAY@EXAMPLE.COM');
    url.searchParams.set('toDomain', 'EXAMPLE.COM');
    url.searchParams.set('subject', 'Invoice');
    url.searchParams.set('content', '完整正文');
    url.searchParams.set('hasAttachments', 'true');

    const response = await publicMailsRoutes.fetch(new Request(url), env);
    const body = await response.json() as {
      ok: boolean;
      data: Array<{ id: string; text: string; html: string; attachments?: Array<{ id: string; stored: boolean }> }>;
      pagination: { limit: number; hasMore: boolean; nextCursor: string };
    };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({ id: 'mail_2' });
    expect(body.data[0].text).toBe('六月完整正文');
    expect(body.data[0].html).toBe('<p>六月完整正文</p>');
    expect(body.data[0]).not.toHaveProperty('attachments');
    expect(body.pagination).toMatchObject({ limit: 1, hasMore: true });
    expect(body.pagination.nextCursor).toBeTruthy();

    const listCall = calls[0];
    expect(calls.some((call) => call.sql.includes('FROM mail_attachments'))).toBe(false);
    expect(listCall.sql).toContain('mails_fts MATCH ?');
    expect(listCall.sql).toContain('mail_content_fts MATCH ?');
    expect(listCall.sql).toContain('INTERSECT');
    expect(listCall.sql).not.toContain('term_0');
    expect(listCall.sql).not.toContain('LEFT JOIN mail_bodies');
    expect(listCall.sql).toContain('mails.from_addr = ?');
    expect(listCall.sql).toContain('mails.to_addr = ?');
    expect(listCall.sql).toContain('mails.domain = ?');
    expect(listCall.sql).toContain('mails.has_attachments = ?');
    expect(listCall.sql).toContain('ORDER BY mails.received_at DESC, mails.id DESC');
    expect(listCall.sql.toLowerCase()).not.toContain(' like ');
    expect(String(listCall.params[0])).toContain('subject : "invoice"*');
    expect(String(listCall.params[1])).toContain('"完整"*');
    expect(String(listCall.params[1])).toContain('"正文"*');
    expect(String(listCall.params[1])).toContain('"整正"*');
    expect(listCall.params.slice(2)).toEqual([
      'billing@stripe.example',
      'pay@example.com',
      'example.com',
      1,
      '2026-07-01T00:00:00.000Z',
      '2026-07-01T00:00:00.000Z',
      'mail_3',
      2
    ]);
  });

  it('公开邮件列表只有 includeAttachments=true 时返回附件元信息', async () => {
    const { env, calls } = createEnv();

    const response = await publicMailsRoutes.fetch(new Request('https://example.com/?includeAttachments=true'), env);
    const body = await response.json() as {
      data: Array<{ id: string; attachments: Array<{ id: string; stored: boolean }> }>;
    };

    expect(response.status).toBe(200);
    expect(body.data[0].attachments).toEqual([expect.objectContaining({ id: 'att_1', stored: true })]);
    expect(calls.some((call) => call.sql.includes('FROM mail_attachments'))).toBe(true);
  });

  it('公开邮件布尔参数不接受 0、1、yes、no 别名', async () => {
    const { env, calls } = createEnv();

    const response = await publicMailsRoutes.fetch(new Request('https://example.com/?includeAttachments=1&hasAttachments=yes'), env);
    const body = await response.json() as {
      ok: boolean;
      error: { code: string; message: string };
    };

    expect(response.status).toBe(400);
    expect(body).toMatchObject({ ok: false, error: { code: 'invalid_boolean' } });
    expect(body.error.message).toContain('hasAttachments');
    expect(calls).toHaveLength(0);
  });

  it('内部关键词搜索保留逐词跨主题和正文命中语义，不按词生成 CTE', async () => {
    const { env, calls } = createEnv();

    const response = await mailsRoutes.fetch(new Request('https://example.com/?keyword=Invoice 完整正文'), env);

    expect(response.status).toBe(200);
    const listCall = calls[0];
    expect(listCall.sql).toContain('mails_fts MATCH ?');
    expect(listCall.sql).toContain('mail_content_fts MATCH ?');
    expect(listCall.sql).toContain('INTERSECT');
    expect(listCall.sql.match(/UNION/g)).toHaveLength(4);
    expect(listCall.sql).not.toContain('term_0');
    expect(listCall.sql).not.toContain('term_1');
    expect(String(listCall.params[0])).toContain('"invoice"*');
    expect(String(listCall.params[1])).toContain('"invoice"*');
    expect(String(listCall.params[2])).toContain('"完整"*');
    expect(String(listCall.params[3])).toContain('"完整"*');
    expect(String(listCall.params[4])).toContain('"正文"*');
    expect(String(listCall.params[5])).toContain('"正文"*');
    expect(String(listCall.params[6])).toContain('"整正"*');
    expect(String(listCall.params[7])).toContain('"整正"*');
  });

  it('公开邮件列表默认返回正文并限制单页大小', async () => {
    const { env, calls } = createEnv();

    const response = await publicMailsRoutes.fetch(new Request('https://example.com/?limit=100'), env);
    const body = await response.json() as {
      data: Array<{ id: string; text: string; html: string; attachmentCount: number }>;
      pagination: { hasMore: boolean; nextCursor: string };
    };

    expect(response.status).toBe(200);
    expect(body.data.map((item) => item.id)).toEqual(['mail_2', 'mail_1']);
    expect(body.data[1].text).toBe('五月完整正文');
    expect(body.data[1].html).not.toContain('<script');
    expect(body.data[1].attachmentCount).toBe(1);
    expect(body.pagination).toMatchObject({ limit: 50 });
    expect(body.pagination).toMatchObject({ hasMore: false, nextCursor: '' });

    const listCall = calls[0];
    expect(listCall.sql).toContain('FROM mails');
    expect(listCall.sql).not.toContain('LEFT JOIN mail_bodies');
    expect(listCall.sql).toContain('ORDER BY mails.received_at DESC, mails.id DESC');
    expect(listCall.sql).not.toContain('mails_fts');
    expect(listCall.params).toEqual([51]);
  });

  it('最新邮件接口只读取最新一封摘要', async () => {
    const { env, prepare } = createEnv();

    const response = await mailsRoutes.fetch(new Request('https://example.com/latest'), env);
    const body = await response.json() as {
      result: { id: string; textBody?: string; htmlBody?: string };
    };

    expect(response.status).toBe(200);
    expect(body.result.id).toBe('mail_1');
    expect(body.result).not.toHaveProperty('textBody');
    expect(body.result).not.toHaveProperty('htmlBody');
    expect(prepare.mock.calls[0][0]).toContain('ORDER BY received_at DESC, id DESC');
    expect(prepare.mock.calls[0][0]).toContain('LIMIT 1');
  });

  it('公开邮件详情接口已删除，正文从列表直接返回', async () => {
    const { env } = createEnv();

    const response = await publicMailsRoutes.fetch(new Request('https://example.com/mail_1'), env);

    expect(response.status).toBe(404);
  });

  it('公开生成分享链接返回可浏览链接', async () => {
    const { env } = createEnv();

    const response = await publicMailsRoutes.fetch(new Request('https://example.com/mail_1/share', { method: 'POST' }), env);
    const body = await response.json() as {
      ok: boolean;
      data: { token: string; url: string; expiresAt: string; ttlHours: number };
    };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data.token).toMatch(/^share_/);
    expect(body.data.url).toBe(`https://mail.example.com/mail/${body.data.token}`);
    expect(body.data.ttlHours).toBe(72);
    expect(body.data.expiresAt).toBeTruthy();
  });
});
