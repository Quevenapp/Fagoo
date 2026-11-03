import { useState, type ReactNode } from 'react';
import type { SectionMode } from '../lib/document-preferences';

/**
 * Preferências › Vendas "Exibe campos relativos …" (Sim | Opcional | Não) around one editor block: Opcional starts collapsed
 * behind a "Mostrar …" button, Não hides the block while it has no value. A block with values starts open.
 */
export default function DocumentOptionalSection({ mode, filled, label, children }: { mode: SectionMode; filled: boolean; label: string; children: ReactNode }) {
  const [open, setOpen] = useState(mode === 'sim' || filled);
  if (mode === 'sim') return <>{children}</>;
  if (mode === 'nao' && !filled) return null;
  return <><button type="button" className="text-button document-section-toggle" aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? `Ocultar ${label}` : `Mostrar ${label}`}</button>{open && children}</>;
}
