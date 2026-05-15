import PostalMime from 'postal-mime';
import { getSystemConfig } from './config';
import { fileContentDisposition } from './http/content-disposition';
import { buildBodyPreview, buildMailBodyChunks, buildMailContentSearchChunks, buildMailSearchFields, sanitizeMailHtml } from './mail-content';
import { createMailShare, deleteMailShares } from './mail-share';
import { runMailPolicies } from './policies';
import { deleteR2Objects, deleteR2ObjectsBestEffort } from './r2';
import { deleteSentMails } from './sent-mails';
import type { Env, MailPolicyMatchPayload, MailPolicyPayload } from './types';
import { createId, extractDomain, nowIso, pickEmailAddress } from './utils';

const MAX_RAW_MAIL_BYTES = 10 * 1024 * 1024;
const CLEANUP_BATCH_SIZE = 100;
const R2_ATTACHMENT_CONCURRENCY = 3;
const FORWARD_EVIDENCE_HEADER_KEYS = [
  'x-forwarded-to',
  'x-forwarded-for',
  'x-gm-original-to',
  'x-sieve-redirected-from',
  'x-redirected-from',
  'x-forwarded-message-id',
  'x-loop',
  'resent-to',
  'resent-from',
  'resent-date',
  'resent-bcc',
  'resent-cc',
  'resent-message-id',
  'resent-reply-to',
  'resent-sender'
];
const AUTO_FORWARD_EVIDENCE_HEADER_KEYS = ['auto-submitted', 'autosubmitted', 'autoforwarded', 'x-ms-exchange-organization-autoforwarded'];
const ORIGINAL_RECIPIENT_HEADER_KEYS = [
  'x-gm-original-to',
  'x-ms-exchange-organization-originalenveloperecipients',
  'x-ms-exchange-organization-original-to',
  'x-ms-exchange-inbox-rules-loop',
  'x-original-to',
  'x-original-recipient',
  'original-recipient',
  'downgraded-original-recipient',
  'x-forwarded-for',
  'x-forwarded-to',
  'x-sieve-redirected-from',
  'x-redirected-from',
  'x-original-delivered-to',
  'x-delivered-to',
  'delivered-to',
  'x-envelope-to',
  'envelope-to'
];
const RECEIVED_HEADER_SCAN_LIMIT = 3;
const emailPattern = /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+/gi;

type HeaderIndex = Record<string, string[]>;

function pushHeader(index: HeaderIndex, key: unknown, value: unknown) {
  const name = String(key || '')
    .trim()
    .toLowerCase();
  if (!name) return;
  const text = String(value || '').trim();
  if (!text) return;
  index[name] = index[name] || [];
  if (!index[name].includes(text)) index[name].push(text);
}

function headersToIndex(headers: unknown): HeaderIndex {
  const index: HeaderIndex = {};
  if (!headers) return index;
  if (Array.isArray(headers)) {
    headers.forEach((item) => {
      if (Array.isArray(item)) {
        pushHeader(index, item[0], item[1]);
        return;
      }
      if (typeof item === 'object' && item) {
        const row = item as { key?: unknown; name?: unknown; originalKey?: unknown; value?: unknown };
        pushHeader(index, row.key || row.name || row.originalKey, row.value);
      }
    });
    return index;
  }

  if (typeof headers === 'object') {
    const maybeHeaders = headers as { forEach?: unknown };
    if (typeof maybeHeaders.forEach === 'function') {
      (maybeHeaders.forEach as (callback: (value: string, key: string) => void) => void)((value, key) => pushHeader(index, key, value));
      return index;
    }

    Object.entries(headers as Record<string, unknown>).forEach(([key, value]) => {
      if (Array.isArray(value)) {
        value.forEach((item) => pushHeader(index, key, item));
        return;
      }
      pushHeader(index, key, value);
    });
  }

  return index;
}

function mergeHeaderIndexes(...items: HeaderIndex[]) {
  const merged: HeaderIndex = {};
  items.forEach((headers) => {
    Object.entries(headers).forEach(([key, values]) => values.forEach((value) => pushHeader(merged, key, value)));
  });
  return merged;
}

function headersToRecord(headers: HeaderIndex): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([key, values]) => [key, values.join('\n')]));
}

function headerValues(headers: HeaderIndex, key: string) {
  return headers[key.toLowerCase()] || [];
}

function hasForwardEvidence(headers: HeaderIndex) {
  if (FORWARD_EVIDENCE_HEADER_KEYS.some((key) => headerValues(headers, key).length > 0)) return true;

  return AUTO_FORWARD_EVIDENCE_HEADER_KEYS.some((key) =>
    headerValues(headers, key).some((value) => {
      const normalized = value.trim().toLowerCase();
      if (!normalized || normalized === 'false' || normalized === 'no' || normalized === '0') return false;
      if (key === 'auto-submitted' || key === 'autosubmitted') return /\bauto-(forwarded|generated)\b/.test(normalized);
      return true;
    })
  );
}

function visibleRecipientCandidates(headers: HeaderIndex, headerTo: string) {
  return [
    ...extractEmails(headerTo),
    ...headerValues(headers, 'to').flatMap(extractEmails),
    ...headerValues(headers, 'cc').flatMap(extractEmails),
    ...headerValues(headers, 'bcc').flatMap(extractEmails)
  ];
}

function decodeHeaderValue(value: string) {
  return value.replace(/=\?([^?]+)\?([bqBQ])\?([^?]*)\?=/g, (_, charset: string, encoding: string, body: string) => {
    try {
      const label = charset.toLowerCase();
      if (label !== 'utf-8' && label !== 'us-ascii') return body;
      if (encoding.toLowerCase() === 'b') {
        const binary = atob(body);
        return new TextDecoder(label).decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
      }
      const bytes = body.replace(/_/g, ' ').replace(/=([0-9a-f]{2})/gi, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16)));
      return new TextDecoder(label).decode(Uint8Array.from(bytes, (char) => char.charCodeAt(0)));
    } catch {
      return body;
    }
  });
}

function extractEmails(value: string) {
  return [...new Set((decodeHeaderValue(value).match(emailPattern) || []).map((email) => email.toLowerCase()))];
}

function receivedForEmails(headers: HeaderIndex) {
  return headerValues(headers, 'received')
    .slice(0, RECEIVED_HEADER_SCAN_LIMIT)
    .flatMap((value) => extractEmails((value.match(/\bfor\s+<?([^>;\s]+@[^>;\s]+)/i)?.[1] || '')));
}

function originalRecipientCandidates(headers: HeaderIndex) {
  return ORIGINAL_RECIPIENT_HEADER_KEYS.flatMap((key) => headerValues(headers, key).flatMap(extractEmails));
}

function firstExternalRecipient(candidates: string[], deliveryTo: string, managedDomains: Set<string>) {
  for (const email of candidates) {
    if (!email || email === deliveryTo) continue;
    const domain = extractDomain(email);
    if (domain && !managedDomains.has(domain)) return email;
  }
  return '';
}

function onlyDeliveryRecipient(candidates: string[], deliveryTo: string) {
  return candidates.length > 0 && candidates.every((email) => email === deliveryTo);
}

function resolveOriginalRecipient(input: {
  deliveryTo: string;
  visibleCandidates: string[];
  headerCandidates: string[];
  receivedCandidates: string[];
  managedDomains: Set<string>;
}) {
  return (
    firstExternalRecipient(input.headerCandidates, input.deliveryTo, input.managedDomains) ||
    firstExternalRecipient(input.visibleCandidates, input.deliveryTo, input.managedDomains) ||
    firstExternalRecipient(input.receivedCandidates, input.deliveryTo, input.managedDomains)
  );
}

interface AttachmentRow {
  id: string;
  mailId: string;
  filename: string;
  mimeType: string;
  size: number;
  contentId: string;
  disposition: string;
  stored: number;
  objectKey: string;
}

function attachmentSize(attachment: Record<string, unknown>) {
  const content = attachment.content as { byteLength?: number; length?: number } | undefined;
  return Number(attachment.size || content?.byteLength || content?.length || 0);
}

function attachmentObjectKey(mailId: string, attachmentId: string, filename: string) {
  const cleanName = filename.trim().replace(/[^\w.\-]+/g, '_').slice(0, 120) || 'attachment';
  return `attachments/${mailId}/${attachmentId}-${cleanName}`;
}

function attachmentRows(mailId: string, attachments: Array<Record<string, unknown>> = [], bucket?: R2Bucket): AttachmentRow[] {
  return attachments.map((attachment) => {
    const id = createId('att');
    const filename = String(attachment.filename || '');
    const objectKey = bucket ? attachmentObjectKey(mailId, id, filename) : '';
    return {
      id,
      mailId,
      filename,
      mimeType: String(attachment.mimeType || attachment.contentType || ''),
      size: attachmentSize(attachment),
      contentId: String(attachment.contentId || ''),
      disposition: String(attachment.disposition || ''),
      stored: bucket ? 1 : 0,
      objectKey
    };
  });
}

async function storeAttachmentObjects(bucket: R2Bucket, attachments: Array<Record<string, unknown>>, rows: AttachmentRow[]) {
  const storedKeys: string[] = [];
  let nextIndex = 0;
  try {
    async function worker() {
      for (;;) {
        const index = nextIndex;
        nextIndex += 1;
        const content = attachments[index]?.content;
        const row = rows[index];
        if (!row) return;
        if (!row.objectKey || !content) continue;
        await bucket.put(row.objectKey, content as ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob, {
          httpMetadata: {
            contentType: row.mimeType || 'application/octet-stream',
            contentDisposition: fileContentDisposition(row.filename || 'attachment', row.contentId ? 'inline' : 'attachment')
          }
        });
        storedKeys.push(row.objectKey);
      }
    }
    await Promise.all(Array.from({ length: Math.min(R2_ATTACHMENT_CONCURRENCY, rows.length) }, () => worker()));
  } catch (error) {
    await deleteR2ObjectsBestEffort(bucket, storedKeys);
    throw error;
  }
}

function senderDisplay(name: string, address: string) {
  return name ? `${name} <${address}>` : address;
}

async function managedDomainSet(env: Env, domains: string[]) {
  const uniqueDomains = [...new Set(domains.map((domain) => domain.trim().toLowerCase()).filter(Boolean))];
  if (uniqueDomains.length === 0) return new Set<string>();
  const placeholders = uniqueDomains.map(() => '?').join(', ');
  const rows = await env.DB.prepare(`SELECT name FROM domains WHERE name IN (${placeholders})`)
    .bind(...uniqueDomains)
    .all<{ name: string }>();
  return new Set((rows.results || []).map((row) => row.name));
}

export async function resolveIncomingRecipient(input: {
  env: Env;
  acceptForwardedMail: boolean;
  deliveryTo: string;
  headerTo: string;
  headers: HeaderIndex | Record<string, string | string[]>;
}) {
  const deliveryTo = input.deliveryTo.trim().toLowerCase();
  const headerTo = input.headerTo.trim().toLowerCase();
  const deliveryDomain = extractDomain(deliveryTo);
  const fallbackTo = deliveryTo || headerTo;
  const headers = headersToIndex(input.headers);

  if (!input.acceptForwardedMail || !deliveryTo || !deliveryDomain) {
    return { toAddr: fallbackTo, receivedByAddr: deliveryTo || fallbackTo, forwarded: false };
  }

  const headerCandidates = originalRecipientCandidates(headers);
  const receivedCandidates = receivedForEmails(headers);
  const visibleCandidates = visibleRecipientCandidates(headers, headerTo);
  const hasEvidence = hasForwardEvidence(headers);
  if (!hasEvidence && visibleCandidates.length === 0 && headerCandidates.length === 0 && receivedCandidates.length === 0) {
    return { toAddr: fallbackTo, receivedByAddr: deliveryTo || fallbackTo, forwarded: false };
  }
  if (!hasEvidence && headerCandidates.length === 0 && receivedCandidates.length === 0 && onlyDeliveryRecipient(visibleCandidates, deliveryTo)) {
    return { toAddr: fallbackTo, receivedByAddr: deliveryTo || fallbackTo, forwarded: false };
  }

  const candidateDomains = [
    deliveryDomain,
    ...visibleCandidates.map(extractDomain),
    ...headerCandidates.map(extractDomain),
    ...receivedCandidates.map(extractDomain)
  ].filter(Boolean);
  const managedDomains = await managedDomainSet(input.env, candidateDomains);
  if (!managedDomains.has(deliveryDomain)) {
    return { toAddr: fallbackTo, receivedByAddr: deliveryTo || fallbackTo, forwarded: false };
  }

  const originalRecipient = resolveOriginalRecipient({
    deliveryTo,
    visibleCandidates,
    headerCandidates,
    receivedCandidates,
    managedDomains
  });

  if (!originalRecipient) {
    return { toAddr: fallbackTo, receivedByAddr: deliveryTo || fallbackTo, forwarded: false };
  }

  return { toAddr: originalRecipient, receivedByAddr: deliveryTo, forwarded: true };
}

function buildPolicyPayloadFromDetail(mail: {
  id: string;
  messageId: string;
  fromAddr: string;
  fromName: string;
  toAddr: string;
  domain: string;
  forwarded: boolean;
  receivedByAddr: string;
  subject: string;
  bodyPreview: string;
  receivedAt: string;
  rawSize: number;
  textBody: string;
  htmlBody: string;
  headers: Record<string, string>;
  attachments: Array<{
    id: string;
    filename: string;
    mimeType: string;
    size: number;
    contentId?: string;
    disposition?: string;
    stored: boolean;
  }>;
}): MailPolicyPayload {
  return {
    event: 'mail.received',
    id: mail.id,
    messageId: mail.messageId,
    from: senderDisplay(mail.fromName, mail.fromAddr),
    fromAddr: mail.fromAddr,
    fromName: mail.fromName,
    to: mail.toAddr,
    domain: mail.domain,
    forwarded: mail.forwarded,
    receivedBy: mail.receivedByAddr,
    subject: mail.subject,
    preview: mail.bodyPreview,
    receivedAt: mail.receivedAt,
    rawSize: mail.rawSize,
    hasAttachments: mail.attachments.length > 0,
    attachmentCount: mail.attachments.length,
    textBody: mail.textBody,
    htmlBody: mail.htmlBody,
    headers: mail.headers,
    attachments: mail.attachments.map((attachment) => ({
      id: attachment.id,
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      size: attachment.size,
      contentId: attachment.contentId || '',
      disposition: attachment.disposition || '',
      stored: attachment.stored,
      downloadApiPath: attachment.stored ? `/api/mails/${mail.id}/attachments/${attachment.id}` : ''
    }))
  };
}

function buildPolicyPayload(input: {
  mailId: string;
  messageId: string;
  fromAddr: string;
  fromName: string;
  toAddr: string;
  domain: string;
  forwarded: boolean;
  receivedByAddr: string;
  subject: string;
  preview: string;
  receivedAt: string;
  rawSize: number;
  textBody: string;
  htmlBody: string;
  headers: Record<string, string>;
  attachments: AttachmentRow[];
}): MailPolicyPayload {
  return {
    ...buildPolicyPayloadFromDetail({
      id: input.mailId,
      messageId: input.messageId,
      fromAddr: input.fromAddr,
      fromName: input.fromName,
      toAddr: input.toAddr,
      domain: input.domain,
      forwarded: input.forwarded,
      receivedByAddr: input.receivedByAddr,
      subject: input.subject,
      bodyPreview: input.preview,
      receivedAt: input.receivedAt,
      rawSize: input.rawSize,
      textBody: input.textBody,
      htmlBody: input.htmlBody,
      headers: input.headers,
      attachments: input.attachments.map((attachment) => ({
        id: attachment.id,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        size: attachment.size,
        contentId: attachment.contentId,
        disposition: attachment.disposition,
        stored: attachment.stored === 1
      }))
    })
  };
}

function buildPolicyMatchPayload(input: {
  mailId: string;
  messageId: string;
  fromAddr: string;
  fromName: string;
  toAddr: string;
  domain: string;
  forwarded: boolean;
  receivedByAddr: string;
  subject: string;
  preview: string;
  receivedAt: string;
  rawSize: number;
  attachmentCount: number;
}): MailPolicyMatchPayload {
  return {
    event: 'mail.received',
    id: input.mailId,
    messageId: input.messageId,
    from: senderDisplay(input.fromName, input.fromAddr),
    fromAddr: input.fromAddr,
    fromName: input.fromName,
    to: input.toAddr,
    domain: input.domain,
    forwarded: input.forwarded,
    receivedBy: input.receivedByAddr,
    subject: input.subject,
    preview: input.preview,
    receivedAt: input.receivedAt,
    rawSize: input.rawSize,
    hasAttachments: input.attachmentCount > 0,
    attachmentCount: input.attachmentCount,
    textBody: '',
    htmlBody: ''
  };
}

export async function handleIncomingEmail(message: ForwardableEmailMessage, env: Env, ctx?: Pick<ExecutionContext, 'waitUntil'>) {
  if (message.rawSize > MAX_RAW_MAIL_BYTES) {
    message.setReject('邮件过大');
    return;
  }

  try {
    const raw = await new Response(message.raw).arrayBuffer();
    const parsed = await PostalMime.parse(raw);
    const headerIndex = mergeHeaderIndexes(headersToIndex(message.headers), headersToIndex(parsed.headers));
    const headers = headersToRecord(headerIndex);
    const system = await getSystemConfig(env);
    const recipient = await resolveIncomingRecipient({
      env,
      acceptForwardedMail: system.acceptForwardedMail,
      deliveryTo: String(message.to || ''),
      headerTo: pickEmailAddress(parsed.to),
      headers: headerIndex
    });
    const toAddr = recipient.toAddr;
    const receivedByAddr = recipient.receivedByAddr;
    const fromAddr = String(parsed.from?.address || '').toLowerCase();
    const fromName = parsed.from?.name || '';
    const domain = extractDomain(toAddr);
    const receivedAt = nowIso();
    const mailId = createId('mail');
    const attachments = (parsed.attachments || []) as Array<Record<string, unknown>>;
    const attachmentData = attachmentRows(mailId, attachments, env.MAIL_BUCKET);
    const preview = buildBodyPreview(parsed.text || '', parsed.html || '');
    const bodyChunks = buildMailBodyChunks(parsed.text || '', parsed.html || '');
    const contentSearchChunks = buildMailContentSearchChunks(parsed.text || '', parsed.html || '');
    const searchFields = buildMailSearchFields({
      fromAddr,
      fromName,
      toAddr,
      receivedByAddr,
      subject: parsed.subject || '',
      text: parsed.text || '',
      html: parsed.html || ''
    });

    if (env.MAIL_BUCKET && attachments.length > 0) {
      await storeAttachmentObjects(env.MAIL_BUCKET, attachments, attachmentData);
    }

    const statements = [
      env.DB.prepare(`INSERT INTO mails_fts (mail_id, subject, addresses) VALUES (?, ?, ?)`).bind(mailId, searchFields.subject, searchFields.addresses),
      env.DB.prepare(`INSERT INTO mail_bodies (mail_id, headers_json) VALUES (?, ?)`).bind(mailId, JSON.stringify(headers)),
      env.DB.prepare(`INSERT INTO mail_public_bodies (mail_id, text_body, html_body) VALUES (?, ?, ?)`).bind(mailId, parsed.text || '', sanitizeMailHtml(parsed.html || '')),
      ...bodyChunks.map((chunk) =>
        env.DB.prepare(
          `INSERT INTO mail_body_chunks (mail_id, kind, chunk_index, content)
           VALUES (?, ?, ?, ?)`
        ).bind(mailId, chunk.kind, chunk.index, chunk.content)
      ),
      ...contentSearchChunks.map((content, index) =>
        env.DB.prepare(
          `INSERT INTO mail_content_fts (mail_id, chunk_index, content)
           VALUES (?, ?, ?)`
        ).bind(mailId, index, content)
      ),
      ...attachmentData.map((attachment) =>
        env.DB.prepare(
          `INSERT INTO mail_attachments (
             id, mail_id, filename, mime_type, size, content_id, disposition, stored, object_key
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          attachment.id,
          attachment.mailId,
          attachment.filename,
          attachment.mimeType,
          attachment.size,
          attachment.contentId,
          attachment.disposition,
          attachment.stored,
          attachment.objectKey
        )
      ),
      env.DB.prepare(
        `INSERT INTO mails (
           id, message_id, from_addr, from_name, to_addr, domain, received_by_addr, is_forwarded, subject,
           body_preview, has_attachments, attachment_count, raw_size, received_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        mailId,
        parsed.messageId || '',
        fromAddr,
        fromName,
        toAddr,
        domain,
        receivedByAddr,
        recipient.forwarded ? 1 : 0,
        parsed.subject || '',
        preview,
        attachmentData.length > 0 ? 1 : 0,
        attachmentData.length,
        raw.byteLength,
        receivedAt
      )
    ];

    try {
      await env.DB.batch(statements);
    } catch (error) {
      await deleteR2ObjectsBestEffort(env.MAIL_BUCKET, attachmentData.map((item) => item.objectKey).filter(Boolean));
      throw error;
    }

    const policyBase = {
      mailId,
      messageId: parsed.messageId || '',
      fromAddr,
      fromName,
      toAddr,
      domain,
      forwarded: recipient.forwarded,
      receivedByAddr,
      subject: parsed.subject || '',
      preview,
      receivedAt,
      rawSize: raw.byteLength,
      textBody: parsed.text || '',
      htmlBody: parsed.html || ''
    };

    let shareUrlPromise: Promise<string> | undefined;
    await runMailPolicies(env, {
      env,
      matchPayload: buildPolicyMatchPayload({ ...policyBase, attachmentCount: attachmentData.length }),
      fullPayload: () =>
        buildPolicyPayload({
          ...policyBase,
          headers,
          attachments: attachmentData
        }),
      shareUrl: () => {
        shareUrlPromise ||= createMailShare(env, mailId).then((share) => share.url);
        return shareUrlPromise;
      },
      forward: (to) => message.forward(to),
      executionCtx: ctx
    });
  } catch (error) {
    console.error('邮件接收异常:', error);
    throw error;
  }
}

export async function deleteMails(env: Env, ids: string[]) {
  const uniqueIds = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
  if (uniqueIds.length === 0) return 0;

  const placeholders = uniqueIds.map(() => '?').join(', ');
  const attachments = await env.DB.prepare(
    `SELECT object_key AS objectKey
     FROM mail_attachments
     WHERE mail_id IN (${placeholders}) AND stored = 1 AND object_key <> ''`
  )
    .bind(...uniqueIds)
    .all<{ objectKey: string }>();

  await deleteR2Objects(env.MAIL_BUCKET, (attachments.results || []).map((item) => item.objectKey));

  const result = await env.DB.batch([
    env.DB.prepare(`DELETE FROM mails_fts WHERE mail_id IN (${placeholders})`).bind(...uniqueIds),
    env.DB.prepare(`DELETE FROM mail_content_fts WHERE mail_id IN (${placeholders})`).bind(...uniqueIds),
    env.DB.prepare(`DELETE FROM mail_body_chunks WHERE mail_id IN (${placeholders})`).bind(...uniqueIds),
    env.DB.prepare(`DELETE FROM mail_public_bodies WHERE mail_id IN (${placeholders})`).bind(...uniqueIds),
    env.DB.prepare(`DELETE FROM mail_attachments WHERE mail_id IN (${placeholders})`).bind(...uniqueIds),
    env.DB.prepare(`DELETE FROM mail_bodies WHERE mail_id IN (${placeholders})`).bind(...uniqueIds),
    env.DB.prepare(`DELETE FROM mails WHERE id IN (${placeholders})`).bind(...uniqueIds)
  ]);

  await deleteMailShares(env, uniqueIds).catch((error) => console.error('删除邮件分享记录失败', error));

  return Number(result[result.length - 1]?.meta.changes || 0);
}

export async function cleanupExpiredMails(env: Env) {
  const system = await getSystemConfig(env);
  if (!system.cleanupEnabled || system.mailRetentionDays <= 0) {
    return { receivedDeleted: 0, sentDeleted: 0, deleted: 0 };
  }

  const cutoff = new Date(Date.now() - system.mailRetentionDays * 24 * 60 * 60 * 1000).toISOString();
  let receivedDeleted = 0;
  let sentDeleted = 0;

  for (;;) {
    const rows = await env.DB.prepare(
      `SELECT id
       FROM mails
       WHERE received_at < ?
       ORDER BY received_at ASC
       LIMIT ?`
    )
      .bind(cutoff, CLEANUP_BATCH_SIZE)
      .all<{ id: string }>();
    const items = rows.results || [];
    if (items.length === 0) break;

    const ids = items.map((item) => item.id);
    receivedDeleted += await deleteMails(env, ids);
  }

  for (;;) {
    const rows = await env.DB.prepare(
      `SELECT id
       FROM sent_mails
       WHERE sent_at < ?
       ORDER BY sent_at ASC
       LIMIT ?`
    )
      .bind(cutoff, CLEANUP_BATCH_SIZE)
      .all<{ id: string }>();
    const items = rows.results || [];
    if (items.length === 0) break;

    const ids = items.map((item) => item.id);
    sentDeleted += await deleteSentMails(env, ids);
  }

  return {
    receivedDeleted,
    sentDeleted,
    deleted: receivedDeleted + sentDeleted,
    cutoff
  };
}
