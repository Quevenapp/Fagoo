import { STATES, type DocumentKind } from '../lib/real-documents-model';
import { readableText, statusPresentation } from '../lib/document-status-colors';
import type { RowSituation } from '../lib/document-situations-model';
import { badgeClass } from '../lib/origin-list';
import { Icon } from './Icon';
import './document-status.css';

/**
 * Situação as Origin shows it: colored badge (pedidos), colored dot with the name as title (OS), neutral badge (propostas).
 * A custom situação of the Gerenciador de transições (202610200163) uses its own name and color; the default ones keep the
 * Origin colors below.
 */
export default function DocumentStatusBadge({ kind, status, situation = null }: { kind: DocumentKind; status: string; situation?: RowSituation | null }) {
  if (situation && !situation.default) {
    if (kind === 'service_orders') return <span className="document-status-dot" title={situation.name}><span className="document-status-dot-mark" style={{ color: situation.color }} aria-hidden="true"><Icon name="circle" size={11} /></span><span className="sr-only">{situation.name}</span></span>;
    return <span className="status-badge document-status-color" title={`${situation.name} (baseada em ${STATES[kind]?.[status] ?? status})`} style={{ backgroundColor: situation.color, color: readableText(situation.color) }}>{situation.name}</span>;
  }
  const label = STATES[kind]?.[status] ?? status;
  const look = statusPresentation(kind, status);
  if (look.mode === 'dot') return <span className="document-status-dot" title={label}><span className="document-status-dot-mark" style={{ color: look.color }} aria-hidden="true"><Icon name="circle" size={11} /></span><span className="sr-only">{label}</span></span>;
  if (look.mode === 'badge') return <span className="status-badge document-status-color" style={{ backgroundColor: look.background, color: look.text }}>{label}</span>;
  return <span className={look.mode === 'neutral' ? 'status-badge status-neutral' : badgeClass(label)}>{label}</span>;
}
