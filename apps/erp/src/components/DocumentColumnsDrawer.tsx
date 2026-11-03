import { useState } from 'react';
import { COLUMN_HELP, COLUMN_LABELS, moveColumn } from '../lib/document-list-view-model';
import { Modal } from './Modal';
import { Icon } from './Icon';

/**
 * Origin "Informações visíveis" (listagem customizada): toggle the optional columns, drag them (or use the arrows) to
 * change the order, respect the column limit and apply. Nothing is saved until Aplicar. An unknown outcome freezes the
 * choice and offers “Conferir resultado” here, because the list behind the drawer cannot be reached.
 */
export default function DocumentColumnsDrawer({ available, selected, limit, busy, uncertain = false, error = '', onRetry, onCancel, onApply }: { available: readonly string[]; selected: readonly string[]; limit: number; busy: boolean; uncertain?: boolean; error?: string; onRetry?: () => void; onCancel: () => void; onApply: (columns: string[]) => void }) {
  const [order, setOrder] = useState<string[]>(() => [...selected, ...available.filter(column => !selected.includes(column))]);
  const [active, setActive] = useState<Set<string>>(() => new Set(selected));
  const [dragging, setDragging] = useState<number | null>(null), [message, setMessage] = useState('');
  const toggle = (column: string, checked: boolean) => {
    if (checked && !active.has(column) && active.size >= limit) { setMessage(`Você não pode ativar mais do que ${limit} colunas`); return; }
    setMessage(''); setActive(previous => { const next = new Set(previous); if (checked) next.add(column); else next.delete(column); return next; });
  };
  const columns = order.filter(column => active.has(column)), frozen = busy || uncertain;
  return <Modal title="Informações visíveis" onClose={() => { if (!busy) onCancel(); }} actions={<><button type="button" className="secondary-button" disabled={busy} onClick={onCancel}>Cancelar</button>{uncertain && onRetry ? <button type="button" className="primary-button" disabled={busy} onClick={onRetry}>{busy ? 'Conferindo…' : 'Conferir resultado'}</button> : <button type="button" className="primary-button" disabled={frozen || !columns.length} onClick={() => onApply(columns)}>{busy ? 'Aplicando…' : 'Aplicar'}</button>}</>}>
    <div className="documents-columns">
      <h2>Colunas customizadas</h2>
      <p>Selecione abaixo quais colunas deseja que estejam visíveis na listagem</p>
      <p className="real-notice"><strong>Configurações por usuário</strong> — Essa configuração só aparecerá para o seu usuário.</p>
      <p className="real-help">Clique e arraste para mudar a ordem das colunas. Número e Situação ficam sempre visíveis.</p>
      {message && <p className="real-alert" role="alert">{message}</p>}
      {error && <p className="real-alert" role="alert">{error}</p>}
      <ol className="documents-columns-list">{order.map((column, index) => <li key={column} draggable={!frozen} onDragStart={() => { if (!frozen) setDragging(index); }} onDragOver={event => event.preventDefault()} onDrop={() => { if (dragging !== null && !frozen) setOrder(previous => moveColumn(previous, dragging, index)); setDragging(null); }}>
        <Icon name="grip-vertical" size={11} />
        <label htmlFor={`documents-column-${column}`}><input id={`documents-column-${column}`} type="checkbox" checked={active.has(column)} disabled={frozen} onChange={event => toggle(column, event.target.checked)} />{COLUMN_LABELS[column] ?? column}</label>
        {COLUMN_HELP[column] && <small>{COLUMN_HELP[column]}</small>}
        <span className="documents-columns-move"><button type="button" aria-label={`Mover ${COLUMN_LABELS[column]} para cima`} disabled={frozen || index === 0} onClick={() => setOrder(previous => moveColumn(previous, index, index - 1))}>↑</button><button type="button" aria-label={`Mover ${COLUMN_LABELS[column]} para baixo`} disabled={frozen || index === order.length - 1} onClick={() => setOrder(previous => moveColumn(previous, index, index + 1))}>↓</button></span>
      </li>)}</ol>
    </div>
  </Modal>;
}
