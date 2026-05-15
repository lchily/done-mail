import { describe, expect, it, vi } from 'vitest';
import { deleteMails, handleIncomingEmail } from './mail';
import type { Env } from './types';

interface BoundStatement {
  sql: string;
  params: unknown[];
  all: <T>() => Promise<{ results: T[] }>;
}

function createEnv() {
  const statements: BoundStatement[] = [];
  const prepare = vi.fn((sql: string) => ({
    bind: vi.fn((...params: unknown[]) => {
      const statement = {
        sql,
        params,
        all: async <T>() => ({
          results: sql.includes('FROM domains') ? (params.map((name) => ({ name })) as T[]) : []
        })
      };
      statements.push(statement);
      return statement;
    })
  }));

  return {
    env: {
      KV: {
        get: vi.fn(async () => null)
      },
      DB: {
        prepare,
        batch: vi.fn(async () => statements.map(() => ({ meta: { changes: 1 } })))
      }
    } as unknown as Env,
    statements
  };
}

function createEnvWithBucket() {
  const base = createEnv();
  const put = vi.fn(async () => undefined);
  return {
    ...base,
    env: {
      ...base.env,
      MAIL_BUCKET: {
        put,
        delete: vi.fn(async () => undefined)
      }
    } as unknown as Env,
    put
  };
}

function createDeleteEnv(options: { r2Fails?: boolean; batchFails?: boolean; deleted?: number } = {}) {
  const events: string[] = [];
  const bucketDelete = vi.fn(async (key: string) => {
    events.push(`r2:${key}`);
    if (options.r2Fails) throw new Error('R2 delete failed');
  });
  const prepare = vi.fn((sql: string) => {
    const statement = {
      sql,
      params: [] as unknown[],
      bind: vi.fn((...params: unknown[]) => {
        statement.params = params;
        return statement;
      }),
      all: vi.fn(async <T>() => ({
        results: sql.includes('FROM mail_attachments') ? ([{ objectKey: 'mail/mail_1/a.txt' }] as T[]) : []
      }))
    };
    return statement;
  });
  const batch = vi.fn(async (statements: unknown[]) => {
    events.push('batch');
    if (options.batchFails) throw new Error('D1 delete failed');
    return statements.map((_, index) => ({ meta: { changes: index === statements.length - 1 ? options.deleted ?? 1 : 0 } }));
  });

  return {
    env: {
      DB: { prepare, batch },
      KV: {
        get: vi.fn(async () => null),
        delete: vi.fn(async () => undefined)
      },
      MAIL_BUCKET: {
        delete: bucketDelete
      }
    } as unknown as Env,
    bucketDelete,
    events,
    prepare,
    batch
  };
}

function rawMailWithAttachment() {
  return [
    'From: Stripe <billing@stripe.example>',
    'To: pay@example.com',
    'Subject: Invoice May',
    'Message-ID: <msg-1@example.com>',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="mail-boundary"',
    '',
    '--mail-boundary',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Your invoice is ready.',
    '--mail-boundary',
    'Content-Type: text/plain; name="invoice.txt"',
    'Content-Disposition: attachment; filename="invoice.txt"',
    'Content-Transfer-Encoding: base64',
    '',
    btoa('invoice file body'),
    '--mail-boundary--',
    ''
  ].join('\r\n');
}

describe('incoming mail', () => {
  it('未配置 R2 时仍保存邮件、正文、附件信息和搜索索引，附件标记为未存储', async () => {
    const { env, statements } = createEnv();
    const raw = rawMailWithAttachment();
    const message = {
      rawSize: raw.length,
      raw: new TextEncoder().encode(raw),
      headers: {
        from: 'Stripe <billing@stripe.example>',
        to: 'pay@example.com',
        subject: 'Invoice May'
      },
      to: 'pay@example.com',
      forward: vi.fn(),
      setReject: vi.fn()
    } as unknown as ForwardableEmailMessage;

    await handleIncomingEmail(message, env);

    expect(env.DB.batch).toHaveBeenCalledTimes(1);
    expect(message.setReject).not.toHaveBeenCalled();

    const mailStatement = statements.find((item) => item.sql.includes('INSERT INTO mails ('));
    expect(mailStatement?.params[2]).toBe('billing@stripe.example');
    expect(mailStatement?.params[4]).toBe('pay@example.com');
    expect(mailStatement?.params[5]).toBe('example.com');
    expect(mailStatement?.params[8]).toBe('Invoice May');
    expect(mailStatement?.params[10]).toBe(1);
    expect(mailStatement?.params[11]).toBe(1);

    const bodyStatement = statements.find((item) => item.sql.includes('INSERT INTO mail_bodies'));
    expect(bodyStatement?.params[1]).toContain('from');

    const publicBodyStatement = statements.find((item) => item.sql.includes('INSERT INTO mail_public_bodies'));
    expect(publicBodyStatement?.params[1]).toContain('Your invoice is ready');
    expect(String(publicBodyStatement?.params[2])).not.toContain('<script');

    const bodyChunkStatement = statements.find((item) => item.sql.includes('INSERT INTO mail_body_chunks') && item.params[1] === 'text');
    expect(bodyChunkStatement?.params[3]).toContain('Your invoice is ready');

    const attachmentStatement = statements.find((item) => item.sql.includes('INSERT INTO mail_attachments'));
    expect(attachmentStatement?.params[2]).toBe('invoice.txt');
    expect(attachmentStatement?.params[7]).toBe(0);
    expect(attachmentStatement?.params[8]).toBe('');

    const ftsStatement = statements.find((item) => item.sql.includes('INSERT INTO mails_fts'));
    expect(ftsStatement?.sql).toContain('mail_id, subject, addresses');
    expect(String(ftsStatement?.params[1])).toBe('invoice may');
    expect(String(ftsStatement?.params[2])).toContain('billing@stripe.example');

    const contentFtsStatement = statements.find((item) => item.sql.includes('INSERT INTO mail_content_fts'));
    expect(String(contentFtsStatement?.params[2])).toContain('your');
    expect(String(contentFtsStatement?.params[2])).toContain('invoice');
  });

  it('写入 R2 附件时统一编码 Content-Disposition 文件名', async () => {
    const { env, put } = createEnvWithBucket();
    const raw = [
      'From: Stripe <billing@stripe.example>',
      'To: pay@example.com',
      'Subject: Invoice May',
      'Message-ID: <msg-1@example.com>',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="mail-boundary"',
      '',
      '--mail-boundary',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Your invoice is ready.',
      '--mail-boundary',
      'Content-Type: text/plain; name="报价单.txt"',
      'Content-Disposition: attachment; filename="报价单.txt"',
      'Content-Transfer-Encoding: base64',
      '',
      btoa('invoice file body'),
      '--mail-boundary--',
      ''
    ].join('\r\n');
    const message = {
      rawSize: raw.length,
      raw: new TextEncoder().encode(raw),
      headers: {
        from: 'Stripe <billing@stripe.example>',
        to: 'pay@example.com',
        subject: 'Invoice May'
      },
      to: 'pay@example.com',
      forward: vi.fn(),
      setReject: vi.fn()
    } as unknown as ForwardableEmailMessage;

    await handleIncomingEmail(message, env);

    const metadata = (put as unknown as { mock: { calls: Array<[string, unknown, { httpMetadata: { contentDisposition: string } }]> } }).mock.calls[0]?.[2]?.httpMetadata;
    expect(metadata.contentDisposition).toContain('attachment; filename=".txt"');
    expect(metadata.contentDisposition).toContain("filename*=UTF-8''%E6%8A%A5%E4%BB%B7%E5%8D%95.txt");
  });

  it('删除收件箱邮件时先删 R2 附件，再删除 D1 记录', async () => {
    const { env, bucketDelete, events, prepare } = createDeleteEnv({ deleted: 2 });

    await expect(deleteMails(env, ['mail_1'])).resolves.toBe(2);

    expect(events.indexOf('batch')).toBeGreaterThanOrEqual(0);
    expect(events.indexOf('r2:mail/mail_1/a.txt')).toBeLessThan(events.indexOf('batch'));
    expect(bucketDelete).toHaveBeenCalledWith('mail/mail_1/a.txt');
    expect(prepare.mock.calls.some(([sql]) => String(sql).includes('DELETE FROM mail_public_bodies'))).toBe(true);
  });

  it('删除收件箱邮件时 R2 失败不会删除 D1 记录', async () => {
    const { env, batch } = createDeleteEnv({ r2Fails: true });

    await expect(deleteMails(env, ['mail_1'])).rejects.toThrow('R2 delete failed');

    expect(batch).not.toHaveBeenCalled();
  });
});
