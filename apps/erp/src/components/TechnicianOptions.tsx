import { useEffect, useState } from 'react';
import type { AccessController } from '../lib/real-access';
import { contactOptionsPath } from '../lib/contact-picker-model';

/**
 * Leva H (VND-248, 393): suggestions of the Técnico of the OS, from the contacts with the type Técnico (Cadastros › Clientes e
 * fornecedores › Tipos de contato). The OS keeps the name typed or picked; a technician needs no login.
 */
export function TechnicianOptions({ controller, id }: { controller: Pick<AccessController, 'catalog'>; id: string }) {
  const [names, setNames] = useState<string[]>([]);
  useEffect(() => {
    const request = new AbortController();
    void controller.catalog(contactOptionsPath({ role: 'technician', limit: 50 }), { signal: request.signal })
      .then(value => { if (request.signal.aborted) return; const items = (value as { items?: { name?: unknown }[] })?.items;
        setNames(Array.isArray(items) ? [...new Set(items.map(item => item?.name).filter((name): name is string => typeof name === 'string' && name.length > 0 && name.length <= 200))] : []); })
      .catch(() => { /* Without suggestions the field still takes the name typed. */ });
    return () => request.abort();
  }, [controller]);
  return <datalist id={id}>{names.map(name => <option key={name} value={name} />)}</datalist>;
}
