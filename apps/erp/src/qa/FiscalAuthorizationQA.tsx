import {useMemo,useState} from 'react';
import type {AccessController} from '../lib/real-access';
import FiscalAuthorization from '../components/FiscalAuthorization';
import type {createAuthorizationQaFixture} from './authorization-fixture';
export default function FiscalAuthorizationQA({controller,fixture}:{controller:AccessController;fixture:ReturnType<typeof createAuthorizationQaFixture>}){
 const [model,setModel]=useState<'55'|'65'>('55'),[busy,setBusy]=useState(false),[,render]=useState(0);
 const port=useMemo(()=>({...controller,fiscalAuthorization:async(path:string,options:Parameters<AccessController['fiscalAuthorization']>[1])=>{try{return await controller.fiscalAuthorization(path,options);}finally{render(n=>n+1);}}}),[controller]);
 return <><p role="note" className="real-notice">QA com dados fictícios: respostas e assinatura simuladas, sem A1, certificado, banco ou SEFAZ. Nenhuma autorização real é demonstrada.</p><label>Modelo de teste <select value={model} disabled={busy} onChange={e=>{if(!busy)setModel(e.target.value as '55'|'65');}}><option value="55">NF-e 55</option><option value="65">NFC-e 65</option></select></label><p>Prévia: {fixture.counts.preview} · Histórico: {fixture.counts.history} · Consulta de comando: {fixture.counts.command} · Ações proibidas: {fixture.counts.forbidden}</p><FiscalAuthorization key={model} controller={port} candidate={fixture.candidate(model)} onBusy={setBusy}/></>;
}
