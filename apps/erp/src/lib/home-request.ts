import { ORIGIN_MENU } from './origin-menu.ts';

// Client-side capture of /v1/inicio requests. Mirrors the worker allow-lists (workers/erp-api/src/home.mjs);
// the server and the database validate everything again.
export const HOME_PERIOD_KEYS = ['hoje', '7d', '30d', '3m', '6m', '12m', 'customizado'] as const;
export type HomePeriodKey = typeof HOME_PERIOD_KEYS[number];
export const HOME_MAX_PERIOD_DAYS = 366;
export const HOME_MAX_SHORTCUTS = 20;
export const HOME_PATH = '/v1/inicio';
export const HOME_SHORTCUTS_PATH = '/v1/inicio/atalhos';
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

/** Every real screen of the Origin menu (items and footers), in menu order, except the home itself. */
export function homeShortcutPaths(): string[] {
  const paths: string[] = [];
  for (const group of ORIGIN_MENU) for (const item of [...group.columns.flatMap(column => column.items), ...(group.footer ? [group.footer] : [])]) {
    const to = item.real?.to;
    if (to && to !== '/acesso' && !paths.includes(to)) paths.push(to);
  }
  return paths;
}
export function validHomeDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && value >= '1900-01-01' && value <= '2100-12-31'
    && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}
export const homeDayCount = (from: string, to: string) => (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000 + 1;
const EXTRA = /^[a-z_]{1,30}=[A-Za-z0-9_.:,-]{1,60}(?:&[a-z_]{1,30}=[A-Za-z0-9_.:,-]{1,60}){0,7}$/;
/** Migration 189: the menu screen a favorite opens (the screen itself, or the screen with more filters), as the worker and SQL. */
export function homeShortcutBase(link: unknown, paths = homeShortcutPaths()): string | null {
  if (typeof link !== 'string' || link.length > 200) return null;
  for (const path of [...paths].sort((a, b) => b.length - a.length)) {
    if (link === path) return path;
    if (!link.startsWith(path + (path.includes('?') ? '&' : '?'))) continue;
    const extra = link.slice(path.length + 1); if (!EXTRA.test(extra)) continue;
    const keys = extra.split('&').map(p => p.split('=')[0]), base = path.includes('?') ? path.split('?')[1]!.split('&').map(p => p.split('=')[0]) : [];
    if (new Set(keys).size === keys.length && !keys.some(k => base.includes(k))) return path;
  }
  return null;
}
export function validHomeShortcuts(value: unknown): value is string[] {
  const paths = homeShortcutPaths();
  return Array.isArray(value) && value.length <= HOME_MAX_SHORTCUTS && value.every(path => homeShortcutBase(path, paths) !== null) && new Set(value).size === value.length;
}
export const HOME_LABEL_MAX = 60;
export function validHomeLabels(value: unknown, shortcuts: readonly string[]): value is Record<string, string> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.keys(value as object).length <= HOME_MAX_SHORTCUTS
    && Object.entries(value as Record<string, unknown>).every(([link, label]) => shortcuts.includes(link) && typeof label === 'string' && [...label].length >= 1 && [...label].length <= HOME_LABEL_MAX
      && label === label.trim() && !/[\u0000-\u001f\u007f]/.test(label));
}
/** Throws on anything the worker would refuse; the error is never shown with request data. */
export function homePeriodParams(params: URLSearchParams): { key: HomePeriodKey; from: string | null; to: string | null } {
  for (const key of params.keys()) if (!['periodo', 'de', 'ate'].includes(key) || params.getAll(key).length !== 1) throw new Error('HOME_INVALID_QUERY');
  const key = params.get('periodo'), from = params.get('de'), to = params.get('ate');
  if (!HOME_PERIOD_KEYS.includes(key as HomePeriodKey)) throw new Error('HOME_INVALID_QUERY');
  if (key === 'customizado') {
    if (!validHomeDate(from) || !validHomeDate(to) || from > to || homeDayCount(from, to) > HOME_MAX_PERIOD_DAYS) throw new Error('HOME_INVALID_QUERY');
  } else if (from !== null || to !== null) throw new Error('HOME_INVALID_QUERY');
  return { key: key as HomePeriodKey, from, to };
}

type Options = { method?: 'GET' | 'POST' | 'PATCH'; body?: unknown; signal?: AbortSignal };
export function captureHomeRequest(path: string, options: Options = {}): { path: string; options: Options } {
  const method = options.method ?? 'GET';
  if (typeof path !== 'string' || path.includes('#')) throw new Error('HOME_INVALID_REQUEST');
  const [pathname, query, ...rest] = path.split('?');
  if (rest.length) throw new Error('HOME_INVALID_REQUEST');
  if (pathname === HOME_PATH) {
    if (method !== 'GET' || options.body !== undefined) throw new Error('HOME_INVALID_REQUEST');
    if (query !== undefined) homePeriodParams(new URLSearchParams(query));
    return { path, options: { signal: options.signal } };
  }
  if (pathname !== HOME_SHORTCUTS_PATH || query !== undefined) throw new Error('HOME_INVALID_REQUEST');
  if (method === 'GET') {
    if (options.body !== undefined) throw new Error('HOME_INVALID_REQUEST');
    return { path, options: { signal: options.signal } };
  }
  const body = options.body as Record<string, unknown> | null;
  const keys = body && typeof body === 'object' ? Object.keys(body) : [];
  if (method !== 'POST' || !body || typeof body !== 'object' || Array.isArray(body) || ![3, 4].includes(keys.length) || keys.some(key => !['command_id', 'expected_version', 'shortcuts', 'labels'].includes(key))
    || typeof body.command_id !== 'string' || !UUID.test(body.command_id) || !Number.isInteger(body.expected_version)
    || (body.expected_version as number) < 0 || (body.expected_version as number) >= 2147483647 || !validHomeShortcuts(body.shortcuts)
    || body.labels !== undefined && !validHomeLabels(body.labels, body.shortcuts as string[])) throw new Error('HOME_INVALID_REQUEST');
  const labels = body.labels as Record<string, string> | undefined;
  return { path, options: { method: 'POST', body: { command_id: body.command_id, expected_version: body.expected_version, shortcuts: [...body.shortcuts], ...(labels && Object.keys(labels).length ? { labels: { ...labels } } : {}) }, signal: options.signal } };
}
