import {useEffect,useMemo,useState,useSyncExternalStore} from 'react';
import {createAccessController} from '../lib/real-access';
import SalesOrderReservations from '../components/SalesOrderReservations';
import {createStockReservationsQaFixture,type StockReservationQaMode} from './stock-reservations-fixture';
import {useUnsavedChangesGuard} from '../hooks/useUnsavedChanges';
import '../components/real-documents.css';
function Scenario({mode}:{mode:StockReservationQaMode}){
 const fixture=useMemo(()=>createStockReservationsQaFixture(mode),[mode]),[,render]=useState(0);
 const controller=useMemo(()=>createAccessController(fixture.auth,'https://stock.qa.invalid',async(...args)=>{try{return await fixture.fetch(...args);}finally{render(n=>n+1);}}),[fixture]);
 const state=useSyncExternalStore(controller.subscribe,controller.getSnapshot,controller.getSnapshot);useEffect(()=>controller.start(),[controller]);
 return <><p className="real-help">Consultas de histórico: {fixture.counts.history} · Prévias: {fixture.counts.preview} · Consultas de saldo: {fixture.counts.availability} · Ações recusadas: {fixture.counts.rejectedMutations}</p>{state.phase==='ready'?<section className="real-editor"><h2>Pedido 70 · Cliente fictício</h2><p>Depósito sintético central · 2 produtos e 1 serviço · Total R$ 52,00</p><SalesOrderReservations controller={controller} record={fixture.record} blocked={false} onChanged={()=>{}} onActive={()=>{}} onBusy={()=>{}} onDraft={()=>{}}/></section>:<p role="status">Carregando cenário local…</p>}</>;
}
export default function StockReservationsQA(){
 const [mode,setMode]=useState<StockReservationQaMode>('available'),guard=useUnsavedChangesGuard();
 return <div className="real-shell"><header className="real-topbar"><strong>FAGOO · QA de reservas · somente dados fictícios</strong></header><main className="real-main"><h1>Reserva de estoque por pedido</h1><p className="real-notice">Inspeção local sem rede, banco ou gravação. Consulte saldos e prepare uma prévia; não confirme reserva, liberação ou baixa. O adaptador recusa essas ações.</p><label className="form-field">Cenário de teste<select value={mode} onChange={e=>{const next=e.target.value as StockReservationQaMode;guard.confirmLeave(()=>setMode(next));}}><option value="available">Pedido disponível para reserva</option><option value="active">Pedido com reserva ativa</option><option value="consumed">Reserva já baixada — histórico</option><option value="readonly">Perfil de consulta</option></select></label><Scenario key={mode} mode={mode}/></main></div>;
}
