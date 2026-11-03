// Preferências > Finanças applied to the finance screens: the company values of Contas a pagar / Contas a receber are
// read with the page schema (SQL 115) and checked before use. Until they load, or when they cannot be read, the Brufap
// defaults apply (every toggle off, Duplicata as the título de crédito).
import { useEffect, useState } from 'react';
import { parsePreferencesPage } from '../../../../packages/erp-domain/src/preferences/dto.mjs';
import { preferencesPagePath } from './preferences-request.ts';
import type { FinanceKind } from './real-finance-model.ts';

type PreferencesReader = { preferences?: (path: string, options?: { signal?: AbortSignal }) => Promise<unknown> };
export const FINANCE_PREFERENCE_PAGE: Readonly<Record<FinanceKind, string>> = { receivable: 'financas-receber', payable: 'financas-pagar' };
const aborted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';

export async function readFinancePreferences(reader: PreferencesReader, kind: FinanceKind, signal?: AbortSignal): Promise<Record<string, unknown>> {
  if (typeof reader.preferences !== 'function') return {};
  const pageId = FINANCE_PREFERENCE_PAGE[kind];
  const page = parsePreferencesPage(await reader.preferences(preferencesPagePath(pageId), signal ? { signal } : {}), pageId) as { items: { key: string; value: unknown }[] };
  return Object.fromEntries(page.items.map(item => [item.key, item.value]));
}
/** Values of the finance preference page of the kind for a session scope; an empty scope reads nothing. */
export function useFinancePreferences(reader: PreferencesReader, scope: string, kind: FinanceKind) {
  const key = scope ? `${scope}:${kind}` : '';
  const [state, setState] = useState<{ key: string; values: Record<string, unknown>; loaded: boolean }>({ key: '', values: {}, loaded: false });
  useEffect(() => {
    if (!key) return; const request = new AbortController();
    void readFinancePreferences(reader, kind, request.signal).then(values => { if (!request.signal.aborted) setState({ key, values, loaded: true }); })
      .catch(failure => { if (!request.signal.aborted && !aborted(failure)) setState({ key, values: {}, loaded: true }); });
    return () => request.abort();
  }, [key]);
  return state.key === key ? state : { key, values: {} as Record<string, unknown>, loaded: false };
}
