import { useState } from 'react';
import { Icon } from './Icon';
import './list-columns-panel.css';

/**
 * Painel lateral "Informações visíveis / Colunas customizadas" do Origin (CL-13), reutilizável por qualquer listagem: "Selecione
 * abaixo quais colunas deseja que estejam visíveis na listagem", card "Configurações por usuário" com o nome do usuário logado
 * (quando a listagem o conhece), "Todos", colunas com alça de arrastar (ou os botões ↑ ↓ pelo teclado) e liga/desliga, uma
 * coluna fixa e Cancelar / Aplicar. Nada é gravado até Aplicar; a listagem grava pelo seu armazenamento por usuário.
 */
export function ListColumnsPanel({ columns, selected, fixed, busy = false, error = '', userName = null, note = '', onReset, onCancel, onApply }: {
  columns: readonly { id: string; label: string }[]; selected: readonly string[]; fixed?: string; busy?: boolean; error?: string;
  /** Name (or e-mail) of the signed-in user for the "Configurações por usuário" card; without it the card says "o seu usuário". */
  userName?: string | null;
  /** Extra line of the help text, e.g. a column the list always shows outside this panel ("Descrição fica sempre visível."). */
  note?: string;
  /** "Restaurar listagem padrão" (Brufap): returns to the columns of the screen. Omitted, the button is not shown. */
  onReset?: () => void;
  onCancel: () => void; onApply: (columns: string[]) => void;
}) {
  const [order, setOrder] = useState<string[]>(() => [...selected.filter(id => columns.some(c => c.id === id)), ...columns.map(c => c.id).filter(id => !selected.includes(id))]);
  const [active, setActive] = useState<Set<string>>(() => new Set([...selected, ...(fixed ? [fixed] : [])]));
  const [dragging, setDragging] = useState<number | null>(null);
  const label = (id: string) => columns.find(c => c.id === id)?.label ?? id;
  const move = (from: number, to: number) => setOrder(list => { if (to < 0 || to >= list.length || from === to) return list; const next = [...list]; const [item] = next.splice(from, 1); next.splice(to, 0, item!); return next; });
  const toggle = (id: string, on: boolean) => { if (id === fixed) return; setActive(set => { const next = new Set(set); if (on) next.add(id); else next.delete(id); return next; }); };
  const setAll = (on: boolean) => setActive(new Set(on ? order : fixed ? [fixed] : []));
  const chosen = order.filter(id => active.has(id)), all = order.length > 0 && order.every(id => active.has(id));
  const who = userName?.trim() ? `o usuário ${userName.trim()}` : 'o seu usuário';
  return <div className="list-columns-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onCancel(); }}>
    <aside className="list-columns-panel" role="dialog" aria-modal="true" aria-labelledby="list-columns-title" onKeyDown={event => { if (event.key === 'Escape' && !busy) { event.preventDefault(); onCancel(); } }}>
      <header><h2 id="list-columns-title">Informações visíveis</h2><button type="button" className="icon-button" aria-label="Fechar" disabled={busy} onClick={onCancel}><Icon name="xmark" size={14} /></button></header>
      <h3>Colunas customizadas</h3>
      <p className="real-help">Selecione abaixo quais colunas deseja que estejam visíveis na listagem</p>
      <p className="list-columns-card" role="note"><Icon name="user" size={12} /><span><strong>Configurações por usuário</strong> Essa configuração só aparecerá para {who}.</span></p>
      <p className="real-help">Arraste pela alça, ou use as setas, para mudar a ordem. {fixed ? `${label(fixed)} fica sempre visível.` : ''}{note ? ` ${note}` : ''}</p>
      {error && <p className="real-alert" role="alert">{error}</p>}
      <div className="list-columns-all"><span className="list-columns-label">Todos</span>
        <label className="list-columns-toggle"><input type="checkbox" role="switch" id="list-column-all" aria-label="Mostrar todas as colunas" checked={all} disabled={busy || !order.length} onChange={event => setAll(event.target.checked)} /><span aria-hidden="true" /></label></div>
      <ol className="list-columns-items">{order.map((id, index) => <li key={id} draggable={!busy} className={dragging === index ? 'is-dragging' : undefined}
        onDragStart={() => setDragging(index)} onDragOver={event => event.preventDefault()} onDrop={() => { if (dragging !== null) move(dragging, index); setDragging(null); }} onDragEnd={() => setDragging(null)}>
        <span className="list-columns-grip" aria-hidden="true"><Icon name="grip" size={11} /></span>
        <span className="list-columns-label">{label(id)}</span>
        <span className="list-columns-move"><button type="button" aria-label={`Mover ${label(id)} para cima`} disabled={busy || index === 0} onClick={() => move(index, index - 1)}><Icon name="arrow-up" size={9} /></button>
          <button type="button" aria-label={`Mover ${label(id)} para baixo`} disabled={busy || index === order.length - 1} onClick={() => move(index, index + 1)}><Icon name="arrow-down" size={9} /></button></span>
        <label className="list-columns-toggle"><input type="checkbox" role="switch" id={`list-column-${id}`} aria-label={`Mostrar ${label(id)}`} checked={active.has(id)} disabled={busy || id === fixed} onChange={event => toggle(id, event.target.checked)} /><span aria-hidden="true" /></label>
      </li>)}</ol>
      <footer>{onReset && <button type="button" className="text-button list-columns-reset" disabled={busy} onClick={onReset}>Restaurar listagem padrão</button>}
        <button type="button" className="secondary-button" disabled={busy} onClick={onCancel}>Cancelar</button><button type="button" className="primary-button" disabled={busy || !chosen.length} onClick={() => onApply(chosen)}>{busy ? 'Aplicando…' : 'Aplicar'}</button></footer>
    </aside>
  </div>;
}
