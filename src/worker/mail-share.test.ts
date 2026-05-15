import { describe, expect, it, vi } from 'vitest';
import { createMailShare, deleteMailShares, getSharedMailDetail, readMailShare } from './mail-share';
import type { Env } from './types';

function createKv(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  const ttl = new Map<string, number>();
  return {
    store,
    ttl,
    KV: {
      get: vi.fn(async (key: string) => store.get(key) || null),
      put: vi.fn(async (key: string, value: string, options?: { expirationTtl?: number }) => {
        store.set(key, value);
        if (options?.expirationTtl) ttl.set(key, options.expirationTtl);
      }),
      delete: vi.fn(async (key: string) => {
        store.delete(key);
        ttl.delete(key);
      })
    }
  };
}

function createEnv() {
  const kv = createKv({
    'config:system': JSON.stringify({
      cleanupEnabled: true,
      mailRetentionDays: 30,
      acceptForwardedMail: true,
      shareBaseUrl: 'https://mail.example.com',
      mailShareTtlHours: 72,
      rateLimit: { login: 10, publicApi: 10, publicShare: 100 }
    })
  });
  const body = { headersJson: '{}' };
  const chunks = {
    results: [
      { kind: 'text', chunkIndex: 0, content: '正文' },
      { kind: 'html', chunkIndex: 0, content: '<p>正文</p>' }
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
        stored: 1,
        objectKey: 'attachments/mail_1/att_1-secret.pdf'
      }
    ]
  };
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
    hasAttachments: 0,
    attachmentCount: 0,
    rawSize: 100,
    receivedAt: '2026-05-01T00:00:00.000Z',
    createdAt: '2026-05-01T00:00:00.000Z'
  };
  const prepare = vi.fn((sql: string) => ({
    bind: vi.fn(() => ({
      first: vi.fn(async () => {
        if (sql.includes('FROM mail_safe_bodies')) return null;
        if (sql.includes('FROM mail_bodies')) return body;
        return mail;
      }),
      all: vi.fn(async () => (sql.includes('FROM mail_body_chunks') ? chunks : attachments))
    }))
  }));
  return {
    env: {
      KV: kv.KV,
      DB: { prepare, batch: vi.fn(async () => []) }
    } as unknown as Env,
    kv,
    prepare
  };
}

describe('mail share', () => {
  it('重复生成会覆盖旧链接并刷新有效期', async () => {
    const { env, kv } = createEnv();

    const first = await createMailShare(env, 'mail_1');
    const second = await createMailShare(env, 'mail_1');

    expect(first.token).not.toBe(second.token);
    expect(await readMailShare(env, first.token)).toBeNull();
    expect(await readMailShare(env, second.token)).toMatchObject({ mailId: 'mail_1' });
    expect(kv.store.get(`mail_share:${first.token}`)).toBeUndefined();
    expect(kv.ttl.get(`mail_share:${second.token}`)).toBe(72 * 60 * 60);
    expect(kv.ttl.get('mail_share_by_mail:mail_1')).toBe(72 * 60 * 60);
  });

  it('删除邮件分享会同时清理 token 和索引', async () => {
    const { env, kv } = createEnv();

    const share = await createMailShare(env, 'mail_1');
    await deleteMailShares(env, ['mail_1']);

    expect(await readMailShare(env, share.token)).toBeNull();
    expect(kv.store.get(`mail_share:${share.token}`)).toBeUndefined();
    expect(kv.store.get('mail_share_by_mail:mail_1')).toBeUndefined();
  });

  it('分享生成只校验邮件存在，打开详情时才读取正文和附件', async () => {
    const { env, prepare } = createEnv();

    const share = await createMailShare(env, 'mail_1');
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(prepare.mock.calls[0][0]).toContain('SELECT id FROM mails');

    const detail = await getSharedMailDetail(env, share.token);
    expect(detail?.mail.subject).toBe('主题');
    expect(prepare.mock.calls.some(([sql]) => String(sql).includes('FROM mail_safe_bodies'))).toBe(true);
    expect(prepare.mock.calls.some(([sql]) => String(sql).includes('FROM mail_body_chunks'))).toBe(true);
    expect(prepare.mock.calls.some(([sql]) => String(sql).includes('FROM mail_attachments'))).toBe(true);
  });

  it('分享详情只返回附件视图字段，不暴露 R2 objectKey', async () => {
    const { env } = createEnv();

    const share = await createMailShare(env, 'mail_1');
    const detail = await getSharedMailDetail(env, share.token);
    const text = JSON.stringify(detail);

    expect(detail?.mail.attachments).toEqual([
      {
        id: 'att_1',
        filename: 'invoice.pdf',
        mimeType: 'application/pdf',
        size: 1024,
        contentId: '',
        disposition: 'attachment',
        stored: true
      }
    ]);
    expect(text).not.toContain('objectKey');
    expect(text).not.toContain('secret.pdf');
  });
});
