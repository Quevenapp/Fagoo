// Contas em aberto do contato (SQL 172): the checked answer of GET /v1/financeiro/contato-em-aberto.
import type { FinanceKind } from './real-finance-model.ts';
export type OpenTitles = { total: number; balance_cents: string; overdue: number; overdue_cents: string; items: { id: string; description: string; due_on: string; amount_cents: string; balance_cents: string; overdue: boolean }[] };
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/, CENTS = /^\d{1,30}$/;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export function openTitles(value: unknown, contact: string, kind: FinanceKind): OpenTitles {
  const fail: () => never = () => { throw new Error('Não foi possível conferir as contas em aberto do contato.'); };
  if (!object(value) || value.entity !== 'contact_open_titles' || value.data_mode !== 'erp_native' || value.contact_id !== contact || value.kind !== kind || !Number.isSafeInteger(value.total) || !Number.isSafeInteger(value.overdue)
    || typeof value.balance_cents !== 'string' || !CENTS.test(value.balance_cents) || typeof value.overdue_cents !== 'string' || !CENTS.test(value.overdue_cents) || !Array.isArray(value.items) || value.items.length > Math.min(50, value.total as number)) fail();
  for (const item of value.items as unknown[]) if (!object(item) || typeof item.id !== 'string' || !UUID.test(item.id) || typeof item.description !== 'string' || typeof item.due_on !== 'string' || typeof item.balance_cents !== 'string' || !CENTS.test(item.balance_cents) || typeof item.overdue !== 'boolean') fail();
  return value as unknown as OpenTitles;
}
