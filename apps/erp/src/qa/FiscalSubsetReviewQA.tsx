import {useMemo,useState} from 'react';
import type {AccessController} from '../lib/real-access';
import FiscalSubsetReview from '../components/FiscalSubsetReview';
import type {createSubsetReviewQaFixture} from './subset-review-fixture';

export default function FiscalSubsetReviewQA({controller,fixture}:{controller:AccessController;fixture:ReturnType<typeof createSubsetReviewQaFixture>}){
 const [model,setModel]=useState<'55'|'65'>('55'),[previous,setPrevious]=useState(false),[busy,setBusy]=useState(false),[dirty,setDirty]=useState(false),[,render]=useState(0);
 const port=useMemo(()=>({...controller,fiscalSubsetReview:async(path:string,options:Parameters<AccessController['fiscalSubsetReview']>[1])=>{try{return await controller.fiscalSubsetReview(path,options);}finally{render(n=>n+1);}}}),[controller]);
 return <>
  <p role="note" className="real-notice">QA isolado com dados fictícios. O salvamento existe apenas na memória desta página, sem banco, A1, XML ou SEFAZ. Recarregar a página apaga a simulação.</p>
  <label>Modelo de teste <select value={model} disabled={busy||dirty} onChange={e=>{if(!busy&&!dirty)setModel(e.target.value as '55'|'65');}}><option value="55">NF-e 55</option><option value="65">NFC-e 65</option></select></label>
  <label>Contexto de teste <select aria-label="Contexto de teste" value={previous?'previous':'empty'} disabled={busy||dirty} onChange={e=>{if(!busy&&!dirty){const value=e.target.value==='previous';fixture.resetScenario(value);setPrevious(value);}}}><option value="empty">Sem revisão anterior</option><option value="previous">Revisão das regras anteriores</option></select></label>
  <p>Fluxo simulado: conferir dados, editar uma escolha e a validade, salvar uma vez. O ACK e a primeira consulta são perdidos; use “Consultar resultado da revisão” novamente. Nenhum POST é repetido automaticamente.</p>
  <p aria-label="Contadores da revisão fictícia">Contextos: {fixture.counts.context} · POSTs: {fixture.counts.save} · Revisões na memória: {fixture.counts.committed} · Consultas de comando: {fixture.counts.command} · ACKs perdidos: {fixture.counts.lostAck} · Consultas indisponíveis: {fixture.counts.failedLookup} · Rotas recusadas: {fixture.counts.forbidden}</p>
  <FiscalSubsetReview key={`${model}:${previous}`} controller={port} candidate={fixture.candidate(model)} onBusy={setBusy} onDraft={setDirty}/>
 </>;
}
