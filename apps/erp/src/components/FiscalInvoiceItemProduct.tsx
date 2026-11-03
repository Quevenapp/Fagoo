import { useEffect, useRef, useState } from 'react';
import { AccessError, type AccessController } from '../lib/real-access';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import type { ItemDraft } from '../lib/fiscal-invoice-form-model';
import { Modal } from './Modal';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const aborted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
const actorOf = (controller: AccessController) => controller.getSnapshot?.()?.membership?.user_id ?? null;
const roleOf = (controller: AccessController) => controller.getSnapshot?.()?.membership?.role ?? '';
/** Profiles that write the product cadastro (erp_catalog.allowed: administrador e estoque). */
export const PRODUCT_WRITER_ROLES = ['admin', 'estoque'];
const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const FIELDS = [['name', 'Nome', 200], ['code', 'Código', 100], ['unit', 'Unidade', 16], ['ncm', 'NCM', 8], ['gtin', 'GTIN/EAN', 14], ['cest', 'CEST', 7]] as const;
type Key = typeof FIELDS[number][0];
type Values = Record<Key, string>;
type Product = { id: string; version: number; name: string; values: Values };
type Command = { id: string; actor: string | null; path: string; method: 'POST' | 'PATCH'; body: Record<string, unknown>; uncertain: boolean };
const valid = (key: Key, value: string) => !value || (key === 'ncm' ? /^\d{8}$/.test(value) : key === 'gtin' ? /^(\d{8}|\d{12,14})$/.test(value) : key === 'cest' ? /^\d{7}$/.test(value) : true);
/** The item of the note as product values (what the note knows). */
export function itemProductValues(item: ItemDraft): Values {
  const gtin = text(item.gtin);
  return { name: text(item.description).slice(0, 200), code: text(item.code).slice(0, 100), unit: text(item.unit).slice(0, 16), ncm: /^\d{8}$/.test(text(item.ncm)) ? text(item.ncm) : '',
    gtin: /^(\d{8}|\d{12,14})$/.test(gtin) ? gtin : '', cest: /^\d{7}$/.test(text(item.cest)) ? text(item.cest) : '' };
}
const productOf = (value: unknown): Product => {
  const record = (value as { record?: Record<string, unknown> } | null)?.record;
  if (!record || typeof record.id !== 'string' || !UUID.test(record.id) || !Number.isInteger(record.version) || typeof record.name !== 'string') throw new AccessError(502);
  return { id: record.id, version: record.version as number, name: record.name, values: Object.fromEntries(FIELDS.map(([key]) => [key, text(record[key])])) as Values };
};

/**
 * Ícone "Atualizar ou criar produto a partir da nota" (Origin): cria o produto do item sem vínculo, com os dados da nota (e o
 * remetente como fornecedor padrão na nota de entrada), ou atualiza NCM, GTIN e CEST do produto ligado. Grava pelo cadastro de
 * produtos (POST/PATCH /v1/cadastros/products/…/completo), com command_id, versão esperada e "Conferir resultado".
 */
export default function FiscalInvoiceItemProduct({ controller, item, position, supplier, onCreated, onClose }: {
  controller: AccessController; item: ItemDraft; position: number; supplier: { id: string; direction: '0' | '1' } | null;
  onCreated: (product: { id: string; name: string }) => void; onClose: () => void;
}) {
  const productId = typeof item.product_id === 'string' && UUID.test(item.product_id) ? item.product_id : null;
  const fromNote = itemProductValues(item);
  const [values, setValues] = useState<Values>(fromNote), [current, setCurrent] = useState<Product | null>(null), [chosen, setChosen] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(Boolean(productId)), [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const command = useRef<Command | null>(null), life = useRef(new AbortController()), actor = useRef(actorOf(controller));
  useEffect(() => { const currentLife = life.current; return () => currentLife.abort(); }, []);
  // "Atualizar": the product as the cadastro has it now, with its version.
  useEffect(() => {
    if (!productId) return;
    const request = new AbortController();
    void controller.catalog(`/v1/cadastros/products/${productId}/completo`, { signal: AbortSignal.any([request.signal, life.current.signal]) }).then(value => {
      if (request.signal.aborted) return;
      const product = productOf(value); if (product.id !== productId) throw new AccessError(502);
      setCurrent(product); setChosen(Object.fromEntries((['ncm', 'gtin', 'cest'] as const).map(key => [key, Boolean(fromNote[key]) && fromNote[key] !== product.values[key]]))); setLoading(false);
    }).catch(problem => { if (request.signal.aborted || aborted(problem)) return; setLoading(false); setError(problem instanceof AccessError && problem.status === 404 ? 'O produto não está mais no cadastro.' : 'Não foi possível ler o produto do cadastro.'); });
    return () => request.abort();
  }, [controller, productId]);
  const writer = PRODUCT_WRITER_ROLES.includes(roleOf(controller));
  const changes = current ? Object.fromEntries((['ncm', 'gtin', 'cest'] as const).filter(key => chosen[key] && fromNote[key] && fromNote[key] !== current.values[key]).map(key => [key, fromNote[key]])) : {};
  const dirty = productId ? Object.keys(changes).length > 0 : JSON.stringify(values) !== JSON.stringify(fromNote);
  const guard = useUnsavedChanges(dirty || uncertain, busy);
  const send = async () => {
    const op = command.current; if (!op || busy) return;
    if (actorOf(controller) !== op.actor || !PRODUCT_WRITER_ROLES.includes(roleOf(controller))) { command.current = null; setUncertain(false); setError('A sessão ou o perfil mudou. Nada foi gravado.'); return; }
    setBusy(true); setError(''); setNotice('');
    try {
      const saved = productOf(await controller.catalog(op.path, { method: op.method, body: { ...op.body, command_id: op.id }, signal: life.current.signal }));
      if (life.current.signal.aborted) return;
      if (productId ? saved.id !== productId : false) throw new AccessError(502);
      command.current = null; setUncertain(false);
      if (productId) { setCurrent(saved); setChosen({}); setNotice('Produto atualizado com os dados da nota.'); }
      else onCreated({ id: saved.id, name: saved.name });
    } catch (problem) {
      if (life.current.signal.aborted || aborted(problem)) return;
      if (!op.uncertain && problem instanceof AccessError && [400, 403, 404, 409].includes(problem.status)) { command.current = null; setError(problem.status === 409 ? 'O produto mudou em outra tela. Feche e abra de novo para conferir.' : problem.status === 403 ? 'Seu perfil não cadastra produtos.' : 'O cadastro de produtos recusou os dados. Confira os campos.'); }
      else { op.uncertain = true; setUncertain(true); setError('Não foi possível confirmar a gravação. Use "Conferir resultado" para repetir o mesmo comando sem duplicar o produto.'); }
    } finally { if (!life.current.signal.aborted) setBusy(false); }
  };
  const save = () => {
    if (busy || command.current || !writer) return;
    if (productId) {
      if (!current || !Object.keys(changes).length) return;
      command.current = { id: crypto.randomUUID(), actor: actor.current, path: `/v1/cadastros/products/${productId}/completo`, method: 'PATCH', body: { expected_version: current.version, data: changes }, uncertain: false };
    } else {
      const bad = FIELDS.find(([key]) => !valid(key, values[key].trim()));
      if (!values.name.trim()) { setError('Informe o nome do produto.'); return; }
      if (bad) { setError(`Confira o campo ${bad[1]}.`); return; }
      const data: Record<string, unknown> = { kind: 'P', format: 'S', ...Object.fromEntries(FIELDS.map(([key]) => [key, values[key].trim()]).filter(([, value]) => value)) };
      // Nota de entrada: o remetente do cadastro vira o fornecedor padrão, com o código, a descrição e o preço do item (custo).
      if (supplier?.direction === '0' && UUID.test(supplier.id)) data.suppliers = [{ supplier_id: supplier.id, ...(text(item.code) ? { code: text(item.code).slice(0, 60) } : {}), description: values.name.trim().slice(0, 120),
        ...(/^\d{1,13}(\.\d{1,10})?$/.test(text(item.unit_price)) ? { cost_price: text(item.unit_price) } : {}), is_default: true }];
      command.current = { id: crypto.randomUUID(), actor: actor.current, path: '/v1/cadastros/products/completo', method: 'POST', body: { data }, uncertain: false };
    }
    void send();
  };
  const close = () => { if (!busy) guard.confirmLeave(onClose); };
  const locked = busy || Boolean(command.current) || !writer;
  const title = productId ? 'Atualizar produto a partir da nota' : 'Criar produto a partir da nota';
  return <Modal title={title} onClose={close} actions={<>
    {uncertain ? <button type="button" className="primary-button" disabled={busy} onClick={() => void send()}>{busy ? 'Conferindo…' : 'Conferir resultado'}</button>
      : <button type="button" className="primary-button" disabled={locked || loading || (productId ? !Object.keys(changes).length : false)} onClick={save}>{busy ? 'Salvando…' : productId ? 'Atualizar produto' : 'Salvar produto'}</button>}
    <button type="button" className="secondary-button" disabled={busy} onClick={close}>Fechar</button></>}>
    <p className="real-help">Item {position} da nota.{!writer ? ' Seu perfil não cadastra produtos: o cadastro de produtos é do administrador e do estoque.' : ''}</p>
    {productId ? loading ? <p role="status">Lendo o produto…</p> : current && <table className="data-table"><thead><tr><th>Campo</th><th>No cadastro</th><th>Na nota</th><th>Atualizar</th></tr></thead>
      <tbody>{(['ncm', 'gtin', 'cest'] as const).map(key => { const label = FIELDS.find(([k]) => k === key)![1], differs = Boolean(fromNote[key]) && fromNote[key] !== current.values[key];
        return <tr key={key}><td>{label}</td><td>{current.values[key] || '—'}</td><td>{fromNote[key] || '—'}</td>
          <td><input type="checkbox" aria-label={`Atualizar ${label}`} disabled={locked || !differs} checked={Boolean(chosen[key]) && differs} onChange={event => setChosen(c => ({ ...c, [key]: event.target.checked }))} /></td></tr>; })}</tbody></table>
      : <div className="document-grid">{FIELDS.map(([key, label, max]) => <div className="form-field" key={key}><label htmlFor={`item-product-${key}`}>{label}{key === 'name' ? '*' : ''}</label>
        <input id={`item-product-${key}`} maxLength={max} disabled={locked} value={values[key]} inputMode={['ncm', 'gtin', 'cest'].includes(key) ? 'numeric' : undefined}
          onChange={event => { const value = event.target.value; setValues(v => ({ ...v, [key]: ['ncm', 'gtin', 'cest'].includes(key) ? value.replace(/\D/g, '') : value })); }} /></div>)}</div>}
    {!productId && supplier?.direction === '0' && <p className="real-help">O remetente da nota entra como fornecedor padrão do produto, com o código e o preço do item como custo.</p>}
    {error && <p className="real-alert" role="alert">{error}</p>}{notice && <p className="real-success" role="status">{notice}</p>}
  </Modal>;
}
