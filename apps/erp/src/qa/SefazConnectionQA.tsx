import {useMemo,useSyncExternalStore} from 'react';
import SefazConnection from '../components/SefazConnection';
import type {AccessController} from '../lib/real-access';
import type {WsdlQaFixture} from './wsdl-fixture';

/** Only imported by qa.tsx. The real controller/client uses the intercepted synthetic transport. */
export default function SefazConnectionQA({controller,fixture}:{controller:AccessController;fixture:WsdlQaFixture}){
 const counts=useSyncExternalStore(fixture.subscribe,fixture.getSnapshot);
 const adapted=useMemo(()=>({getSnapshot:controller.getSnapshot,wsdl:controller.wsdl,a1:fixture.a1,company:fixture.company}),[controller,fixture]);
 return <><aside className="real-notice" role="note" aria-label="Cenários fictícios WSDL">
  <strong>QA local · somente dados fictícios. Nenhum certificado ou serviço SEFAZ é utilizado.</strong>
  <p>NF-e: a resposta do POST é perdida após registrar o resultado; a primeira consulta GET também falha. Clique duas vezes, em sequência, em Conferir resultado. NFC-e: sucesso normal.</p>
  <div aria-live="polite" data-testid="qa-wsdl-counters">
   <p data-testid="qa-wsdl-55">NF-e 55 — POST: {counts.nf55.post} · GET: {counts.nf55.get} · registros: {counts.nf55.records}</p>
   <p data-testid="qa-wsdl-65">NFC-e 65 — POST: {counts.nf65.post} · GET: {counts.nf65.get} · registros: {counts.nf65.records}</p>
  </div>
  <p>Recarregar esta página zera os cenários e os contadores. Os resultados desta tela são simulados, sem validação de conectividade.</p>
 </aside><SefazConnection controller={adapted}/></>;
}
