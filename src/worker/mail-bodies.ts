import { restoreMailBodyChunks, sanitizeMailHtml } from './mail-content';
import type { Env } from './types';

interface MailBodyReadOptions {
  waitUntil?: (promise: Promise<unknown>) => void;
}

interface SafeMailBody {
  textBody: string;
  htmlBody: string;
}

async function writeSafeMailBodies(env: Env, bodies: Map<string, SafeMailBody>) {
  const statements = [...bodies.entries()].map(([mailId, body]) =>
    env.DB.prepare(
      `INSERT OR REPLACE INTO mail_safe_bodies (mail_id, text_body, html_body)
       VALUES (?, ?, ?)`
    ).bind(mailId, body.textBody, body.htmlBody)
  );
  if (statements.length > 0) await env.DB.batch(statements);
}

function writeSafeMailBodiesInBackground(env: Env, bodies: Map<string, SafeMailBody>, options: MailBodyReadOptions) {
  if (bodies.size === 0) return Promise.resolve();
  const write = writeSafeMailBodies(env, bodies).catch((error) => console.error('写入安全正文快读表失败', error));
  if (options.waitUntil) {
    options.waitUntil(write);
    return Promise.resolve();
  }
  return write;
}

async function readChunkMailBodies(env: Env, mailIds: string[]) {
  const bodies = new Map<string, SafeMailBody>();
  if (mailIds.length === 0) return bodies;
  const placeholders = mailIds.map(() => '?').join(', ');
  const rows = await env.DB.prepare(
    `SELECT mail_id AS mailId, kind, chunk_index AS chunkIndex, content
     FROM mail_body_chunks
     WHERE mail_id IN (${placeholders})
     ORDER BY mail_id, kind, chunk_index ASC`
  )
    .bind(...mailIds)
    .all<Record<string, unknown>>();

  const rowsByMail = new Map<string, Array<Record<string, unknown>>>();
  for (const row of rows.results || []) {
    const mailId = String(row.mailId || '');
    const current = rowsByMail.get(mailId) || [];
    current.push(row);
    rowsByMail.set(mailId, current);
  }

  for (const mailId of mailIds) {
    const body = restoreMailBodyChunks(rowsByMail.get(mailId) || []);
    bodies.set(mailId, {
      textBody: body.textBody,
      htmlBody: sanitizeMailHtml(body.htmlBody)
    });
  }
  return bodies;
}

export async function getMailBody(env: Env, mailId: string, options: MailBodyReadOptions = {}) {
  const [meta, bodies] = await Promise.all([
    env.DB.prepare(
      `SELECT headers_json AS headersJson
       FROM mail_bodies
       WHERE mail_id = ?`
    )
      .bind(mailId)
      .first<Record<string, unknown>>(),
    listSafeMailBodies(env, [mailId], options)
  ]);
  const body = bodies.get(mailId) || { textBody: '', htmlBody: '' };

  return {
    textBody: body.textBody,
    htmlBody: body.htmlBody,
    headersJson: String(meta?.headersJson || '{}')
  };
}

export async function listSafeMailBodies(env: Env, mailIds: string[], options: MailBodyReadOptions = {}) {
  if (mailIds.length === 0) return new Map<string, { textBody: string; htmlBody: string }>();
  const uniqueIds = [...new Set(mailIds.map((mailId) => mailId.trim()).filter(Boolean))];
  if (uniqueIds.length === 0) return new Map<string, { textBody: string; htmlBody: string }>();
  const placeholders = uniqueIds.map(() => '?').join(', ');
  const rows = await env.DB.prepare(
    `SELECT mail_id AS mailId, text_body AS textBody, html_body AS htmlBody
     FROM mail_safe_bodies
     WHERE mail_id IN (${placeholders})`
  )
    .bind(...uniqueIds)
    .all<Record<string, unknown>>();

  const bodies = new Map<string, { textBody: string; htmlBody: string }>();
  for (const row of rows.results || []) {
    bodies.set(String(row.mailId || ''), {
      textBody: String(row.textBody || ''),
      htmlBody: String(row.htmlBody || '')
    });
  }

  const missingIds = uniqueIds.filter((mailId) => !bodies.has(mailId));
  if (missingIds.length > 0) {
    const fallback = await readChunkMailBodies(env, missingIds);
    for (const mailId of missingIds) {
      const body = fallback.get(mailId);
      bodies.set(mailId, {
        textBody: body?.textBody || '',
        htmlBody: body?.htmlBody || ''
      });
    }
    await writeSafeMailBodiesInBackground(env, fallback, options);
  }

  return bodies;
}
