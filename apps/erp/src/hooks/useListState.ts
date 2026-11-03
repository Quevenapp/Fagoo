import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';

const PREFIX = 'brufap.erp.demo.list.';

export function moduleListHref(moduleId: string) {
  try {
    const query = sessionStorage.getItem(PREFIX + moduleId) || '';
    return `/${moduleId}${query ? `?${query}` : ''}`;
  } catch { return `/${moduleId}`; }
}

export function useListState(moduleId: string) {
  const [params, setParams] = useSearchParams();
  const serialized = params.toString();
  useEffect(() => {
    try { sessionStorage.setItem(PREFIX + moduleId, serialized); } catch { /* URL remains authoritative. */ }
  }, [moduleId, serialized]);

  const update = (changes: Record<string, string>, resetPage = true) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes)) value ? next.set(key, value) : next.delete(key);
    if (resetPage) next.delete('page');
    setParams(next, { replace: true });
  };
  return { params, update, clear: () => setParams({}, { replace: true }), restore: (query: string) => setParams(new URLSearchParams(query), { replace: true }) };
}
