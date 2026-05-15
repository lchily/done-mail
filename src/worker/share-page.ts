import { getMailAttachmentResponse } from './mail-attachments';
import { getSharedMailDetail, readMailShare, type MailAttachmentView } from './mail-share';
import type { Env } from './types';

const logoPath = '/static/logo-mark.svg';
function shareContentSecurityPolicy(allowRemoteImages = false) {
  return [
    "default-src 'none'",
    allowRemoteImages ? "img-src 'self' data: https:" : "img-src 'self' data:",
    "style-src 'unsafe-inline'",
    "frame-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'"
  ].join('; ');
}

const shareSecurityHeaders = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff'
};

function escapeHtml(value: unknown) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function htmlResponse(html: string, status = 200, allowRemoteImages = false) {
  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      ...shareSecurityHeaders,
      'Content-Security-Policy': shareContentSecurityPolicy(allowRemoteImages)
    }
  });
}

function formatBytes(size: number) {
  if (!Number.isFinite(size) || size <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = size;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value >= 10 || index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value || '-';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date);
}

function senderText(fromName: string, fromAddr: string) {
  return fromName ? `${fromName} <${fromAddr}>` : fromAddr || '-';
}

function attachmentUrl(token: string, attachment: MailAttachmentView) {
  return `/mail/${encodeURIComponent(token)}/attachments/${encodeURIComponent(attachment.id)}`;
}

function sharePageUrl(token: string, allowRemoteImages: boolean) {
  const path = `/mail/${encodeURIComponent(token)}`;
  return allowRemoteImages ? `${path}?remote=true` : path;
}

function hasRemoteImages(html: string) {
  return /<img\b[^>]*\s+src\s*=\s*(?:"\s*(?:https?:)?\/\/[^"]*"|'\s*(?:https?:)?\/\/[^']*'|\s*(?:https?:)?\/\/[^\s>]+)/i.test(html);
}

function renderAttachments(token: string, attachments: MailAttachmentView[]) {
  const items = attachments
    .map((attachment) => {
      const meta = `${escapeHtml(formatBytes(attachment.size))} · ${attachment.stored ? '可下载' : '仅保存信息'}`;
      const label = `
        <span class="attachment-icon">File</span>
        <span class="attachment-text">
          <strong>${escapeHtml(attachment.filename || '未命名附件')}</strong>
          <small>${meta}</small>
        </span>
      `;
      if (!attachment.stored) return `<span class="attachment disabled">${label}</span>`;
      return `<a class="attachment" href="${attachmentUrl(token, attachment)}">${label}</a>`;
    })
    .join('');
  return attachments.length ? `<section class="attachments">${items}</section>` : '';
}

function renderBody(htmlBody: string, textBody: string, allowRemoteImages: boolean) {
  if (htmlBody) {
    const imageSources = allowRemoteImages ? 'data: cid: https:' : 'data: cid:';
    const remoteImageStyle = allowRemoteImages ? '' : 'img[src^="http://"],img[src^="https://"],img[src^="//"]{display:none!important}';
    const srcdoc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${imageSources}; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; navigate-to 'none'"><base target="_blank"><style>body{margin:0;font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#111827;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%}${remoteImageStyle}</style></head><body>${htmlBody}</body></html>`;
    return `<iframe class="mail-frame" sandbox="allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer" srcdoc="${escapeHtml(srcdoc)}"></iframe>`;
  }
  return `<pre>${escapeHtml(textBody || '无正文')}</pre>`;
}

function renderRemoteImagesNote(token: string, htmlBody: string, allowRemoteImages: boolean) {
  if (!htmlBody || allowRemoteImages || !hasRemoteImages(htmlBody)) return '';
  return `<div class="remote-images-note"><span>已隐藏远程图片</span><a href="${sharePageUrl(token, true)}">显示图片</a></div>`;
}

function renderShell(title: string, body: string) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <title>${escapeHtml(title || '邮件')}</title>
  <style>
    :root{color-scheme:light;--bg:#f6f8fb;--panel:#fff;--text:#111827;--muted:#6b7280;--border:#dfe3e8;--soft:#f8fafc;--primary:#086fff}
    *{box-sizing:border-box}
    body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    .shell{min-height:100vh;padding:0 max(18px,calc((100vw - 1080px)/2)) 34px}
    .brand{display:flex;align-items:center;gap:10px;height:54px;font-size:16px;font-weight:760}
    .brand img{width:24px;height:24px;object-fit:contain}
    .card{overflow:hidden;background:var(--panel);border:1px solid var(--border);border-radius:8px;box-shadow:0 18px 44px rgba(15,23,42,.08)}
    .head{display:grid;gap:8px;padding:18px 22px;border-bottom:1px solid var(--border)}
    h1{margin:0;font-size:24px;line-height:1.24;overflow-wrap:anywhere}
    .meta{display:flex;flex-wrap:wrap;gap:6px 18px;color:var(--muted)}
    .body{padding:24px}
    .remote-images-note{display:inline-flex;align-items:center;gap:8px;min-height:28px;margin:0 24px;padding-top:16px;color:var(--muted);font-size:12px;line-height:1}
    .remote-images-note a{color:var(--primary);font-weight:680;text-decoration:none}
    .remote-images-note a:hover{color:#005bd1}
    .mail-frame{display:block;width:100%;height:clamp(520px,58vh,720px);border:0;background:#fff}
    pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font:14px/1.7 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
    .attachments{display:grid;gap:10px;padding:24px;border-top:1px solid var(--border);background:var(--soft)}
    .attachment{display:grid;grid-template-columns:32px minmax(0,1fr);align-items:center;gap:10px;min-height:48px;padding:10px 12px;color:inherit;text-decoration:none;background:#fff;border:1px solid var(--border);border-radius:8px}
    .attachment.disabled{opacity:.55}
    .attachment-text{display:grid;min-width:0}
    .attachment strong,.attachment small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .attachment small{color:var(--muted)}
    .state{display:grid;place-items:center;min-height:360px;text-align:center;padding:24px}
    .state h1{font-size:22px}
    .state p{margin:8px 0 0;color:var(--muted)}
    @media(max-width:720px){.shell{padding:0 12px 20px}.head{padding:16px}.body,.attachments{padding:18px}.remote-images-note{margin:0 18px}.meta{display:grid}.mail-frame{height:62vh}}
  </style>
</head>
<body>
  <main class="shell">
    <header class="brand"><img src="${logoPath}" alt="DoneMail"><span>DoneMail</span></header>
    ${body}
  </main>
</body>
</html>`;
}

function renderExpiredPage() {
  return renderShell('链接已失效', '<section class="card state"><div><h1>链接已失效</h1><p>这封邮件分享不存在或已经过期。</p></div></section>');
}

export function renderShareRateLimitedPage() {
  return htmlResponse(renderShell('访问过于频繁', '<section class="card state"><div><h1>访问过于频繁</h1><p>请稍后再打开这封邮件分享。</p></div></section>'), 429);
}

export async function renderSharePage(env: Env, token: string, allowRemoteImages = false) {
  const detail = await getSharedMailDetail(env, token);
  if (!detail) return htmlResponse(renderExpiredPage(), 404);

  const { mail, share } = detail;
  const body = `<article class="card">
    <header class="head">
      <h1>${escapeHtml(mail.subject || '无主题')}</h1>
      <div class="meta">
        <span>${escapeHtml(senderText(mail.fromName, mail.fromAddr))}</span>
        <span>${escapeHtml(formatDate(mail.receivedAt))}</span>
        <span>有效期至 ${escapeHtml(formatDate(share.expiresAt))}</span>
      </div>
    </header>
    ${renderRemoteImagesNote(token, mail.htmlBody, allowRemoteImages)}
    <section class="body">${renderBody(mail.htmlBody, mail.textBody, allowRemoteImages)}</section>
    ${renderAttachments(token, mail.attachments)}
  </article>`;
  return htmlResponse(renderShell(mail.subject || '邮件', body), 200, allowRemoteImages);
}

async function getSharedAttachmentResponse(env: Env, token: string, attachmentId: string) {
  const share = await readMailShare(env, token);
  if (!share || !env.MAIL_BUCKET) return null;
  return getMailAttachmentResponse(env, share.mailId, attachmentId, env.MAIL_BUCKET);
}

export async function downloadShareAttachment(env: Env, token: string, attachmentId: string) {
  const response = await getSharedAttachmentResponse(env, token, attachmentId);
  if (!response) return htmlResponse(renderExpiredPage(), 404);
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'no-store');
  headers.set('Referrer-Policy', shareSecurityHeaders['Referrer-Policy']);
  headers.set('X-Content-Type-Options', shareSecurityHeaders['X-Content-Type-Options']);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}
