import { getSystemConfig } from './config';
import { getMailBody } from './mail-bodies';
import type { Env } from './types';
import { createId, nowIso, safeJsonParse } from './utils';

const sharePrefix = 'mail_share:';
const shareByMailPrefix = 'mail_share_by_mail:';

export interface MailShareRecord {
  mailId: string;
  createdAt: string;
  expiresAt: string;
}

export interface MailShareIndexRecord {
  token: string;
  expiresAt: string;
}

export interface MailAttachmentView {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  contentId: string;
  disposition: string;
  stored: boolean;
}

export interface MailDetailView {
  id: string;
  messageId: string;
  fromAddr: string;
  fromName: string;
  toAddr: string;
  domain: string;
  receivedByAddr: string;
  forwarded: boolean;
  subject: string;
  bodyPreview: string;
  hasAttachments: boolean;
  attachmentCount: number;
  rawSize: number;
  receivedAt: string;
  createdAt: string;
  textBody: string;
  htmlBody: string;
  headers: Record<string, string>;
  attachments: MailAttachmentView[];
}

export interface MailDetailViewOptions {
  waitUntil?: (promise: Promise<unknown>) => void;
}

function shareKey(token: string) {
  return `${sharePrefix}${token}`;
}

function shareByMailKey(mailId: string) {
  return `${shareByMailPrefix}${mailId}`;
}

export async function deleteMailShares(env: Env, mailIds: string[]) {
  const ids = [...new Set(mailIds.map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0) return;
  const indexes = await Promise.all(
    ids.map(async (mailId) => ({
      mailId,
      index: safeJsonParse<MailShareIndexRecord>(await env.KV.get(shareByMailKey(mailId)), { token: '', expiresAt: '' })
    }))
  );
  await Promise.all(
    indexes.flatMap(({ mailId, index }) => [
      env.KV.delete(shareByMailKey(mailId)),
      ...(index.token ? [env.KV.delete(shareKey(index.token))] : [])
    ])
  );
}

function normalizeBaseUrl(value: string) {
  return value.trim().replace(/\/+$/, '');
}

function expiresAt(ttlHours: number) {
  return new Date(Date.now() + ttlHours * 60 * 60 * 1000).toISOString();
}

export async function getMailDetailView(env: Env, mailId: string, options: MailDetailViewOptions = {}): Promise<MailDetailView | null> {
  const row = await env.DB.prepare(
    `SELECT id, message_id AS messageId, from_addr AS fromAddr, from_name AS fromName,
            to_addr AS toAddr, domain, received_by_addr AS receivedByAddr, is_forwarded AS isForwarded,
            subject, body_preview AS bodyPreview,
            has_attachments AS hasAttachments, attachment_count AS attachmentCount,
            raw_size AS rawSize, received_at AS receivedAt, created_at AS createdAt
     FROM mails
     WHERE id = ?`
  )
    .bind(mailId)
    .first<Record<string, unknown>>();

  if (!row) return null;

  const [body, attachments] = await Promise.all([
    getMailBody(env, mailId, { waitUntil: options.waitUntil }),
    env.DB.prepare(
      `SELECT id, filename, mime_type AS mimeType, size, content_id AS contentId,
              disposition, stored
       FROM mail_attachments
       WHERE mail_id = ?
       ORDER BY created_at ASC, id ASC`
    )
      .bind(mailId)
      .all<Record<string, unknown>>()
  ]);

  return {
    id: String(row.id || ''),
    messageId: String(row.messageId || ''),
    fromAddr: String(row.fromAddr || ''),
    fromName: String(row.fromName || ''),
    toAddr: String(row.toAddr || ''),
    domain: String(row.domain || ''),
    receivedByAddr: String(row.receivedByAddr || row.toAddr || ''),
    forwarded: Number(row.isForwarded || 0) === 1,
    subject: String(row.subject || ''),
    bodyPreview: String(row.bodyPreview || ''),
    hasAttachments: Number(row.hasAttachments || 0) === 1,
    attachmentCount: Number(row.attachmentCount || 0),
    rawSize: Number(row.rawSize || 0),
    receivedAt: String(row.receivedAt || ''),
    createdAt: String(row.createdAt || ''),
    textBody: body.textBody,
    htmlBody: body.htmlBody,
    headers: safeJsonParse<Record<string, string>>(body.headersJson, {}),
    attachments: (attachments.results || []).map((attachment) => ({
      id: String(attachment.id || ''),
      filename: String(attachment.filename || ''),
      mimeType: String(attachment.mimeType || ''),
      size: Number(attachment.size || 0),
      contentId: String(attachment.contentId || ''),
      disposition: String(attachment.disposition || ''),
      stored: Number(attachment.stored || 0) === 1
    }))
  };
}

export async function mailExists(env: Env, mailId: string) {
  const row = await env.DB.prepare(`SELECT id FROM mails WHERE id = ?`)
    .bind(mailId)
    .first<Record<string, unknown>>();
  return Boolean(row?.id);
}

export async function createMailShare(env: Env, mailId: string) {
  const system = await getSystemConfig(env);
  const baseUrl = normalizeBaseUrl(system.shareBaseUrl);
  if (!baseUrl) throw new Error('请先在系统设置中选择分享地址');
  if (!(await mailExists(env, mailId))) throw new Error('邮件不存在');

  const token = createId('share');
  const ttlHours = system.mailShareTtlHours;
  const ttlSeconds = ttlHours * 60 * 60;
  const record: MailShareRecord = {
    mailId,
    createdAt: nowIso(),
    expiresAt: expiresAt(ttlHours)
  };
  const indexKey = shareByMailKey(mailId);
  const oldIndex = safeJsonParse<MailShareIndexRecord>(await env.KV.get(indexKey), { token: '', expiresAt: '' });
  await Promise.all([
    env.KV.put(shareKey(token), JSON.stringify(record), { expirationTtl: ttlSeconds }),
    env.KV.put(indexKey, JSON.stringify({ token, expiresAt: record.expiresAt }), { expirationTtl: ttlSeconds })
  ]);
  if (oldIndex.token && oldIndex.token !== token) {
    await env.KV.delete(shareKey(oldIndex.token)).catch(() => undefined);
  }
  return {
    token,
    url: `${baseUrl}/mail/${token}`,
    expiresAt: record.expiresAt,
    ttlHours
  };
}

export async function readMailShare(env: Env, token: string) {
  const record = safeJsonParse<MailShareRecord>(await env.KV.get(shareKey(token)), { mailId: '', createdAt: '', expiresAt: '' });
  if (!record.mailId || !record.expiresAt) return null;
  if (new Date(record.expiresAt).getTime() <= Date.now()) {
    await env.KV.delete(shareKey(token)).catch(() => undefined);
    return null;
  }
  const index = safeJsonParse<MailShareIndexRecord>(await env.KV.get(shareByMailKey(record.mailId)), { token: '', expiresAt: '' });
  if (index.token !== token) return null;
  return record;
}

export async function getSharedMailDetail(env: Env, token: string, options: MailDetailViewOptions = {}) {
  const share = await readMailShare(env, token);
  if (!share) return null;
  const mail = await getMailDetailView(env, share.mailId, options);
  if (!mail) return null;
  return {
    share: {
      expiresAt: share.expiresAt
    },
    mail
  };
}
