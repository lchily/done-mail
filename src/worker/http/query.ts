export const maxMailPageSize = 100;
export const maxBatchDeleteSize = 200;

export function pageNumber(value: string | undefined) {
  const page = Number(value || 1);
  if (!Number.isFinite(page)) return 1;
  return Math.max(Math.floor(page), 1);
}

export function pageSize(value: string | undefined, fallback = 20, min = 5, max = 100) {
  const size = Number(value || fallback);
  if (!Number.isFinite(size)) return fallback;
  return Math.min(Math.max(Math.floor(size), min), max);
}

export function mailPageSize(value: string | undefined) {
  const size = Number(value || 50);
  if (!Number.isFinite(size)) return 50;
  return Math.min(Math.max(Math.floor(size), 1), maxMailPageSize);
}

export function normalizeSearchKeyword(value: string) {
  return value.trim();
}

export function parseBooleanQuery(value: string | undefined, name: string) {
  if (value === undefined) return null;
  const normalized = value.trim();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  throw new Error(`${name} 仅支持 true 或 false`);
}

export function parseBatchIds(body: unknown) {
  const rawIds = body && typeof body === 'object' ? (body as { ids?: unknown }).ids : [];
  return Array.isArray(rawIds) ? [...new Set(rawIds.map((item) => String(item).trim()).filter(Boolean))] : [];
}

export function parseCursor(value: string) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(atob(value)) as { receivedAt?: unknown; id?: unknown };
    const receivedAt = String(parsed.receivedAt || '');
    const id = String(parsed.id || '');
    return receivedAt && id ? { receivedAt, id } : null;
  } catch {
    return null;
  }
}

export function parseCreatedAtCursor(value: string) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(atob(value)) as { createdAt?: unknown; id?: unknown };
    const createdAt = String(parsed.createdAt || '');
    const id = String(parsed.id || '');
    return createdAt && id ? { createdAt, id } : null;
  } catch {
    return null;
  }
}

export function parseSentCursor(value: string) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(atob(value)) as { sentAt?: unknown; id?: unknown };
    const sentAt = String(parsed.sentAt || '');
    const id = String(parsed.id || '');
    return sentAt && id ? { sentAt, id } : null;
  } catch {
    return null;
  }
}

export function parseNameCursor(value: string) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(atob(value)) as { name?: unknown; id?: unknown };
    const name = String(parsed.name || '');
    const id = String(parsed.id || '');
    return name && id ? { name, id } : null;
  } catch {
    return null;
  }
}

export function encodeCursor(row: { receivedAt?: unknown; id?: unknown }) {
  const receivedAt = String(row.receivedAt || '');
  const id = String(row.id || '');
  if (!receivedAt || !id) return '';
  return btoa(JSON.stringify({ receivedAt, id }));
}

export function encodeSentCursor(row: { sentAt?: unknown; id?: unknown }) {
  const sentAt = String(row.sentAt || '');
  const id = String(row.id || '');
  if (!sentAt || !id) return '';
  return btoa(JSON.stringify({ sentAt, id }));
}

export function encodeNameCursor(row: { name?: unknown; id?: unknown }) {
  const name = String(row.name || '');
  const id = String(row.id || '');
  if (!name || !id) return '';
  return btoa(JSON.stringify({ name, id }));
}

export function encodeCreatedAtCursor(row: { createdAt?: unknown; id?: unknown }) {
  const createdAt = String(row.createdAt || '');
  const id = String(row.id || '');
  if (!createdAt || !id) return '';
  return btoa(JSON.stringify({ createdAt, id }));
}
