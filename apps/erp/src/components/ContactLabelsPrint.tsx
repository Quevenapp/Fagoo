import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AccessController } from '../lib/real-access';
import { labelConfigValid, labelsPerPage, pageSize, type LabelConfig } from '../lib/reports-model';
import { LabelSvg } from './RealLabels';
import { contactRefusalText } from './contact-errors';
import { aborted, errorText } from './catalog-shared';
import './reports-labels.css';

// "Imprimir etiquetas" da listagem de contatos (Origin CL-19/CL-25, habilitado com seleção): os contatos selecionados
// com um modelo de etiqueta do tipo Contato de Preferências › Etiquetas customizadas (Padrão ou Customizadas), cópias de
// cada e a prévia em páginas; o botão Imprimir etiquetas abre a impressão do navegador. Nada é gravado.
type Template = { id: string; description: string; default: boolean; config: LabelConfig };
type Labels = { templates: Template[]; items: { id: string; values: Record<string, string | null> }[] };
const LABEL_KEYS = ['nome', 'fantasia', 'documento', 'endereco', 'bairro', 'cidade_uf', 'cep', 'telefone'];
/** The answer of GET /v1/cadastros/contatos/etiquetas for the ids sent, or null when it does not match them. */
export function contactLabels(value: unknown, ids: readonly string[]): Labels | null {
  const result = value as { scope?: unknown; templates?: unknown; items?: unknown } | null;
  if (!result || result.scope !== 'contact_labels' || !Array.isArray(result.templates) || !result.templates.length || !Array.isArray(result.items) || result.items.length !== ids.length) return null;
  const templates = result.templates as Template[], items = result.items as Labels['items'];
  if (templates.some(t => typeof t?.id !== 'string' || typeof t.description !== 'string' || typeof t.default !== 'boolean' || !labelConfigValid('contato', t.config))) return null;
  if (items.some((item, index) => item?.id !== ids[index] || !item.values || LABEL_KEYS.some(key => item.values[key] !== null && typeof item.values[key] !== 'string'))) return null;
  return { templates, items };
}

export function ContactLabelsPrint({ controller, ids, onClose }: { controller: Pick<AccessController, 'catalog' | 'getSnapshot'>; ids: readonly string[]; onClose: () => void }) {
  const [labels, setLabels] = useState<Labels | null>(null), [error, setError] = useState(''), [template, setTemplate] = useState(''), [copies, setCopies] = useState('1');
  const actor = useRef(controller.getSnapshot().membership?.user_id), onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const request = new AbortController();
    void controller.catalog(`/v1/cadastros/contatos/etiquetas?${new URLSearchParams({ ids: ids.join(',') })}`, { signal: request.signal }).then(value => {
      if (request.signal.aborted || controller.getSnapshot().membership?.user_id !== actor.current) return;
      const parsed = contactLabels(value, ids);
      if (!parsed) { setError('Não foi possível preparar as etiquetas. Tente novamente.'); return; }
      setLabels(parsed); setTemplate(parsed.templates[0]!.id);
    }).catch(failure => { if (!request.signal.aborted && !aborted(failure)) setError(contactRefusalText(failure) ?? errorText(failure)); });
    document.body.classList.add('labels-print-open');
    const keydown = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); onCloseRef.current(); } };
    document.addEventListener('keydown', keydown);
    return () => { request.abort(); document.removeEventListener('keydown', keydown); document.body.classList.remove('labels-print-open'); };
  }, [controller]);
  const chosen = labels?.templates.find(t => t.id === template) ?? null, count = Number(copies), copiesOk = /^\d{1,3}$/.test(copies) && count >= 1 && count <= 100;
  const items = chosen && copiesOk ? labels!.items.flatMap(item => Array.from({ length: count }, () => item)) : [];
  const per = chosen ? labelsPerPage(chosen.config) : { cols: 1, rows: 1, total: 1 }, [width, height] = chosen ? pageSize(chosen.config) : [210, 297];
  const pages = Array.from({ length: Math.ceil(items.length / per.total) }, (_, page) => items.slice(page * per.total, (page + 1) * per.total));
  return createPortal(<div className="labels-print-root" role="dialog" aria-modal="true" aria-labelledby="contact-labels-title">
    <header className="labels-print-controls"><h2 id="contact-labels-title">Imprimir etiquetas · {ids.length} {ids.length === 1 ? 'contato' : 'contatos'}</h2>
      <div>{labels && <><label className="form-field">Modelo de etiqueta<select id="contact-labels-template" value={template} onChange={event => setTemplate(event.target.value)}>
          {labels.templates.map(t => <option key={t.id} value={t.id}>{t.description}{t.default ? ' (Padrão)' : ''}</option>)}</select></label>
        <label className="form-field">Cópias de cada<input id="contact-labels-copies" inputMode="numeric" maxLength={3} value={copies} aria-invalid={!copiesOk || undefined} onChange={event => setCopies(event.target.value)} /></label></>}
        <button type="button" className="secondary-button" onClick={onClose}>Fechar</button>
        <button type="button" className="primary-button" disabled={!items.length} onClick={() => window.print()}>Imprimir etiquetas</button></div></header>
    {error && <p className="real-alert" role="alert">{error}</p>}
    {!labels && !error && <p role="status" className="real-help">Preparando as etiquetas…</p>}
    {labels && !copiesOk && <p className="real-alert" role="alert">Informe de 1 a 100 cópias de cada etiqueta.</p>}
    {labels && <p className="real-help">{items.length} etiqueta(s) em {pages.length} página(s) de {per.total}. Os modelos são mantidos em Preferências › Etiquetas customizadas.</p>}
    <div className="labels-print-scroll" tabIndex={0} aria-label="Etiquetas para impressão">{chosen && pages.map((list, page) => <div key={page} className="labels-print-page" style={{ width: `${width}mm`, height: `${height}mm`,
      paddingLeft: `${chosen.config.page.margin_left}mm`, paddingTop: `${chosen.config.page.margin_top}mm`, gridTemplateColumns: `repeat(${per.cols}, ${chosen.config.label.width}mm)`, gridAutoRows: `${chosen.config.label.height}mm`,
      columnGap: `${chosen.config.label.columns_gap}mm`, rowGap: `${chosen.config.label.rows_gap}mm` }}>
      {list.map((item, index) => <LabelSvg key={`${item.id}:${index}`} type="contato" config={chosen.config} values={item.values} />)}</div>)}</div>
  </div>, document.body);
}
