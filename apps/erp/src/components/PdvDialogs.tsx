import { useEffect, useId, useState, type ReactNode } from 'react';
import type { AccessController } from '../lib/real-access';
import { useFinanceCommand, type FinanceCommand } from '../lib/finance-command';
import { useUnsavedForm } from '../hooks/useUnsavedChanges';
import { decimal, format } from '../../../../packages/erp-domain/src/index.mjs';
import { money, moneyCents, pdvFailure, pdvReturnResult, pdvSale, pdvSummary, quantityInput, quantityText, type Named, type PdvContext, type PdvReturnResult, type PdvSale, type PdvSession, type PdvSummary } from '../lib/pdv-model';
import { PIX_KEY_TYPES, pixKey, pixText, type PixKeyType } from '../lib/pix-static';
import { PDV_SHORTCUTS, shortcutHint } from '../lib/pdv-shortcuts';
import { CatalogPicker } from './DocumentCatalogPicker';
import { Modal } from './Modal';
import { PdvQr } from './PdvReceiptPrint';

export type Send = (command: FinanceCommand) => Promise<unknown>;
type Controller = Pick<AccessController, 'finance' | 'pos' | 'catalog' | 'stockPositions' | 'getSnapshot'>;
function Field({ label, children }: { label: string; children: (id: string) => ReactNode }) { const id = useId(); return <div className="form-field"><label htmlFor={id}>{label}</label>{children(id)}</div>; }
const actions = (busy: boolean, uncertain: boolean, label: string, onCancel: () => void, onOk: () => void, disabled = false) => <>
  <button type="button" className="secondary-button" disabled={busy || uncertain} onClick={onCancel}>Cancelar</button>
  <button type="button" className="primary-button" disabled={busy || disabled} onClick={onOk}>{busy ? 'Aguarde…' : uncertain ? 'Conferir resultado' : label}</button></>;

/** Origin "Selecione uma loja" ao entrar na Frente de caixa: a loja é a conta financeira do tipo Caixa; com "Utilizar controle de
 * caixa", o caixa da loja é aberto com o Troco (Controle de caixa do financeiro) ou o caixa já aberto é usado. */
export function PdvStoreDialog({ context, current, sendFinance, mayWrite, onSelect, onCancel }: { context: PdvContext; current: string | null; sendFinance: Send; mayWrite: () => boolean;
  onSelect: (store: Named, session: PdvSession | null) => void; onCancel: () => void }) {
  const [values, setValues] = useState({ store: current ?? context.stores[0]?.id ?? '', change: '' });
  const command = useFinanceCommand(sendFinance, mayWrite, pdvFailure), guard = useUnsavedForm(values, command.locked);
  const store = context.stores.find(item => item.id === values.store) ?? null, session = context.cash_sessions.find(item => item.account_id === values.store) ?? null;
  const control = context.settings.cash_control, canOpen = context.effects.cash && !session;
  const ok = () => {
    if (!store) return;
    if (session || (!control && !context.effects.cash)) { onSelect(store, session); return; }
    if (!control && !values.change.trim()) { onSelect(store, null); return; }
    if (!canOpen) return;
    void command.run(() => ({ id: crypto.randomUUID(), path: '/v1/financeiro/actions/session_open', data: { account_id: store.id, change_cents: moneyCents(values.change || '0') } }), value => {
      const record = (value as { record?: { id?: string; account_id?: string; operator_id?: string; operator_name?: string; version?: number; opened_at?: string; opened_on?: string; change_cents?: string } })?.record;
      if (!record || record.account_id !== store.id || typeof record.id !== 'string') return;
      onSelect(store, { id: record.id, account_id: store.id, account_name: store.name, operator_id: record.operator_id ?? '', operator_name: record.operator_name ?? '', opened_at: record.opened_at ?? '', opened_on: record.opened_on ?? context.today, change_cents: record.change_cents ?? '0', version: record.version ?? 1, own: true });
    });
  };
  return <Modal title="Selecione uma loja" onClose={() => { if (!command.busy && !command.uncertain) guard.confirmLeave(onCancel); }}
    actions={actions(command.busy, command.uncertain, 'Ok', () => guard.confirmLeave(onCancel), ok, !store || (control && !session && !canOpen))}>
    {session && <p className="pdv-alert" role="status"><strong>Caixa aberto</strong> O caixa para a loja {session.account_name} já está aberto. Clique em OK para prosseguir.</p>}
    <fieldset className="finance-drawer-fields" disabled={command.locked}><legend className="real-sr-only">Loja</legend>
      <Field label="Selecione a loja">{id => <select id={id} value={values.store} onChange={event => { const value = event.target.value; setValues(previous => ({ ...previous, store: value })); }}>
        {!context.stores.length && <option value="">Cadastre uma conta financeira do tipo Caixa</option>}{context.stores.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>}</Field>
      <Field label="Selecione a unidade de negócio">{id => <select id={id} disabled title="O FAGOO não tem unidades de negócio (multiempresa fica fora do escopo)."><option>Nenhuma unidade de negócio</option></select>}</Field>
      {!session && context.effects.cash && <Field label="Troco">{id => <input id={id} inputMode="decimal" placeholder="0,00" maxLength={17} title="Valor de abertura do caixa." value={values.change} onChange={event => { const change = event.target.value; setValues(previous => ({ ...previous, change })); }} />}</Field>}
      {!session && context.effects.cash && <p className="real-help">Valor de abertura do caixa.{control ? '' : ' Deixe em branco para vender sem abrir o caixa (o controle de caixa está desligado).'}</p>}
      {!session && control && !context.effects.cash && <p className="real-alert" role="alert">O caixa desta loja não está aberto. Peça a um usuário do financeiro ou ao administrador para abrir o caixa.</p>}
    </fieldset>{command.error && <p className="real-alert" role="alert">{command.error}</p>}
  </Modal>;
}

type SessionRecord = { id: string; version: number; change_cents: string; supply_cents: string; withdrawal_cents: string; account_name: string; operator_name: string };
const sessionRecord = (value: unknown): SessionRecord => { const record = (value as { record?: SessionRecord })?.record; if (!record || typeof record.version !== 'number') throw new Error('PDV_SESSION_INVALID'); return record; };
/** Operações › Sangria / Suprimento: saída ou entrada de dinheiro no caixa aberto (lançamento da conta do caixa). */
export function PdvMoveDialog({ controller, session, move, sendFinance, mayWrite, onDone, onClose }: { controller: Controller; session: PdvSession; move: 'withdrawal' | 'supply'; sendFinance: Send; mayWrite: () => boolean;
  onDone: (amount: string, note: string | null) => void; onClose: () => void }) {
  const [values, setValues] = useState({ amount: '', note: '' }), [record, setRecord] = useState<SessionRecord | null>(null), [error, setError] = useState('');
  const command = useFinanceCommand(sendFinance, mayWrite, pdvFailure), guard = useUnsavedForm(values, command.locked), title = move === 'supply' ? 'Suprimento' : 'Sangria';
  useEffect(() => { const request = new AbortController(); void controller.finance(`/v1/financeiro/controle-caixa/${session.id}`, { signal: request.signal }).then(value => { if (!request.signal.aborted) setRecord(sessionRecord(value)); })
    .catch(failure => { if (!request.signal.aborted) setError(pdvFailure(failure)); }); return () => request.abort(); }, [controller, session.id]);
  const save = () => void command.run(() => { if (!record) throw new Error('Aguarde a leitura do caixa.'); const amount = moneyCents(values.amount); if (amount === '0') throw new Error('Informe um valor maior que zero.');
    return { id: crypto.randomUUID(), path: '/v1/financeiro/actions/session_move', data: { id: session.id, expected_version: record.version, kind: move, amount_cents: amount, note: values.note.trim() || null } }; },
  value => { sessionRecord(value); onDone(moneyCents(values.amount), values.note.trim() || null); });
  return <Modal title={title} onClose={() => { if (!command.busy && !command.uncertain) guard.confirmLeave(onClose); }} actions={actions(command.busy, command.uncertain, 'Salvar', () => guard.confirmLeave(onClose), save, !record)}>
    <p className="real-help">{move === 'supply' ? 'Entrada' : 'Saída'} de dinheiro em {session.account_name}, hoje, como lançamento de Caixas e bancos.</p>
    <fieldset className="finance-drawer-fields" disabled={command.locked}><legend className="real-sr-only">{title}</legend>
      <Field label="Valor *">{id => <input id={id} inputMode="decimal" placeholder="0,00" maxLength={17} value={values.amount} onChange={event => { const amount = event.target.value; setValues(previous => ({ ...previous, amount })); }} />}</Field>
      <Field label="Observação">{id => <input id={id} maxLength={240} value={values.note} onChange={event => { const note = event.target.value; setValues(previous => ({ ...previous, note })); }} />}</Field></fieldset>
    {(error || command.error) && <p className="real-alert" role="alert">{command.error || error}</p>}
  </Modal>;
}

/** Operações › Fechar caixa: Total registrado pelas vendas da frente de caixa por forma, o valor informado (contado) e as diferenças. */
export function PdvCloseDialog({ controller, context, session, sendFinance, mayWrite, onDone, onClose }: { controller: Controller; context: PdvContext; session: PdvSession; sendFinance: Send; mayWrite: () => boolean;
  onDone: () => void; onClose: () => void }) {
  const [record, setRecord] = useState<SessionRecord | null>(null), [summary, setSummary] = useState<PdvSummary | null>(null), [error, setError] = useState('');
  const [informed, setInformed] = useState<Record<string, string>>({});
  const command = useFinanceCommand(sendFinance, mayWrite, pdvFailure), guard = useUnsavedForm(informed, command.locked);
  useEffect(() => {
    const request = new AbortController();
    void Promise.all([controller.finance(`/v1/financeiro/controle-caixa/${session.id}`, { signal: request.signal }), controller.pos(`/v1/frente-caixa/caixas/${session.id}/resumo`, { signal: request.signal })])
      .then(([finance, pos]) => { if (request.signal.aborted) return; setRecord(sessionRecord(finance)); setSummary(pdvSummary(pos)); })
      .catch(failure => { if (!request.signal.aborted) setError(pdvFailure(failure)); });
    return () => request.abort();
  }, [controller, session.id]);
  const rows = summary ? [...summary.methods.map(item => ({ id: item.payment_method_id, name: item.name, type: item.payment_type, registered: item.registered_cents })),
    ...context.methods.filter(method => !summary.methods.some(item => item.payment_method_id === method.id) && (!context.settings.cash_check_methods ? false : ['01', '02'].includes(method.payment_type)))
      .map(method => ({ id: method.id, name: method.description, type: method.payment_type, registered: '0' }))] : [];
  const cashRegistered = rows.filter(row => row.type === '01').reduce((sum, row) => sum + BigInt(row.registered), 0n);
  const expected = record ? BigInt(record.change_cents) + BigInt(record.supply_cents) - BigInt(record.withdrawal_cents) + cashRegistered - BigInt(summary?.returns_cents ?? '0') : null;
  const close = () => void command.run(() => {
    if (!record) throw new Error('Aguarde a leitura do caixa.');
    const values = rows.flatMap(row => informed[row.id]?.trim() ? [{ payment_method_id: row.id, amount_cents: moneyCents(informed[row.id]!) }] : []);
    return { id: crypto.randomUUID(), path: '/v1/financeiro/actions/session_close', data: { id: session.id, expected_version: record.version, values } };
  }, value => { sessionRecord(value); onDone(); });
  return <Modal title="Fechar caixa" onClose={() => { if (!command.busy && !command.uncertain) guard.confirmLeave(onClose); }} actions={actions(command.busy, command.uncertain, 'Fechar caixa', () => guard.confirmLeave(onClose), close, !record || !summary)}>
    {!summary && !error && <p role="status">Carregando o caixa…</p>}
    {summary && record && <>
      <dl className="pdv-close-head"><div><dt>Loja</dt><dd>{session.account_name}</dd></div><div><dt>Operador</dt><dd>{session.operator_name}</dd></div><div><dt>Vendas consideradas</dt><dd>{summary.sales_count}</dd></div>
        <div><dt>Troco</dt><dd>{money(record.change_cents)}</dd></div><div><dt>Suprimentos</dt><dd>{money(record.supply_cents)}</dd></div><div><dt>Sangrias</dt><dd>{money(record.withdrawal_cents)}</dd></div>
        {summary.returns_cents !== '0' && <div><dt>Devoluções</dt><dd>{money(summary.returns_cents)}</dd></div>}<div><dt>Dinheiro esperado</dt><dd><strong>{expected === null ? '—' : money(expected)}</strong></dd></div></dl>
      <fieldset className="finance-drawer-fields" disabled={command.locked}><legend className="real-sr-only">Formas de pagamento</legend>
        <table className="data-table pdv-close-table"><thead><tr><th>Forma de pagamento</th><th className="numeric">Total registrado</th><th className="numeric">Total informado</th><th className="numeric">Diferenças</th></tr></thead>
          <tbody>{rows.map(row => { let difference = '—'; try { difference = informed[row.id]?.trim() ? money(BigInt(moneyCents(informed[row.id]!)) - BigInt(row.registered)) : '—'; } catch { difference = '—'; }
            return <tr key={row.id}><td>{row.name}</td><td className="numeric">{money(row.registered)}</td><td className="numeric"><label className="real-sr-only" htmlFor={`pdv-informed-${row.id}`}>Total informado de {row.name}</label>
              <input id={`pdv-informed-${row.id}`} inputMode="decimal" placeholder="0,00" maxLength={17} value={informed[row.id] ?? ''} onChange={event => { const value = event.target.value; setInformed(previous => ({ ...previous, [row.id]: value })); }} /></td><td className="numeric">{difference}</td></tr>; })}</tbody></table>
        {!rows.length && <p className="real-help">Nenhuma venda registrada neste caixa.</p>}</fieldset>
      <p className="real-help">Situações consideradas no fechamento: {summary.statuses.map(status => status === 'fulfilled' ? 'Atendido' : 'Verificado').join(', ') || 'nenhuma'} (Preferências › Vendas › Frente de caixa).</p></>}
    {(error || command.error) && <p className="real-alert" role="alert">{command.error || error}</p>}
  </Modal>;
}

/** Configurações da frente de caixa (administrador): cliente padrão das vendas sem cliente identificado e a chave Pix do QR estático. */
export function PdvSettingsDialog({ controller, context, sendPos, mayWrite, onDone, onClose }: { controller: Controller; context: PdvContext; sendPos: Send; mayWrite: () => boolean; onDone: () => void; onClose: () => void }) {
  const [values, setValues] = useState({ consumer: context.consumer ? { id: context.consumer.id, name: context.consumer.name } : null as Named | null, type: (context.pix?.key_type ?? '') as PixKeyType | '',
    key: context.pix?.key ?? '', name: context.pix?.merchant_name ?? '', city: context.pix?.merchant_city ?? '' });
  const command = useFinanceCommand(sendPos, mayWrite, pdvFailure), guard = useUnsavedForm(values, command.locked);
  const save = () => void command.run(() => {
    const pix = values.type ? { pix_key_type: values.type, pix_key: pixKey(values.type, values.key), pix_merchant_name: pixText(values.name || 'Empresa', 25), pix_merchant_city: pixText(values.city || 'Cidade', 15) }
      : { pix_key_type: null, pix_key: null, pix_merchant_name: null, pix_merchant_city: null };
    return { id: crypto.randomUUID(), path: '/v1/frente-caixa/actions/settings_save', data: { expected_version: context.settings_version, consumer_contact_id: values.consumer?.id ?? null, ...pix } };
  }, () => onDone());
  return <Modal title="Configurações da frente de caixa" onClose={() => { if (!command.busy && !command.uncertain) guard.confirmLeave(onClose); }} actions={actions(command.busy, command.uncertain, 'Salvar', () => guard.confirmLeave(onClose), save)}>
    <fieldset className="finance-drawer-fields" disabled={command.locked}><legend>Cliente padrão</legend>
      <p className="real-help">Usado nas vendas sem cliente identificado (por exemplo, “Consumidor final”).</p>
      <CatalogPicker controller={controller} entity="contacts" label="Cliente padrão" selected={values.consumer} onSelect={record => setValues(previous => ({ ...previous, consumer: record ? { id: record.id, name: record.name } : null }))} /></fieldset>
    <fieldset className="finance-drawer-fields" disabled={command.locked}><legend>Pix - QR Code Impresso (QR estático)</legend>
      <p className="real-help">O QR estático leva a chave Pix da empresa e o valor da venda. O recebimento é conferido manualmente; nenhum banco é chamado.</p>
      <Field label="Tipo da chave">{id => <select id={id} value={values.type} onChange={event => { const type = event.target.value as PixKeyType | ''; setValues(previous => ({ ...previous, type })); }}><option value="">Sem chave Pix</option>{PIX_KEY_TYPES.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select>}</Field>
      {values.type && <><Field label="Chave Pix *">{id => <input id={id} maxLength={77} value={values.key} onChange={event => { const key = event.target.value; setValues(previous => ({ ...previous, key })); }} />}</Field>
        <Field label="Nome do recebedor (até 25 letras, sem acentos) *">{id => <input id={id} maxLength={25} value={values.name} onChange={event => { const name = event.target.value; setValues(previous => ({ ...previous, name })); }} />}</Field>
        <Field label="Cidade do recebedor (até 15 letras) *">{id => <input id={id} maxLength={15} value={values.city} onChange={event => { const city = event.target.value; setValues(previous => ({ ...previous, city })); }} />}</Field></>}
    </fieldset>{command.error && <p className="real-alert" role="alert">{command.error}</p>}
  </Modal>;
}

/** Nova venda mesa (V) / Transferir mesa: número da mesa e as comandas abertas. */
export function PdvTableDialog({ mode, open, onPick, onOpen, onClose }: { mode: 'new' | 'transfer'; open: { id: string; table_number: number | null; total_cents: string }[]; onPick: (table: number) => void; onOpen: (id: string) => void; onClose: () => void }) {
  const [table, setTable] = useState(''), [error, setError] = useState('');
  const ok = () => { if (!/^[1-9]\d{0,3}$/.test(table.trim())) { setError('Informe o número da mesa (1 a 9999).'); return; } const number = Number(table); if (open.some(row => row.table_number === number)) { setError('Já existe uma comanda aberta nesta mesa.'); return; } onPick(number); };
  return <Modal title={mode === 'new' ? 'Nova venda mesa' : 'Transferir mesa'} onClose={onClose} actions={<><button type="button" className="secondary-button" onClick={onClose}>Cancelar</button><button type="button" className="primary-button" onClick={ok}>Ok</button></>}>
    <Field label="Número da mesa *">{id => <input id={id} inputMode="numeric" maxLength={4} value={table} onChange={event => { setTable(event.target.value); setError(''); }} />}</Field>
    {error && <p className="real-alert" role="alert">{error}</p>}
    {mode === 'new' && <section className="pdv-tables" aria-label="Mesas abertas"><h3>Mesas abertas</h3>{!open.length ? <p className="real-help">Nenhuma mesa aberta.</p>
      : <ul>{open.map(row => <li key={row.id}><button type="button" className="secondary-button" onClick={() => onOpen(row.id)}>Mesa {row.table_number} · {money(row.total_cents)}</button></li>)}</ul>}</section>}
  </Modal>;
}

/** Cancelar venda: estorna o que a venda lançou e cancela o pedido (motivo obrigatório). */
export function PdvCancelDialog({ sale, sendPos, mayWrite, onDone, onClose }: { sale: PdvSale; sendPos: Send; mayWrite: () => boolean; onDone: (sale: PdvSale) => void; onClose: () => void }) {
  const [reason, setReason] = useState(''), command = useFinanceCommand(sendPos, mayWrite, pdvFailure), guard = useUnsavedForm(reason, command.locked);
  const save = () => void command.run(() => { if (reason.trim().length < 3) throw new Error('Informe o motivo com pelo menos três caracteres.'); return { id: crypto.randomUUID(), path: '/v1/frente-caixa/actions/sale_cancel', data: { sale_id: sale.id, expected_version: sale.version, reason: reason.trim() } }; },
    value => onDone(pdvSale(value)));
  const finished = sale.state === 'finished';
  return <Modal title={`Cancelar venda nº ${sale.number}`} onClose={() => { if (!command.busy && !command.uncertain) guard.confirmLeave(onClose); }} actions={actions(command.busy, command.uncertain, 'Cancelar venda', () => guard.confirmLeave(onClose), save)}>
    <p>{finished ? 'A baixa no caixa, as contas a receber e o estoque lançados pela venda são estornados, e o pedido fica Cancelado.' : 'A venda guardada é excluída e o pedido fica Cancelado.'}</p>
    <Field label="Motivo *">{id => <textarea id={id} rows={3} maxLength={1000} disabled={command.locked} value={reason} onChange={event => setReason(event.target.value)} />}</Field>
    {command.error && <p className="real-alert" role="alert">{command.error}</p>}
  </Modal>;
}

/** Operações › Gerar devolução: itens que voltam ao estoque e o dinheiro devolvido pelo caixa, ligados à venda original. */
export function PdvReturnDialog({ sale, session, sendPos, mayWrite, onDone, onClose }: { sale: PdvSale; session: PdvSession | null; sendPos: Send; mayWrite: () => boolean; onDone: (sale: PdvSale, result: PdvReturnResult) => void; onClose: () => void }) {
  const [quantities, setQuantities] = useState<Record<string, string>>({}), [reason, setReason] = useState('');
  const command = useFinanceCommand(sendPos, mayWrite, pdvFailure), guard = useUnsavedForm({ quantities, reason }, command.locked);
  const available = (id: string, sold: string) => { const left = decimal(sold, 6, 9) - decimal(sale.returned?.[id] ?? '0', 6, 9); return left > 0n ? quantityText(format(left, 6)) : '0'; };
  const save = () => void command.run(() => {
    const items = sale.items.flatMap(item => quantities[item.id]?.trim() ? [{ item_id: item.id, quantity: quantityInput(quantities[item.id]!) }] : []);
    if (!items.length) throw new Error('Informe a quantidade devolvida de pelo menos um item.');
    if (reason.trim().length < 3) throw new Error('Informe o motivo com pelo menos três caracteres.');
    return { id: crypto.randomUUID(), path: '/v1/frente-caixa/actions/sale_return', data: { sale_id: sale.id, expected_version: sale.version, items, refund_account_id: session ? session.account_id : sale.account_id, cash_session_id: session?.id ?? null, reason: reason.trim() } };
  }, value => onDone(pdvSale(value), pdvReturnResult(value)));
  return <Modal title={`Gerar devolução · venda nº ${sale.number}`} onClose={() => { if (!command.busy && !command.uncertain) guard.confirmLeave(onClose); }} actions={actions(command.busy, command.uncertain, 'Gerar devolução', () => guard.confirmLeave(onClose), save)}>
    <p className="real-help">Os produtos voltam ao depósito do lançamento da venda e o valor (com a parte do desconto da venda) sai em dinheiro do caixa, até o que a venda recebeu: parcelas em aberto (a prazo, cartão a receber ou Ficha Financeira) não viram dinheiro. A nota fiscal de devolução não é gerada aqui.</p>
    <fieldset className="finance-drawer-fields" disabled={command.locked}><legend className="real-sr-only">Itens devolvidos</legend>
      <table className="data-table"><thead><tr><th>Produto</th><th className="numeric">Vendido</th><th className="numeric">Pode devolver</th><th className="numeric">Devolver</th></tr></thead>
        <tbody>{sale.items.map(item => <tr key={item.id}><td>{item.description}</td><td className="numeric">{quantityText(item.quantity)} {item.unit}</td><td className="numeric">{available(item.id, item.quantity)}</td>
          <td className="numeric"><label className="real-sr-only" htmlFor={`pdv-return-${item.id}`}>Devolver {item.description}</label><input id={`pdv-return-${item.id}`} inputMode="decimal" maxLength={16} value={quantities[item.id] ?? ''} onChange={event => { const value = event.target.value; setQuantities(previous => ({ ...previous, [item.id]: value })); }} /></td></tr>)}</tbody></table>
      <Field label="Motivo *">{id => <textarea id={id} rows={2} maxLength={500} value={reason} onChange={event => setReason(event.target.value)} />}</Field></fieldset>
    {command.error && <p className="real-alert" role="alert">{command.error}</p>}
  </Modal>;
}

export function PdvShortcutsDialog({ shortcuts, mac, onClose }: { shortcuts: readonly { action: string; key: string; label: string }[]; mac: boolean; onClose: () => void }) {
  return <Modal title="Lista de atalhos" onClose={onClose} actions={<button type="button" className="secondary-button" onClick={onClose}>Fechar</button>}>
    <ul className="pdv-shortcut-list">{(shortcuts.length ? shortcuts : PDV_SHORTCUTS).map(item => <li key={item.action}><span>{item.label}</span><kbd>{shortcutHint(item.key, mac)}</kbd></li>)}</ul>
    <p className="real-help">As teclas são as de Preferências › Vendas › Frente de caixa › Configurações de teclas de atalho.</p>
  </Modal>;
}

/** Remover produto a partir do GTIN (R): o código ou GTIN lido tira uma unidade do item na venda. */
export function PdvGtinDialog({ onRemove, onClose }: { onRemove: (code: string) => string | null; onClose: () => void }) {
  const [code, setCode] = useState(''), [error, setError] = useState('');
  const ok = () => { const message = onRemove(code.trim()); if (message) setError(message); else onClose(); };
  return <Modal title="Remover produto a partir do GTIN" onClose={onClose} actions={<><button type="button" className="secondary-button" onClick={onClose}>Cancelar</button><button type="button" className="primary-button" onClick={ok}>Remover</button></>}>
    <Field label="Código ou GTIN">{id => <input id={id} maxLength={60} value={code} onChange={event => { setCode(event.target.value); setError(''); }} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); ok(); } }} />}</Field>
    {error && <p className="real-alert" role="alert">{error}</p>}
  </Modal>;
}

/** Pix - QR Code Impresso: o QR estático com o valor das parcelas à vista em Pix; o operador confere o recebimento no banco. */
export function PdvPixDialog({ payload, amount, confirm, onConfirm, onPrint, onClose }: { payload: string; amount: string | null; confirm: boolean; onConfirm: () => void; onPrint: () => void; onClose: () => void }) {
  return <Modal title={amount ? 'Pix - QR Code Impresso' : 'QR code fixo'} onClose={onClose} actions={<><button type="button" className="secondary-button" onClick={onClose}>{confirm ? 'Cancelar' : 'Fechar'}</button>
    <button type="button" className="secondary-button" onClick={onPrint}>Imprimir</button>{confirm && <button type="button" className="primary-button" onClick={onConfirm}>Pagamento recebido</button>}</>}>
    {amount && <p className="pdv-pix-amount">Valor: <strong>{money(amount)}</strong></p>}<PdvQr payload={payload} label={amount ? `QR Code Pix de ${money(amount)}` : 'QR code fixo da chave Pix'} />
    <p className="real-help">{confirm ? 'Confira no aplicativo ou extrato do banco que o Pix foi recebido antes de confirmar.' : 'O pagador informa o valor no aplicativo do banco.'}</p>
  </Modal>;
}
