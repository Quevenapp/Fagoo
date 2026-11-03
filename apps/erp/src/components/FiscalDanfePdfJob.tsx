import { useState } from 'react';
import { DANFE_JOB_MAX, danfeJobText, type DanfeJobState } from '../lib/danfe-pdf-job';
import { saveFile } from '../lib/fiscal-invoice-xml';

/**
 * Faixa da tarefa "Gerar PDF DANFE" em segundo plano (painel da lista, Selecionadas | Período): o andamento, Cancelar enquanto lê os
 * XMLs e, no fim, o botão que baixa o arquivo (o download parte de um clique, para o navegador não bloquear). A listagem continua
 * utilizável; sair da tela enquanto a tarefa roda pede confirmação.
 */
export default function FiscalDanfePdfJob({ state, onCancel, onClose }: { state: DanfeJobState; onCancel: () => void; onClose: () => void }) {
  const [saved, setSaved] = useState(false), [failed, setFailed] = useState(false);
  const download = () => {
    if (!state.file) return;
    setFailed(false);
    try { saveFile(state.file.name, state.file.bytes as Uint8Array<ArrayBuffer>, state.file.type); setSaved(true); } catch { setFailed(true); }
  };
  return <section className={state.error ? 'real-alert fiscal-pdf-job' : 'real-notice fiscal-pdf-job'} aria-label="Gerar PDF DANFE" aria-live="polite">
    <p role="status">{danfeJobText(state)}</p>
    {state.beyond > 0 && <p>O período tem mais notas do que uma tarefa leva: as {DANFE_JOB_MAX.toLocaleString('pt-BR')} primeiras, na ordem da lista, entram no arquivo e {state.beyond.toLocaleString('pt-BR')} ficam de fora. Reduza o período para gerar as demais.</p>}
    {state.problems.length > 0 && <details><summary>{state.problems.length} nota(s) fora do arquivo</summary><ul>{state.problems.slice(0, 200).map((text, index) => <li key={`${index}:${text}`}>{text}</li>)}</ul></details>}
    {saved && <p className="real-success">Arquivo baixado.</p>}
    {failed && <p role="alert">Não foi possível baixar o arquivo. Tente novamente.</p>}
    <div className="button-group">
      {state.running && <button type="button" className="secondary-button" onClick={onCancel}>Cancelar</button>}
      {!state.running && state.file && <button type="button" className="primary-button" onClick={download}>{state.file.type === 'application/zip' ? 'Baixar ZIP' : 'Baixar PDF'}</button>}
      {!state.running && <button type="button" className="secondary-button" onClick={onClose}>Fechar</button>}
    </div>
  </section>;
}
