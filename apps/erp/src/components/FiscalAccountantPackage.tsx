import { useEffect, useRef, useState } from 'react';
import type { AccessController } from '../lib/real-access';
import { originDetail, listPage as checkListPage } from '../../../../packages/erp-domain/src/fiscal-invoice-contract.mjs';
import { FISCAL_BASE, FISCAL_PAGE_SIZE, SCREENS, brDay, emptyFilters, fiscalListQuery, invoiceNumber, isImported, statusLabel, type FiscalOrigin, type FiscalScreen, type ListRow } from '../lib/fiscal-invoice-list-model';
import { importedXml, saveFile } from '../lib/fiscal-invoice-xml';
import { downloadVerifiedXml } from './FiscalOriginInvoiceView';
import { zipStore } from '../lib/spreadsheet-export';
import { Modal } from './Modal';
import { competenceRange, previousCompetence, summaryCell } from '../lib/fiscal-accountant-package';

const aborted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
const MAX_PER_TYPE = 1000;
const FOLDERS: Record<FiscalScreen, string> = { nfe: 'NFe-saida', nfce: 'NFCe', entrada: 'NFe-entrada' };
const TYPE_LABELS: Record<FiscalScreen, string> = { nfe: 'Notas fiscais de saída (NF-e)', nfce: 'NFC-e', entrada: 'Notas fiscais de entrada' };
type Progress = { done: number; total: number; files: number; skipped: string[]; beyond: string[] };

/**
 * Espaço Meu Contador › Arquivos (Origin): o pacote de uma competência com os XMLs das NF-e de saída, NFC-e e notas de entrada
 * (acervo do Origin conferido por tamanho e SHA-256 e XMLs importados no Brufap), as cartas de correção coletadas e um resumo.csv,
 * montado no navegador e baixado num ZIP. Nada é gravado nem enviado; SPED e Sintegra não existem no Brufap.
 */
export default function FiscalAccountantPackage({ controller, writable, onClose }: { controller: AccessController; writable: boolean; onClose: () => void }) {
  const [competence, setCompetence] = useState(previousCompetence), [types, setTypes] = useState<Record<FiscalScreen, boolean>>({ nfe: true, nfce: true, entrada: true }), [letters, setLetters] = useState(true);
  const [progress, setProgress] = useState<Progress | null>(null), [running, setRunning] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const life = useRef<AbortController | null>(null);
  useEffect(() => () => life.current?.abort(), []);
  // Every note of the period of one list: the Origin mirror and, for administrador and fiscal, the XMLs imported in Brufap.
  const gather = async (screen: FiscalScreen, range: { from: string; to: string }, signal: AbortSignal, beyond: string[]) => {
    const config = SCREENS[screen], rows: ListRow[] = [];
    for (const origin of (writable ? ['origin', 'brufap'] : ['origin']) as FiscalOrigin[]) {
      const filters = { ...emptyFilters(config), from: range.from, to: range.to };
      for (let page = 1; page <= Math.ceil(MAX_PER_TYPE / FISCAL_PAGE_SIZE); page++) {
        const value = checkListPage(await controller.fiscalInvoices(`${FISCAL_BASE}?${fiscalListQuery(config, origin, filters, { page })}`, { signal }),
          { origin, model: config.model, direction: config.direction, page, limit: FISCAL_PAGE_SIZE, order: 'date_desc' });
        rows.push(...value.items.filter(row => origin === 'origin' || isImported(row)));
        if (!value.has_more) break;
        if (page === Math.ceil(MAX_PER_TYPE / FISCAL_PAGE_SIZE)) beyond.push(`${TYPE_LABELS[screen]} (${origin === 'origin' ? 'Origin' : 'FAGOO'}): ${value.total_count - MAX_PER_TYPE} nota(s) além das ${MAX_PER_TYPE} primeiras.`);
      }
    }
    return rows;
  };
  const run = async () => {
    const range = competenceRange(competence);
    if (!range) { setError('Informe a competência (mês e ano).'); return; }
    if (running || (!types.nfe && !types.nfce && !types.entrada)) return;
    const request = new AbortController(); life.current = request; setRunning(true); setError(''); setNotice('');
    const encoder = new TextEncoder(), files: { name: string; data: Uint8Array }[] = [], skipped: string[] = [], beyond: string[] = [];
    const summary = [['Tipo', 'Número', 'Série', 'Data', 'Nome', 'CPF/CNPJ', 'Situação', 'Valor', 'Chave de acesso', 'Arquivo'].map(summaryCell).join(';')];
    try {
      const work: { screen: FiscalScreen; row: ListRow }[] = [];
      for (const screen of (['nfe', 'nfce', 'entrada'] as const).filter(s => types[s])) for (const row of await gather(screen, range, request.signal, beyond)) work.push({ screen, row });
      if (request.signal.aborted) return;
      setProgress({ done: 0, total: work.length, files: 0, skipped, beyond });
      for (const [index, { screen, row }] of work.entries()) {
        const config = SCREENS[screen], label = `${TYPE_LABELS[screen]} ${invoiceNumber(row)}`;
        let file = '';
        try {
          if (isImported(row)) { const xml = await importedXml(controller, row.id, request.signal); file = `${FOLDERS[screen]}/NFe${xml.access_key}.xml`; files.push({ name: file, data: encoder.encode(xml.xml) }); }
          else if (row.xml_id && row.xml_hash && row.xml_size) { const text = await downloadVerifiedXml(controller, { id: row.xml_id, hash: row.xml_hash, size: row.xml_size }, config.model, request.signal, false); file = `${FOLDERS[screen]}/NFe${row.access_key ?? row.xml_hash.slice(0, 12)}.xml`; files.push({ name: file, data: encoder.encode(text) }); }
          else skipped.push(`${label}: sem XML ${row.origin === 'origin' ? 'coletado do Origin' : 'guardado no FAGOO'}.`);
          if (letters && config.model === '55' && row.origin === 'origin' && row.event_count > 0) {
            const detail = originDetail(await controller.fiscalInvoices(`${FISCAL_BASE}/origin/nfe/${row.id}`, { signal: request.signal }));
            for (const event of detail.events.filter(e => e.type === '110110')) {
              const text = await downloadVerifiedXml(controller, { id: event.id, hash: event.hash, size: event.size }, config.model, request.signal, false);
              files.push({ name: `CCe/CCe${row.access_key ?? row.id}-${event.sequence ?? event.hash.slice(0, 8)}.xml`, data: encoder.encode(text) });
            }
          }
        } catch (problem) { if (request.signal.aborted || aborted(problem)) return; skipped.push(`${label}: o XML não pôde ser conferido.`); }
        summary.push([TYPE_LABELS[screen], invoiceNumber(row), row.series === null ? '' : String(row.series), brDay(screen === 'entrada' ? row.entry_date ?? row.issue_date : row.issue_date), row.name ?? '', row.document ?? '',
          statusLabel(row, config.model), row.total_known ? row.total.replace('.', ',') : '', row.access_key ?? '', file].map(summaryCell).join(';'));
        setProgress({ done: index + 1, total: work.length, files: files.length, skipped: [...skipped], beyond });
      }
      if (request.signal.aborted) return;
      if (!files.length) { setError('Nenhum XML da competência pôde ser conferido para o pacote.'); return; }
      files.push({ name: 'resumo.csv', data: encoder.encode(`﻿${summary.join('\r\n')}\r\n`) });
      saveFile(`xml-contador-${competence}.zip`, zipStore(files) as Uint8Array<ArrayBuffer>, 'application/zip');
      setNotice(`Pacote da competência ${competence.split('-').reverse().join('/')} baixado: ${files.length - 1} XML(s) e o resumo.csv.`);
    } catch (problem) { if (!request.signal.aborted && !aborted(problem)) setError('Não foi possível reunir as notas da competência.'); }
    finally { if (life.current === request) { life.current = null; setRunning(false); } }
  };
  const cancel = () => { life.current?.abort(); onClose(); };
  return <Modal title="Arquivos para o contador" onClose={cancel} actions={<><button type="button" className="primary-button" disabled={running || (!types.nfe && !types.nfce && !types.entrada)} onClick={() => void run()}>{running ? 'Gerando…' : 'Gerar pacote'}</button>
    <button type="button" className="secondary-button" onClick={cancel}>{running ? 'Cancelar' : 'Fechar'}</button></>}>
    <div className="fiscal-xml-export">
      <div className="form-field"><label htmlFor="fiscal-accountant-month">Competência</label><input id="fiscal-accountant-month" type="month" min="1900-01" max="2099-12" disabled={running} value={competence} onChange={event => setCompetence(event.target.value)} /></div>
      <fieldset className="fiscal-group"><legend>Notas</legend>{(['nfe', 'nfce', 'entrada'] as const).map(screen => <label key={screen} htmlFor={`fiscal-accountant-${screen}`}><input id={`fiscal-accountant-${screen}`} type="checkbox" disabled={running} checked={types[screen]}
        onChange={event => { const checked = event.target.checked; setTypes(t => ({ ...t, [screen]: checked })); }} /> {TYPE_LABELS[screen]}</label>)}
        <label htmlFor="fiscal-accountant-letters"><input id="fiscal-accountant-letters" type="checkbox" disabled={running} checked={letters} onChange={event => setLetters(event.target.checked)} /> Cartas de correção</label></fieldset>
      <p className="real-help">O pacote leva os XMLs autorizados das notas da competência (data de emissão na saída e na NFC-e, data de entrada nas notas de entrada), conferidos por tamanho e SHA-256, e um resumo.csv. Até {MAX_PER_TYPE.toLocaleString('pt-BR')} notas por tipo e origem. SPED e Sintegra não são gerados pelo FAGOO.</p>
      {progress && <p role="status">{progress.done} de {progress.total} notas · {progress.files} arquivo(s)</p>}
      {progress && progress.beyond.length > 0 && <div className="real-notice" role="status"><p>Ficaram de fora:</p><ul>{progress.beyond.map(text => <li key={text}>{text}</li>)}</ul></div>}
      {progress && progress.skipped.length > 0 && <details><summary>{progress.skipped.length} nota(s) sem XML no pacote</summary><ul>{progress.skipped.slice(0, 100).map(text => <li key={text}>{text}</li>)}</ul></details>}
      {notice && <p className="real-success" role="status">{notice}</p>}
      {error && <p className="real-alert" role="alert">{error}</p>}
    </div>
  </Modal>;
}
