import { useState } from 'react';
import { decimalMoney } from '../lib/real-access';
import type { InvoiceItemInput, NatureSummary } from '../../../../packages/erp-domain/src/fiscal-invoice-contract.mjs';
import { ALL_TABS, AUTO_FIELDS, itemTabs, type FieldDef, type ItemDraft, type ItemGroup, type OptionalTabs, type Values } from '../lib/fiscal-invoice-form-model';
import { Modal } from './Modal';

/**
 * Modal de edição do item (Origin #form_edicao_item): abas Dados, ICMS (Geral, ST, ST retenção, Partilha), IPI, PIS/COFINS,
 * Importação, Exportação, Combustível, Medicamento, Outros, Estoque, Retenções, Armamento e Veículo. Combustível, Retenções,
 * Armamento e Veículo seguem as preferências da NF-e (`show`). Com o cálculo automático ligado, os valores calculados aparecem
 * em leitura; "Salvar item" só altera o rascunho da nota.
 */
export default function FiscalInvoiceItemDialog({ item, computed, position, crt, direction, natures, readOnly, auto, totals, show = ALL_TABS, itemDiscount = false, onSave, onCancel }: {
  item: ItemDraft; computed: InvoiceItemInput | null; position: number; crt: string; direction: '0' | '1'; natures: NatureSummary[]; readOnly: boolean; auto: boolean;
  totals: { total: string | null; freight: string | null; discount: string | null } | null; show?: OptionalTabs; itemDiscount?: boolean; onSave: (item: ItemDraft) => void; onCancel: () => void;
}) {
  const [draft, setDraft] = useState<ItemDraft>(() => structuredClone(item));
  const tabs = itemTabs(crt, direction, show);
  const [tab, setTab] = useState(tabs[0]!.id);
  const current = tabs.find(t => t.id === tab) ?? tabs[0]!;
  const valueOf = (group: ItemGroup | null, key: string, source: ItemDraft | InvoiceItemInput) => group ? (source[group] as Values | undefined)?.[key] : source[key];
  const isAuto = (group: ItemGroup | null, key: string) => auto && Boolean(computed) && group !== null && (AUTO_FIELDS[group] ?? []).includes(key);
  const setValue = (group: ItemGroup | null, key: string, value: string | boolean) => {
    if (readOnly) return;
    setDraft(d => {
      if (!group) return { ...d, [key]: value };
      const next = { ...((d[group] as Values | undefined) ?? {}), [key]: value };
      if (value === '' || value === false) delete next[key];
      return { ...d, [group]: next };
    });
  };
  const control = (group: ItemGroup | null, def: FieldDef) => {
    const id = `fiscal-item-${group ?? 'item'}-${def.key}`, autoValue = isAuto(group, def.key);
    const raw = autoValue ? valueOf(group, def.key, computed!) : valueOf(group, def.key, draft);
    const disabled = readOnly || autoValue;
    if (def.kind === 'check') return <div className="form-field" key={id}><label htmlFor={id}><input id={id} type="checkbox" disabled={disabled} checked={raw === true} onChange={event => setValue(group, def.key, event.target.checked)} /> {def.label}</label></div>;
    const value = typeof raw === 'string' ? raw : '';
    return <div className="form-field" key={id}><label htmlFor={id}>{def.label}</label>
      {def.kind === 'select' ? <select id={id} disabled={disabled} value={value} onChange={event => setValue(group, def.key, event.target.value)}><option value="">Selecione</option>{def.options!.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        : def.kind === 'textarea' ? <textarea id={id} rows={2} maxLength={2000} disabled={disabled} value={value} onChange={event => setValue(group, def.key, event.target.value)} />
          : <input id={id} disabled={disabled} inputMode={def.kind === 'decimal' ? 'decimal' : undefined} placeholder={def.placeholder} value={value} onChange={event => setValue(group, def.key, event.target.value)} />}
      {autoValue && <small className="real-help">Calculado</small>}</div>;
  };
  const kind = String(draft.kind ?? 'P');
  return <Modal title={`Item ${position}`} onClose={onCancel} actions={<><button type="button" className="secondary-button" onClick={onCancel}>Cancelar</button>
    <button type="button" className="primary-button" disabled={readOnly} onClick={() => onSave(draft)}>Salvar item</button></>}>
    <div className="fiscal-item-dialog">
      <div className="document-grid">
        <div className="form-field fiscal-wide"><label htmlFor="fiscal-item-description">Descrição</label><input id="fiscal-item-description" maxLength={120} disabled={readOnly} value={String(draft.description ?? '')} onChange={event => setValue(null, 'description', event.target.value)} /></div>
        <div className="form-field"><label htmlFor="fiscal-item-code">Código</label><input id="fiscal-item-code" maxLength={60} disabled={readOnly} value={String(draft.code ?? '')} onChange={event => setValue(null, 'code', event.target.value)} /></div>
        <div className="form-field"><label htmlFor="fiscal-item-kind">Tipo</label><select id="fiscal-item-kind" disabled={readOnly} value={kind} onChange={event => setValue(null, 'kind', event.target.value)}><option value="P">Produto</option><option value="S" disabled title="Itens de serviço (ISSQN) ainda não são calculados no FAGOO.">Serviço</option></select></div>
      </div>
      <nav className="origin-list-tabs fiscal-item-tabs" role="tablist" aria-label="Tributação do item">{tabs.map(t => <button type="button" role="tab" key={t.id} aria-selected={t.id === current.id} onClick={() => setTab(t.id)}>{t.label}</button>)}</nav>
      {current.id === 'dados' && <dl className="fiscal-totals"><div className="native-list-stat"><dt>Valor Total</dt><dd>{totals?.total ? decimalMoney(totals.total) : '—'}</dd></div>
        <div className="native-list-stat"><dt>Valor Frete</dt><dd>{totals?.freight ? decimalMoney(totals.freight) : '—'}</dd></div>{!itemDiscount && <div className="native-list-stat"><dt>Valor Desconto</dt><dd>{totals?.discount ? decimalMoney(totals.discount) : '—'}</dd></div>}</dl>}
      {/* "Informar desconto individualmente nos itens": the discount of this item (vDesc); the note discount is the sum. */}
      {current.id === 'dados' && itemDiscount && <div className="form-field"><label htmlFor="fiscal-item-discount">Valor Desconto</label><input id="fiscal-item-discount" inputMode="decimal" maxLength={20} placeholder="0,00" disabled={readOnly}
        value={String(draft.discount ?? '')} onChange={event => setValue(null, 'discount', event.target.value)} /></div>}
      {current.id === 'dados' && <div className="form-field"><label htmlFor="fiscal-item-nature">Natureza da Operacao</label><select id="fiscal-item-nature" disabled={readOnly} value={String(draft.nature_id ?? '')} onChange={event => setValue(null, 'nature_id', event.target.value)}>
        <option value="">A mesma da nota</option>{natures.map(n => <option key={n.id} value={n.id}>{n.description}</option>)}</select></div>}
      {current.sections.map((section, index) => <fieldset className="fiscal-group" key={section.title ?? index}>{section.title && <legend>{section.title}</legend>}<div className="document-grid">{section.fields.map(def => control(current.group, def))}</div></fieldset>)}
      {auto && current.group && <p className="real-help">Com o cálculo automático ligado, base e valores calculados aparecem em leitura. Desligue o cálculo na aba Cálculo de imposto para digitar os valores.</p>}
    </div>
  </Modal>;
}
