import { Hono, type Context } from 'hono';
import { buildFtsQuery, buildFtsTerms } from '../mail-content';
import { listSafeMailBodies } from '../mail-bodies';
import { deleteMails } from '../mail';
import { getMailAttachmentResponse } from '../mail-attachments';
import { createMailShare, getMailDetailView } from '../mail-share';
import { publicFail, publicOk } from '../http/public-response';
import { encodeCursor, mailPageSize, maxBatchDeleteSize, normalizeSearchKeyword, pageSize, parseBatchIds, parseBooleanQuery, parseCursor } from '../http/query';
import type { Env } from '../types';
import { apiOk, jsonFail } from '../utils';

const mailsRoutes = new Hono<{ Bindings: Env }>();
export const publicMailsRoutes = new Hono<{ Bindings: Env }>();
type AppContext = Context<{ Bindings: Env }>;
type MailRow = ReturnType<typeof mapMailRow>;
type PublicMailRow = MailRow & {
  textBody: string;
  htmlBody: string;
  attachments: PublicMailAttachment[];
};
interface PublicMailAttachment {
  id: string;
  mailId: string;
  filename: string;
  mimeType: string;
  size: number;
  contentId: string;
  disposition: string;
  stored: boolean;
}
interface MailListQuery {
  perPage: number;
  cursor?: string;
  keyword?: string;
  domain?: string;
  to?: string;
  from?: string;
  hasAttachments?: boolean | null;
}
interface PublicMailListQuery {
  perPage: number;
  cursor?: string;
  subject?: string;
  content?: string;
  domain?: string;
  to?: string;
  from?: string;
  hasAttachments?: boolean | null;
  includeAttachments?: boolean;
  waitUntil?: (promise: Promise<unknown>) => void;
}
const mailListSelect = `mails.id, mails.message_id AS messageId, mails.from_addr AS fromAddr, mails.from_name AS fromName,
       mails.to_addr AS toAddr, mails.domain, mails.received_by_addr AS receivedByAddr, mails.is_forwarded AS isForwarded,
       mails.subject, mails.body_preview AS bodyPreview,
       mails.has_attachments AS hasAttachments, mails.attachment_count AS attachmentCount,
       mails.raw_size AS rawSize, mails.received_at AS receivedAt, mails.created_at AS createdAt`;
const publicMailPageSelect = `mails.id, mails.messageId, mails.fromAddr, mails.fromName,
       mails.toAddr, mails.domain, mails.receivedByAddr, mails.isForwarded,
       mails.subject, mails.bodyPreview,
       mails.hasAttachments, mails.attachmentCount,
       mails.rawSize, mails.receivedAt, mails.createdAt`;
const publicMailPageOrder = `mails.receivedAt DESC, mails.id DESC`;

function intersectSql(items: string[]) {
  return items.join('\nINTERSECT\n');
}

function sharedMailMatchSql(keyword: string, params: string[]) {
  const terms = keyword ? buildFtsTerms(keyword) : [];
  if (!terms.length) return '';
  const matches = terms.map(() => `SELECT mail_id FROM (
  SELECT mail_id FROM mails_fts WHERE mails_fts MATCH ?
UNION
  SELECT DISTINCT mail_id FROM mail_content_fts WHERE mail_content_fts MATCH ?
)`);
  params.push(...terms.flatMap((term) => [term, term]));
  return intersectSql(matches);
}

function publicMailMatchSql(subject: string, content: string, params: string[]) {
  const match: string[] = [];
  const subjectQuery = subject ? buildFtsQuery(subject, 'subject') : '';
  const contentQuery = content ? buildFtsQuery(content) : '';

  if (subjectQuery) {
    match.push(`SELECT mail_id FROM mails_fts WHERE mails_fts MATCH ?`);
    params.push(subjectQuery);
  }
  if (contentQuery) {
    match.push(`SELECT DISTINCT mail_id FROM mail_content_fts WHERE mail_content_fts MATCH ?`);
    params.push(contentQuery);
  }

  return match.length ? intersectSql(match) : '';
}

function mapMailRow(row: Record<string, unknown>) {
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
    createdAt: String(row.createdAt || '')
  };
}

async function listMailRows(env: Env, query: MailListQuery) {
  const where: string[] = [];
  const params: unknown[] = [];
  const cursor = parseCursor(query.cursor || '');
  const keyword = normalizeSearchKeyword(query.keyword || '');

  pushMailFilters(where, params, query);
  if (cursor) {
    where.push(`(mails.received_at < ? OR (mails.received_at = ? AND mails.id < ?))`);
    params.push(cursor.receivedAt, cursor.receivedAt, cursor.id);
  }

  const limit = query.perPage + 1;
  const matchParams: string[] = [];
  const matchSql = sharedMailMatchSql(keyword, matchParams);
  const sql = matchSql
    ? `WITH matched AS (
         ${matchSql}
       )
       SELECT ${mailListSelect}
       FROM matched
       JOIN mails ON mails.id = matched.mail_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY mails.received_at DESC, mails.id DESC
       LIMIT ?`
    : `SELECT ${mailListSelect}
       FROM mails
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY mails.received_at DESC, mails.id DESC
       LIMIT ?`;
  const bindParams = matchSql ? [...matchParams, ...params, limit] : [...params, limit];
  const rows = await env.DB.prepare(
    sql
  )
    .bind(...bindParams)
    .all<Record<string, unknown>>();

  const rawItems = rows.results || [];
  const hasMore = rawItems.length > query.perPage;
  const pageItems = rawItems.slice(0, query.perPage).map(mapMailRow);
  return {
    items: pageItems,
    hasMore,
    nextCursor: hasMore ? encodeCursor(pageItems[pageItems.length - 1]) : ''
  };
}

function pushMailFilters(where: string[], params: unknown[], query: Pick<PublicMailListQuery, 'from' | 'to' | 'domain' | 'hasAttachments'>) {
  if (query.from) {
    where.push(`mails.from_addr = ?`);
    params.push(query.from.toLowerCase());
  }
  if (query.to) {
    where.push(`mails.to_addr = ?`);
    params.push(query.to.toLowerCase());
  }
  if (query.domain) {
    where.push(`mails.domain = ?`);
    params.push(query.domain.toLowerCase());
  }
  if (query.hasAttachments !== null && query.hasAttachments !== undefined) {
    where.push('mails.has_attachments = ?');
    params.push(query.hasAttachments ? 1 : 0);
  }
}

function mapPublicMailAttachment(row: Record<string, unknown>): PublicMailAttachment {
  return {
    id: String(row.id || ''),
    mailId: String(row.mailId || ''),
    filename: String(row.filename || ''),
    mimeType: String(row.mimeType || ''),
    size: Number(row.size || 0),
    contentId: String(row.contentId || ''),
    disposition: String(row.disposition || ''),
    stored: Number(row.stored || 0) === 1
  };
}

function waitUntilFromContext(c: AppContext) {
  try {
    const executionCtx = c.executionCtx;
    return (promise: Promise<unknown>) => executionCtx.waitUntil(promise);
  } catch {
    return undefined;
  }
}

async function listPublicMailRows(env: Env, query: PublicMailListQuery) {
  const where: string[] = [];
  const params: unknown[] = [];
  const cursor = parseCursor(query.cursor || '');
  const subject = normalizeSearchKeyword(query.subject || '');
  const content = normalizeSearchKeyword(query.content || '');
  const matchParams: string[] = [];
  const matchSql = publicMailMatchSql(subject, content, matchParams);

  pushMailFilters(where, params, query);
  if (cursor) {
    where.push(`(mails.received_at < ? OR (mails.received_at = ? AND mails.id < ?))`);
    params.push(cursor.receivedAt, cursor.receivedAt, cursor.id);
  }

  const limit = query.perPage + 1;
  const sql = matchSql
    ? `WITH matched AS (
         ${matchSql}
       ),
       page AS (
         SELECT ${mailListSelect}
         FROM matched
         JOIN mails ON mails.id = matched.mail_id
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY mails.received_at DESC, mails.id DESC
         LIMIT ?
       )
       SELECT ${publicMailPageSelect}
       FROM page AS mails
       ORDER BY ${publicMailPageOrder}`
    : `WITH page AS (
         SELECT ${mailListSelect}
         FROM mails
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY mails.received_at DESC, mails.id DESC
         LIMIT ?
       )
       SELECT ${publicMailPageSelect}
       FROM page AS mails
       ORDER BY ${publicMailPageOrder}`;
  const bindParams = matchSql ? [...matchParams, ...params, limit] : [...params, limit];
  const rows = await env.DB.prepare(sql)
    .bind(...bindParams)
    .all<Record<string, unknown>>();

  const rawItems = rows.results || [];
  const hasMore = rawItems.length > query.perPage;
  const pageItems = rawItems.slice(0, query.perPage).map((row) => ({
    ...mapMailRow(row),
    textBody: '',
    htmlBody: '',
    attachments: [] as PublicMailAttachment[]
  }));
  if (pageItems.length > 0) {
    const placeholders = pageItems.map(() => '?').join(', ');
    const mailIds = pageItems.map((item) => item.id);
    const bodiesPromise = listSafeMailBodies(env, mailIds, { waitUntil: query.waitUntil });
    const attachmentRowsPromise = query.includeAttachments
      ? env.DB.prepare(
        `SELECT id, mail_id AS mailId, filename, mime_type AS mimeType, size, content_id AS contentId,
                disposition, stored
         FROM mail_attachments
         WHERE mail_id IN (${placeholders})
         ORDER BY mail_id, created_at ASC, id ASC`
      )
        .bind(...mailIds)
        .all<Record<string, unknown>>()
      : Promise.resolve({ results: [] as Record<string, unknown>[] });
    const [bodies, attachmentRows] = await Promise.all([bodiesPromise, attachmentRowsPromise]);
    const attachmentsByMail = new Map<string, PublicMailAttachment[]>();
    for (const row of attachmentRows.results || []) {
      const attachment = mapPublicMailAttachment(row);
      const current = attachmentsByMail.get(attachment.mailId) || [];
      current.push(attachment);
      attachmentsByMail.set(attachment.mailId, current);
    }
    pageItems.forEach((item) => {
      const body = bodies.get(item.id);
      item.textBody = body?.textBody || '';
      item.htmlBody = body?.htmlBody || '';
      item.attachments = attachmentsByMail.get(item.id) || [];
    });
  }

  return {
    items: pageItems,
    hasMore,
    nextCursor: hasMore ? encodeCursor(pageItems[pageItems.length - 1]) : ''
  };
}

function publicMailFullItem(mail: PublicMailRow, includeAttachments = false) {
  const item = {
    id: mail.id,
    messageId: mail.messageId,
    from: mail.fromAddr,
    fromName: mail.fromName,
    to: mail.toAddr,
    toDomain: mail.domain,
    forwarded: mail.forwarded,
    subject: mail.subject,
    preview: mail.bodyPreview,
    text: mail.textBody,
    html: mail.htmlBody,
    hasAttachments: mail.hasAttachments,
    attachmentCount: mail.attachmentCount,
    size: mail.rawSize,
    receivedAt: mail.receivedAt
  };
  if (!includeAttachments) return item;
  return {
    ...item,
    attachments: mail.attachments.map((attachment) => ({
      id: attachment.id,
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      size: attachment.size,
      contentId: attachment.contentId,
      disposition: attachment.disposition,
      stored: attachment.stored
    }))
  };
}

async function listPublicMails(c: AppContext) {
  const perPage = pageSize(c.req.query('limit'), 20, 1, 50);
  const from = (c.req.query('from') || '').trim().toLowerCase();
  const to = (c.req.query('to') || '').trim().toLowerCase();
  const toDomain = (c.req.query('toDomain') || '').trim().toLowerCase();
  const subject = normalizeSearchKeyword(c.req.query('subject') || '');
  const content = normalizeSearchKeyword(c.req.query('content') || '');
  let hasAttachments: boolean | null;
  let includeAttachments: boolean;
  try {
    hasAttachments = parseBooleanQuery(c.req.query('hasAttachments'), 'hasAttachments');
    includeAttachments = parseBooleanQuery(c.req.query('includeAttachments'), 'includeAttachments') === true;
  } catch (error) {
    return publicFail(c, error instanceof Error ? error.message : '布尔参数格式错误', 400, 'invalid_boolean');
  }
  const page = await listPublicMailRows(c.env, {
    perPage,
    cursor: (c.req.query('cursor') || '').trim(),
    subject,
    content,
    from,
    to,
    domain: toDomain,
    hasAttachments,
    includeAttachments,
    waitUntil: waitUntilFromContext(c)
  });

  return publicOk(c, page.items.map((item) => publicMailFullItem(item, includeAttachments)), {
    limit: perPage,
    nextCursor: page.nextCursor,
    hasMore: page.hasMore
  });
}

async function listMails(c: AppContext) {
  const perPage = mailPageSize(c.req.query('per_page') || c.req.query('pageSize'));
  const cursor = (c.req.query('cursor') || '').trim();
  const keyword = normalizeSearchKeyword(c.req.query('keyword') || '');
  const domain = (c.req.query('domain') || '').trim();
  const to = (c.req.query('to') || '').trim();
  const page = await listMailRows(c.env, { perPage, cursor, keyword, domain, to });

  return apiOk(c, page.items, {
    per_page: perPage,
    next_cursor: page.nextCursor,
    has_more: page.hasMore
  });
}

async function getLatestMail(c: AppContext) {
  const row = await c.env.DB.prepare(
    `SELECT ${mailListSelect}
     FROM mails
     ORDER BY received_at DESC, id DESC
     LIMIT 1`
  ).first<Record<string, unknown>>();

  return apiOk(c, row ? mapMailRow(row) : null);
}

async function getMailDetail(c: AppContext) {
  const mail = await getMailDetailView(c.env, c.req.param('id') || '', {
    waitUntil: waitUntilFromContext(c)
  });
  return mail ? apiOk(c, mail) : jsonFail(c, '邮件不存在', 404);
}

async function downloadMailAttachment(c: AppContext) {
  if (!c.env.MAIL_BUCKET) return jsonFail(c, '未启用附件保存', 404, 'attachment_storage_disabled');
  return (await getMailAttachmentResponse(c.env, c.req.param('id') || '', c.req.param('attachmentId') || '', c.env.MAIL_BUCKET)) || jsonFail(c, '附件不存在或未保存内容', 404, 'attachment_not_found');
}

async function downloadPublicMailAttachment(c: AppContext) {
  if (!c.env.MAIL_BUCKET) return publicFail(c, '未启用附件保存', 404, 'attachment_storage_disabled');
  return (await getMailAttachmentResponse(c.env, c.req.param('id') || '', c.req.param('attachmentId') || '', c.env.MAIL_BUCKET)) || publicFail(c, '附件不存在或未保存内容', 404, 'attachment_not_found');
}

async function createShare(c: AppContext) {
  try {
    return apiOk(c, await createMailShare(c.env, c.req.param('id') || ''));
  } catch (error) {
    return jsonFail(c, error instanceof Error ? error.message : '分享链接生成失败', 400, 'mail_share_failed');
  }
}

async function createPublicShare(c: AppContext) {
  try {
    return publicOk(c, await createMailShare(c.env, c.req.param('id') || ''));
  } catch (error) {
    return publicFail(c, error instanceof Error ? error.message : '分享链接生成失败', 400, 'mail_share_failed');
  }
}

mailsRoutes.get('/', listMails);

mailsRoutes.post('/batch-delete', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const ids = parseBatchIds(body);

  if (ids.length === 0) return jsonFail(c, '请选择要删除的邮件', 400);
  if (ids.length > maxBatchDeleteSize) return jsonFail(c, `单次最多删除 ${maxBatchDeleteSize} 封邮件`, 400, 'batch_too_large');

  return apiOk(c, { ids, deleted: await deleteMails(c.env, ids) });
});

mailsRoutes.delete('/:id', async (c) => {
  const id = c.req.param('id');
  return apiOk(c, { id, deleted: await deleteMails(c.env, [id]) });
});

mailsRoutes.post('/:id/share', createShare);
mailsRoutes.get('/latest', getLatestMail);
mailsRoutes.get('/:id', getMailDetail);
mailsRoutes.get('/:id/attachments/:attachmentId', downloadMailAttachment);

publicMailsRoutes.get('/', listPublicMails);
publicMailsRoutes.post('/:id/share', createPublicShare);
publicMailsRoutes.get('/:id/attachments/:attachmentId', downloadPublicMailAttachment);

export default mailsRoutes;
