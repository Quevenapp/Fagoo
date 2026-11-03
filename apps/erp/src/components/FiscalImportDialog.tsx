import { useEffect, useRef, useState } from 'react';
import { AccessError, type AccessController } from '../lib/real-access';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import { invoiceRecord, type InvoiceRecord } from '../../../../packages/erp-domain/src/fiscal-invoice-contract.mjs';
import { FISCAL_BASE, IMPORT_REFUSALS, importRefusalText } from '../lib/fiscal-invoice-list-model';
import { Modal } from './Modal';
// Notas lane (wave F): "Lançar Contas" / "Lançar Estoque" of the import go on with the flows of the note (247 and 259), each with its prévia and command.
import FiscalInvoiceFinance from './FiscalInvoiceFinance';
import InvoiceStockDialog from './InvoiceStock';

const MAX_BYTES = 1024 * 1024;
const aborted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
const actorOf = (controller: AccessController) => controller.getSnapshot?.()?.membership?.user_id ?? null;
const roleOf = (controller: AccessController) => controller.getSnapshot?.()?.membership?.role ?? '';
type Outcome = { kind: 'imported'; record: InvoiceRecord; matched: number; contact: boolean; catalog: { created: number; updated: number; failures: number } | null } | { kind: 'refused'; text: string; invoiceId: string | null };
const count = (value: unknown) => Number.isInteger(value) && (value as number) >= 0 ? value as number : null;
type Command = { id: string; actor: string | null; xml: string; uncertain: boolean };

const FINANCE_ROLES = ['admin', 'financeiro'], STOCK_ROLES = ['admin', 'estoque'];
type Phase = 'import' | 'finance' | 'stock';
/**
 * "Importar XML NF-e" (Origin Mais ações › Importar) and, on the NFC-e list, "Importar XML" (wave F): one authorized XML per command, with its
 * signature checked. The note is registered in Brufap (Importação de XML de entrada ou de saída, situação Registrada). "Lançar Contas" and
 * "Lançar Estoque" open, right after the import, the Lançar contas (247) and Lançar estoque (259) of the note, with their prévia.
 */
export default function FiscalImportDialog({ controller, initial = null, model = '55', onClose, onOpen }: { controller: AccessController; initial?: { name: string; xml: string } | null; model?: '55' | '65'; onClose: (changed: boolean) => void; onOpen: (id: string, direction?: '0' | '1', reconcile?: boolean, model?: '55' | '65') => void }) {
  // "Notas recebidas" hands over the XML it already checked by size and SHA-256.
  const [file, setFile] = useState<{ name: string; xml: string } | null>(initial), [error, setError] = useState(''), [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const role = roleOf(controller), canFinance = FINANCE_ROLES.includes(role) && typeof controller.finance === 'function', canStock = STOCK_ROLES.includes(role) && typeof controller.stock === 'function';
  const [postFinance, setPostFinance] = useState(false), [postStock, setPostStock] = useState(false), [phase, setPhase] = useState<Phase>('import');
  const [posted, setPosted] = useState<{ finance: boolean; stock: string }>({ finance: false, stock: '' });
  const command = useRef<Command | null>(null), life = useRef(new AbortController()), actor = useRef(actorOf(controller));
  useEffect(() => { const current = life.current; return () => current.abort(); }, []);
  const choose = async (picked: File | undefined | null) => {
    if (!picked || busy || command.current) return;
    setError(''); setOutcome(null);
    if (!/\.xml$/i.test(picked.name)) { setError('Escolha um arquivo .xml.'); return; }
    if (picked.size > MAX_BYTES) { setError('O XML pode ter até 1 MB.'); return; }
    try { const xml = await picked.text(); if (new TextEncoder().encode(xml).byteLength > MAX_BYTES) { setError('O XML pode ter até 1 MB.'); return; } setFile({ name: picked.name, xml }); }
    catch { setError('Não foi possível ler o arquivo.'); }
  };
  const send = async () => {
    const op = command.current; if (!op || busy) return;
    if (actorOf(controller) !== op.actor || !['admin', 'fiscal'].includes(roleOf(controller))) { command.current = null; setUncertain(false); setError('A sessão ou o perfil mudou. Nada foi enviado.'); return; }
    setBusy(true); setError('');
    try {
      const value = await controller.fiscalInvoices(`${FISCAL_BASE}/importar`, { method: 'POST', body: { command_id: op.id, xml: op.xml }, signal: life.current.signal }) as Record<string, unknown>;
      if (life.current.signal.aborted) return;
      command.current = null; setUncertain(false);
      if (value?.imported === false && typeof value.refused === 'string' && (IMPORT_REFUSALS as readonly string[]).includes(value.refused)) {
        setOutcome({ kind: 'refused', text: importRefusalText(value as { refused: string; field?: string; computed_total?: string; xml_total?: string | null }), invoiceId: typeof value.invoice_id === 'string' ? value.invoice_id : null }); return;
      }
      if (value?.imported !== true || !Number.isInteger(value.matched_items)) throw new AccessError(502);
      const record = invoiceRecord(value.invoice);
      if (!['S', 'X'].includes(record.issue_type)) throw new AccessError(502);
      // 202610200217: products created / updated in the cadastro by the entry note (Preferências › Produtos and › Configurações de NF-e).
      const created = count(value.created_products), updated = count(value.updated_products), failures = count(value.product_failures);
      setOutcome({ kind: 'imported', record, matched: value.matched_items as number, contact: value.contact_matched === true,
        catalog: created !== null && updated !== null && failures !== null ? { created, updated, failures } : null }); setFile(null);
      // "Lançar Contas" / "Lançar Estoque" marked: the flows of the note follow, for the user who imported (still allowed to post).
      if (postFinance && canFinance && actorOf(controller) === op.actor) setPhase('finance'); else if (postStock && canStock && actorOf(controller) === op.actor) setPhase('stock');
    } catch (problem) {
      if (life.current.signal.aborted || aborted(problem)) return;
      if (!op.uncertain && problem instanceof AccessError && [400, 403, 409].includes(problem.status)) { command.current = null; setError(problem.status === 403 ? 'Seu perfil não importa notas fiscais.' : 'O servidor recusou o arquivo.'); }
      else { op.uncertain = true; setUncertain(true); setError('Não foi possível confirmar a importação. Use "Conferir resultado" para repetir o mesmo comando sem duplicar a nota.'); }
    } finally { if (!life.current.signal.aborted) setBusy(false); }
  };
  const start = () => { if (!file || command.current) return; command.current = { id: crypto.randomUUID(), actor: actor.current, xml: file.xml, uncertain: false }; void send(); };
  const imported = outcome?.kind === 'imported' ? outcome : null;
  const nextAfterFinance = () => setPhase(postStock && canStock && actorOf(controller) === actor.current ? 'stock' : 'import');
  // A chosen file not yet answered, or an import whose outcome is unknown, asks before leaving (like the other fiscal dialogs).
  const guard = useUnsavedChanges(Boolean(file && !outcome) || uncertain, busy);
  const close = () => { if (!busy) guard.confirmLeave(() => onClose(Boolean(imported))); };
  if (imported && phase === 'finance') return <FiscalInvoiceFinance controller={controller} invoiceId={imported.record.id} onClose={nextAfterFinance} onChanged={() => setPosted(value => ({ ...value, finance: true }))} />;
  if (imported && phase === 'stock') return <InvoiceStockDialog controller={controller} invoiceId={imported.record.id} mode="post" onClose={() => setPhase('import')}
    onDone={message => { setPosted(value => ({ ...value, stock: message })); setPhase('import'); }} />;
  return <Modal title={model === '65' ? 'Importar XML NFC-e' : 'Importar XML NF-e'} onClose={close}
    actions={<>{uncertain ? <button type="button" className="primary-button" disabled={busy} onClick={() => void send()}>{busy ? 'Conferindo…' : 'Conferir resultado'}</button>
      : !imported && <button type="button" className="primary-button" disabled={!file || busy} onClick={start}>{busy ? 'Importando…' : 'Importar'}</button>}
      <button type="button" className="secondary-button" disabled={busy} onClick={close}>Fechar</button></>}>
    <div className="fiscal-import">
      {!imported && <>
        <div className="fiscal-import-options"><label htmlFor="fiscal-import-finance"><input id="fiscal-import-finance" type="checkbox" checked={postFinance} disabled={!canFinance || busy || Boolean(command.current)}
          title={canFinance ? 'Depois de importar, abre Lançar contas da nota (prévia com categoria e conta, e confirmação).' : 'Somente administrador e financeiro lançam contas pela nota.'} onChange={event => setPostFinance(event.target.checked)} /> Lançar Contas</label>
          <label htmlFor="fiscal-import-stock"><input id="fiscal-import-stock" type="checkbox" checked={postStock} disabled={!canStock || busy || Boolean(command.current)}
            title={canStock ? 'Depois de importar, abre Lançar estoque da nota (depósito, prévia e confirmação).' : 'Somente administrador e estoque lançam o estoque da nota.'} onChange={event => setPostStock(event.target.checked)} /> Lançar Estoque</label></div>
        <label className="fiscal-import-drop" htmlFor="fiscal-import-file" onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); void choose(event.dataTransfer?.files?.[0]); }}>
          <span>Arraste o .xml aqui ou</span> <strong>Clique para selecionar um arquivo</strong>
          <input id="fiscal-import-file" type="file" accept=".xml,application/xml,text/xml" disabled={busy || Boolean(command.current)} onChange={event => void choose(event.target.files?.[0])} /></label>
        {file && <p className="real-help">Arquivo escolhido: {file.name}</p>}
        <p className="real-help">{model === '65' ? 'NFC-e 4.00 autorizada (modelo 65) emitida pela empresa.' : 'NF-e 4.00 autorizada (modelo 55); a NFC-e da empresa é importada na lista de NFC-e.'} A assinatura digital do XML é conferida (a cadeia ICP-Brasil não). A nota fica registrada no FAGOO com a chave e o protocolo do XML, sem transmissão; o XML fica guardado para "Baixar XML".</p></>}
      {error && <p className="real-alert" role="alert">{error}</p>}
      {outcome?.kind === 'refused' && <div className="real-alert" role="alert"><p>{outcome.text}</p>{outcome.invoiceId && <button type="button" className="text-button" onClick={() => onOpen(outcome.invoiceId!)}>Visualizar nota</button>}</div>}
      {imported && <div className="real-success" role="status"><p>Sua nota foi importada com sucesso.</p>
        <p>{imported.record.issue_type === 'X' ? 'Importação de XML de entrada' : 'Importação de XML de saída'} · nota {String(imported.record.number ?? '').padStart(6, '0')} · {imported.record.recipient.name ?? 'Sem nome'}</p>
        <p className="real-help">{imported.matched} de {imported.record.items.length} item(ns) ligado(s) ao cadastro de produtos{imported.contact ? '; contato encontrado no cadastro' : ''}.</p>
        {imported.catalog && (imported.catalog.created > 0 || imported.catalog.updated > 0) && <p className="real-help">Cadastro de produtos: {imported.catalog.created} produto(s) cadastrado(s) a partir da nota e {imported.catalog.updated} atualizado(s) com os dados do XML.</p>}
        {imported.catalog && imported.catalog.failures > 0 && <p className="real-notice">{imported.catalog.failures} produto(s) não puderam ser gravados no cadastro; confira em Conciliar produtos e no cadastro de produtos.</p>}
        {(postFinance || postStock) && <p className="real-help">{[postFinance ? (posted.finance ? 'Contas lançadas pela nota.' : 'Contas não lançadas: use ⋮ Lançar contas na nota.') : '',
          postStock ? (posted.stock || 'Estoque não lançado: use ⋮ Lançar estoque na nota.') : ''].filter(Boolean).join(' ')}</p>}
        <div className="real-editor-actions"><button type="button" className="secondary-button" onClick={() => onOpen(imported.record.id, imported.record.direction, false, imported.record.model)}>Visualizar nota</button>
          {imported.matched < imported.record.items.length && <button type="button" className="secondary-button" onClick={() => onOpen(imported.record.id, imported.record.direction, true, imported.record.model)}>Conciliar produtos</button>}</div></div>}
    </div>
  </Modal>;
}
