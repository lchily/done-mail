import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env, MailPolicyPayload } from './types';
import { createPolicy, deletePolicy, listPolicies, runMailPolicies, updatePolicy } from './policies';

function createEnv(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries({
    'config:system': JSON.stringify({
      cleanupEnabled: true,
      mailRetentionDays: 30,
      acceptForwardedMail: true,
      shareBaseUrl: 'https://mail.example.com',
      mailShareTtlHours: 72,
      rateLimit: { login: 10, publicApi: 10, publicShare: 100 }
    }),
    ...initial
  }));
  const dbCalls: Array<{ sql: string; params: unknown[] }> = [];
  const dbRun = vi.fn(async () => ({ meta: { changes: 1 } }));
  const dbAll = vi.fn(async () => ({ results: [] }));
  const dbFirst = vi.fn(async () => ({
    id: 'mail_test',
    messageId: 'test-message-id',
    fromAddr: 'billing@stripe.com',
    fromName: 'Stripe 账单',
    toAddr: 'pay@example.com',
    domain: 'example.com',
    receivedByAddr: 'pay@example.com',
    isForwarded: 0,
    subject: 'Your invoice is ready',
    bodyPreview: 'Your invoice for May is ready.',
    hasAttachments: 1,
    attachmentCount: 1,
    rawSize: 188,
    receivedAt: '2026-05-01T00:00:00.000Z',
    createdAt: '2026-05-01T00:00:00.000Z'
  }));
  return {
    __dbCalls: dbCalls,
    KV: {
      get: vi.fn(async (key: string) => store.get(key) || null),
      put: vi.fn(async (key: string, value: string) => {
        store.set(key, value);
      }),
      delete: vi.fn(async (key: string) => {
        store.delete(key);
      })
    },
    DB: {
      prepare: vi.fn((sql: string) => ({
        bind: vi.fn((...params: unknown[]) => {
          dbCalls.push({ sql, params });
          return { run: dbRun, all: dbAll, first: dbFirst };
        }),
        run: dbRun,
        all: dbAll,
        first: dbFirst
      })),
      batch: vi.fn(async () => [])
    }
  } as unknown as Env;
}

function cloudflareConfig() {
  return {
    'config:cloudflare': JSON.stringify({
      accountId: 'account_1',
      apiToken: 'cf-token',
      workerName: 'done-mail'
    })
  };
}

function mockForwardAddresses(items: Array<{ email: string; verified?: string | null }>) {
  const fetchMock = vi.fn(async () =>
    Response.json({
      success: true,
      result: items.map((item, index) => ({
        id: `addr_${index + 1}`,
        email: item.email,
        verified: item.verified || null
      })),
      result_info: { page: 1, per_page: 50, total_pages: 1, total_count: items.length }
    })
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function policyPayload(): MailPolicyPayload {
  return {
    event: 'mail.received',
    id: 'mail_1',
    messageId: 'msg_1',
    from: 'Stripe 账单 <billing@stripe.example>',
    fromAddr: 'billing@stripe.example',
    fromName: 'Stripe 账单',
    to: 'pay@example.com',
    domain: 'example.com',
    receivedBy: 'pay@example.com',
    forwarded: false,
    subject: 'Invoice May',
    preview: 'Your invoice is ready',
    receivedAt: '2026-05-01T00:00:00.000Z',
    rawSize: 100,
    hasAttachments: false,
    attachmentCount: 0,
    textBody: 'Your invoice is ready',
    htmlBody: '<p>Your invoice is ready</p>',
    headers: {},
    attachments: []
  };
}

function policyRunInput(env: Env, payload = policyPayload(), extra: Partial<Parameters<typeof runMailPolicies>[1]> = {}) {
  let shareUrlPromise: Promise<string> | undefined;
  return {
    env,
    matchPayload: payload,
    fullPayload: () => payload,
    shareUrl: () => {
      shareUrlPromise ||= Promise.resolve('https://mail.example.com/mail/share_test');
      return shareUrlPromise;
    },
    ...extra
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('mail policies', () => {
  it('创建、分页读取并更新策略', async () => {
    const env = createEnv();
    const created = await createPolicy(env, {
      name: 'Stripe',
      conditions: [{ field: 'from', operator: 'contains', value: 'stripe' }],
      actions: [{ type: 'httpRequest', name: '通知账单系统', method: 'POST', url: 'http://localhost/policy' }]
    });

    expect(created.actions[0].type).toBe('httpRequest');
    const page = await listPolicies(env, { page: 1, pageSize: 20 });
    expect(page.total).toBe(1);
    expect(page.items[0].name).toBe('Stripe');

    const updated = await updatePolicy(env, created.id, {
      ...page.items[0],
      name: 'Stripe 更新'
    });
    expect(updated.name).toBe('Stripe 更新');
  });

  it('策略布尔条件只接受 true 或 false', async () => {
    const env = createEnv();

    await expect(createPolicy(env, {
      name: '非法条件布尔',
      conditions: [{ field: 'hasAttachments', operator: 'equals', value: '1' }],
      actions: [{ type: 'httpRequest', name: '请求', method: 'POST', url: 'http://localhost/hook' }]
    })).rejects.toThrow('hasAttachments 仅支持 true 或 false');
  });

  it('拒绝过期版本覆盖策略', async () => {
    const env = createEnv();
    const created = await createPolicy(env, {
      name: 'A',
      actions: [{ type: 'httpRequest', name: '请求 A', method: 'POST', url: 'http://localhost/a' }]
    });
    const staleVersion = created.version;
    await updatePolicy(env, created.id, { ...created, name: 'B', version: staleVersion });

    await expect(updatePolicy(env, created.id, { ...created, name: 'C', version: staleVersion })).rejects.toThrow('已被更新');
    await expect(deletePolicy(env, created.id, staleVersion)).rejects.toThrow('已被更新');
  });

  it('只在后台执行命中的请求动作', async () => {
    const fetchMock = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', fetchMock);
    const env = createEnv();
    await createPolicy(env, {
      name: '命中',
      enabled: true,
      conditions: [
        { field: 'fromDomain', operator: 'equals', value: 'stripe.example' },
        { field: 'domain', operator: 'equals', value: 'example.com' }
      ],
      actions: [{ type: 'httpRequest', name: '发送请求', method: 'POST', url: 'http://localhost/hit' }]
    });
    await createPolicy(env, {
      name: '未命中',
      enabled: true,
      conditions: [{ field: 'from', operator: 'contains', value: 'github' }],
      actions: [{ type: 'httpRequest', name: '发送请求', method: 'POST', url: 'http://localhost/miss' }]
    });

    await runMailPolicies(env, policyRunInput(env));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('http://localhost/hit', expect.any(Object));
  });

  it('转发到当前收件域名时拒绝执行，避免邮件循环', async () => {
    mockForwardAddresses([
      { email: 'archive@example.com', verified: '2026-05-01T00:00:00Z' },
      { email: 'ops@example.net', verified: '2026-05-01T00:00:00Z' }
    ]);
    const env = createEnv(cloudflareConfig());
    const forward = vi.fn();
    await createPolicy(env, {
      name: '循环转发',
      enabled: true,
      actions: [{ type: 'forward', name: '转发邮件', to: ['archive@example.com', 'ops@example.net'] }]
    });

    await runMailPolicies(env, policyRunInput(env, policyPayload(), { forward }));

    expect(forward).not.toHaveBeenCalled();
    const logCall = (env as unknown as { __dbCalls: Array<{ sql: string; params: unknown[] }> }).__dbCalls.find((item) => item.sql.includes('INSERT INTO system_logs'));
    expect(logCall?.params).toEqual(expect.arrayContaining(['policy', '循环转发', 'policy', 'failed']));
    expect(String(logCall?.params[5] || '')).toContain('避免邮件循环');
  });

  it('转发策略通过 waitUntil 后台执行，不阻塞主流程', async () => {
    mockForwardAddresses([
      { email: 'archive@example.net', verified: '2026-05-01T00:00:00Z' }
    ]);
    const env = createEnv(cloudflareConfig());
    let forwarded = false;
    let resolveForward: () => void = () => undefined;
    const forwardDone = new Promise<void>((resolve) => {
      resolveForward = resolve;
    });
    const forward = vi.fn(async () => {
      await forwardDone;
      forwarded = true;
    });
    const waitUntil = vi.fn();
    await createPolicy(env, {
      name: '后台转发',
      enabled: true,
      actions: [{ type: 'forward', name: '转发邮件', to: ['archive@example.net'] }]
    });

    await runMailPolicies(env, policyRunInput(env, policyPayload(), {
      forward,
      executionCtx: { waitUntil }
    }));

    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(forward).toHaveBeenCalledWith('archive@example.net');
    expect(forwarded).toBe(false);
    resolveForward();
    await waitUntil.mock.calls[0][0];
    expect(forwarded).toBe(true);
  });

  it('转发策略保存要求目标邮箱已验证', async () => {
    const env = createEnv(cloudflareConfig());
    mockForwardAddresses([{ email: 'archive@example.net', verified: null }]);

    await expect(createPolicy(env, {
      name: '未验证转发',
      actions: [{ type: 'forward', name: '转发邮件', to: ['archive@example.net'] }]
    })).rejects.toThrow('转发邮箱未验证');

    mockForwardAddresses([{ email: 'archive@example.net', verified: '2026-05-01T00:00:00Z' }]);
    const created = await createPolicy(env, {
      name: '已验证转发',
      actions: [{ type: 'forward', name: '转发邮件', to: ['archive@example.net'] }]
    });

    expect(created.actions[0]).toMatchObject({ type: 'forward', to: ['archive@example.net'] });
  });

  it('HTTP 策略通过 waitUntil 后台执行，不阻塞收信主流程', async () => {
    let requested = false;
    let resolveRequest: () => void = () => undefined;
    const requestDone = new Promise<void>((resolve) => {
      resolveRequest = resolve;
    });
    const fetchMock = vi.fn(async () => {
      await requestDone;
      requested = true;
      return new Response('ok');
    });
    vi.stubGlobal('fetch', fetchMock);
    const env = createEnv();
    const waitUntil = vi.fn();
    await createPolicy(env, {
      name: '后台请求',
      enabled: true,
      actions: [{ type: 'httpRequest', name: '发送请求', method: 'POST', url: 'http://localhost/hit' }]
    });

    await runMailPolicies(env, policyRunInput(env, policyPayload(), {
      executionCtx: { waitUntil }
    }));

    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requested).toBe(false);
    resolveRequest();
    await waitUntil.mock.calls[0][0];
    expect(requested).toBe(true);
  });

  it('拒绝不支持的请求方法', async () => {
    const env = createEnv();
    await expect(createPolicy(env, {
      name: '非法请求方法',
      actions: [
        {
          type: 'httpRequest',
          name: '发送请求',
          method: 'DELETE',
          url: 'http://localhost/cleanup'
        }
      ]
    })).rejects.toThrow('请求方法只支持 GET 或 POST');
  });

  it('HTTP 策略只允许 http 或 https URL', async () => {
    const env = createEnv();
    await expect(createPolicy(env, {
      name: '非法请求协议',
      actions: [
        {
          type: 'httpRequest',
          name: '发送请求',
          method: 'POST',
          url: 'ftp://example.com/hook'
        }
      ]
    })).rejects.toThrow('请求 URL 只支持 http 或 https');
  });

  it('TG 动作不会把 Bot Token 返回前端', async () => {
    const env = createEnv();
    const created = await createPolicy(env, {
      name: 'TG 通知',
      actions: [{ type: 'telegram', name: '发送至TG', botToken: '123456:secret-token', chatIds: ['10001'], message: '主题：{{subject}}' }]
    });

    const action = created.actions[0];
    expect(action).toMatchObject({ type: 'telegram', botToken: '', botTokenConfigured: true });
    expect(action.type === 'telegram' ? action.botTokenMasked : '').not.toContain('secret-token');
  });

  it('TG 动作要求前端提交消息模板，后端不再兜底默认模板', async () => {
    const env = createEnv();

    await expect(createPolicy(env, {
      name: 'TG 空模板',
      actions: [{ type: 'telegram', name: '发送至TG', botToken: '123456:secret-token', chatIds: ['10001'], message: '' }]
    })).rejects.toThrow('TG 消息模板不能为空');
  });

  it('TG 动作把分享链接作为按钮发送，不塞进消息模板', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    const env = createEnv();
    await createPolicy(env, {
      name: 'TG 按钮',
      enabled: true,
      actions: [{ type: 'telegram', name: '发送至TG', botToken: '123456:secret-token', chatIds: ['10001'], message: '主题：{{subject}}\n\n{{content}}' }]
    });

    await runMailPolicies(env, policyRunInput(env));

    const init = fetchMock.mock.calls[0]?.[1];
    expect(init).toBeTruthy();
    const body = JSON.parse(String(init?.body));
    expect(body.text).toBe('主题：Invoice May\n\nYour invoice is ready');
    expect(body.disable_web_page_preview).toBe(true);
    expect(body.reply_markup).toEqual({
      inline_keyboard: [[{ text: '查看邮件详情', url: 'https://mail.example.com/mail/share_test' }]]
    });
  });

  it('同一封邮件命中多个 TG 动作时只生成一次分享链接', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    const env = createEnv();
    const shareUrl = vi.fn(async () => 'https://mail.example.com/mail/share_once');
    await createPolicy(env, {
      name: 'TG 多动作',
      enabled: true,
      actions: [
        { type: 'telegram', name: '发送至TG A', botToken: '123456:secret-token', chatIds: ['10001'], message: 'A {{subject}}' },
        { type: 'telegram', name: '发送至TG B', botToken: '123456:secret-token', chatIds: ['10002'], message: 'B {{subject}}' }
      ]
    });

    await runMailPolicies(env, policyRunInput(env, policyPayload(), { shareUrl }));

    expect(shareUrl).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    const secondBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(firstBody.reply_markup.inline_keyboard[0][0].url).toBe('https://mail.example.com/mail/share_once');
    expect(secondBody.reply_markup.inline_keyboard[0][0].url).toBe('https://mail.example.com/mail/share_once');
  });

  it('TG 请求超时后记录策略失败，不阻塞收信主流程', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        })
      );
      vi.stubGlobal('fetch', fetchMock);
      const env = createEnv();
      await createPolicy(env, {
        name: 'TG 超时',
        enabled: true,
        actions: [{ type: 'telegram', name: '发送至TG', botToken: '123456:secret-token', chatIds: ['10001'], message: '主题：{{subject}}' }]
      });

      const promise = runMailPolicies(env, policyRunInput(env));
      await vi.advanceTimersByTimeAsync(8000);
      await promise;

      const logCall = (env as unknown as { __dbCalls: Array<{ sql: string; params: unknown[] }> }).__dbCalls.find((item) => item.sql.includes('INSERT INTO system_logs'));
      expect(logCall?.params).toEqual(expect.arrayContaining(['policy', 'TG 超时', 'policy', 'failed']));
      expect(String(logCall?.params[5] || '')).toContain('Telegram 请求超时：8 秒');
    } finally {
      vi.useRealTimers();
    }
  });

  it('TG 默认风格模板支持 HTML 分段渲染', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    const env = createEnv();
    await createPolicy(env, {
      name: 'TG HTML',
      enabled: true,
      actions: [
        {
          type: 'telegram',
          name: '发送至TG',
          botToken: '123456:secret-token',
          chatIds: ['10001'],
          message: '<b>DoneMail邮件通知</b>\n\n<b>主题</b>：{{subject}}\n<b>发件人</b>：{{fromAddr}}\n<b>收件人</b>：{{to}}\n<b>时间</b>：{{receivedAt}}\n\n{{content}}'
        }
      ]
    });

    await runMailPolicies(env, policyRunInput(env));

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.parse_mode).toBe('HTML');
    expect(body.text).toContain('<b>DoneMail邮件通知</b>');
    expect(body.text).toContain('<b>主题</b>：Invoice May');
    expect(body.text).toContain('<b>发件人</b>：billing@stripe.example');
    expect(body.text).toContain('<b>收件人</b>：pay@example.com');
    expect(body.text).toContain('<b>时间</b>：2026-05-01T00:00:00.000Z');
    expect(body.text).toContain('\n\nYour invoice is ready');
  });

});
