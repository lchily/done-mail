import { describe, expect, it, vi } from 'vitest';
import { createMailShare } from './mail-share';
import { downloadShareAttachment, renderSharePage } from './share-page';
import type { Env } from './types';

function createKv(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    get: vi.fn(async (key: string) => store.get(key) || null),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    })
  };
}

function createEnv() {
  const KV = createKv({
    'config:system': JSON.stringify({
      cleanupEnabled: true,
      mailRetentionDays: 30,
      acceptForwardedMail: true,
      shareBaseUrl: 'https://mail.example.com',
      mailShareTtlHours: 72,
      rateLimit: { login: 10, publicApi: 10, publicShare: 100 }
    })
  });
  const mail = {
    id: 'mail_1',
    messageId: 'msg_1',
    fromAddr: 'from@example.com',
    fromName: 'From',
    toAddr: 'to@example.com',
    domain: 'example.com',
    receivedByAddr: 'to@example.com',
    isForwarded: 0,
    subject: '主题',
    bodyPreview: '摘要',
    hasAttachments: 1,
    attachmentCount: 1,
    rawSize: 100,
    receivedAt: '2026-05-01T00:00:00.000Z',
    createdAt: '2026-05-01T00:00:00.000Z'
  };
  const body = { headersJson: '{}' };
  const chunks = {
    results: [
      { mailId: 'mail_1', kind: 'text', chunkIndex: 0, content: '正文' },
      { mailId: 'mail_1', kind: 'html', chunkIndex: 0, content: '<p>正文</p><img src="https://cdn.example.com/logo.png" alt="Logo"><script>alert(1)</script>' }
    ]
  };
  const attachments = {
    results: [
      {
        id: 'att_1',
        filename: 'invoice.pdf',
        mimeType: 'application/pdf',
        size: 1024,
        contentId: '',
        disposition: 'attachment',
        stored: 1
      }
    ]
  };
  const DB = {
    prepare: vi.fn((sql: string) => ({
      bind: vi.fn((...params: unknown[]) => ({
        first: vi.fn(async () => {
          if (sql.includes('SELECT id FROM mails')) return { id: 'mail_1' };
          if (sql.includes('FROM mail_bodies')) return body;
          if (sql.includes('FROM mail_safe_bodies')) return null;
          if (sql.includes('FROM mail_attachments') && sql.includes('object_key')) {
            return params[0] === 'att_1' ? { filename: 'invoice.pdf', mimeType: 'application/pdf', objectKey: 'attachments/mail_1/att_1.pdf' } : null;
          }
          return mail;
        }),
        all: vi.fn(async () => (sql.includes('FROM mail_body_chunks') ? chunks : attachments))
      }))
    })),
    batch: vi.fn(async () => [])
  };
  const object = {
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('pdf'));
        controller.close();
      }
    }),
    writeHttpMetadata(headers: Headers) {
      headers.set('Content-Type', 'application/pdf');
    }
  };
  const MAIL_BUCKET = {
    get: vi.fn(async (key: string) => (key === 'attachments/mail_1/att_1.pdf' ? object : null))
  };
  return { KV, DB, MAIL_BUCKET, ASSETS: { fetch: vi.fn() } } as unknown as Env;
}

describe('share page', () => {
  it('分享页使用公开页安全响应头并隔离邮件正文', async () => {
    const env = createEnv();
    const share = await createMailShare(env, 'mail_1');
    const response = await renderSharePage(env, share.token);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
    expect(response.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
    expect(response.headers.get('Content-Security-Policy')).toContain("img-src 'self' data:");
    expect(response.headers.get('Content-Security-Policy')).not.toContain("img-src 'self' data: https:");
    expect(html).toContain('/favicon.svg');
    expect(html).toContain('/static/logo-mark.svg');
    expect(html).toContain('.head{display:grid;gap:8px;padding:18px 22px');
    expect(html).toContain('sandbox="allow-popups allow-popups-to-escape-sandbox"');
    expect(html).toContain('Content-Security-Policy');
    expect(html).toContain("img-src data: cid:");
    expect(html).not.toContain("img-src data: cid: https:");
    expect(html).toContain('已隐藏远程图片');
    expect(html).toContain('/mail/');
    expect(html).toContain('?remote=true');
    expect(html).not.toContain('?remote=1');
    expect(html).toContain('img[src^=&quot;https://&quot;]');
    expect(html).not.toContain('allow-same-origin');
    expect(html).not.toContain('<script>');
  });

  it('分享页手动允许后才加载 HTTPS 远程图片', async () => {
    const env = createEnv();
    const share = await createMailShare(env, 'mail_1');
    const response = await renderSharePage(env, share.token, true);
    const html = await response.text();

    expect(response.headers.get('Content-Security-Policy')).toContain("img-src 'self' data: https:");
    expect(html).toContain("img-src data: cid: https:");
    expect(html).not.toContain('已隐藏远程图片');
    expect(html).not.toContain('img[src^=&quot;https://&quot;]');
  });

  it('分享附件下载也不允许缓存', async () => {
    const env = createEnv();
    const share = await createMailShare(env, 'mail_1');
    const response = await downloadShareAttachment(env, share.token, 'att_1');

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('Content-Type')).toBe('application/pdf');
  });
});
