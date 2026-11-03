import { useEffect, useState } from 'react';
import type { NativeRequestOptions } from '../lib/real-access';
import { requiredFields } from '../lib/contact-form-model';

// Preferências › Configurações de clientes e fornecedores › "Campos obrigatórios" for the screens outside the contact
// form (Contato rápido, contatos onda C). Without the preferences port or on any failure nothing is marked: the server
// still refuses a missing field and names it.
type Port = { preferences?: (path: string, options?: NativeRequestOptions) => Promise<unknown>; getSnapshot?: () => { membership?: { user_id?: string } | null } };
export function useContactRequiredFields(controller: Port): string[] {
  const [required, setRequired] = useState<string[]>([]);
  useEffect(() => {
    if (typeof controller.preferences !== 'function') return;
    const request = new AbortController(), actor = controller.getSnapshot?.().membership?.user_id;
    void Promise.resolve().then(() => controller.preferences!('/v1/preferencias/cadastros-contatos', { signal: request.signal })).then(value => {
      if (request.signal.aborted || controller.getSnapshot?.().membership?.user_id !== actor) return;
      const option = ((value as { items?: { key?: unknown; value?: unknown }[] } | null)?.items ?? []).find(item => item?.key === 'contatos.campos_obrigatorios')?.value;
      setRequired(Array.isArray(option) ? requiredFields(option.filter((entry): entry is string => typeof entry === 'string')) : []);
    }).catch(() => undefined);
    return () => request.abort();
  }, [controller]);
  return required;
}
