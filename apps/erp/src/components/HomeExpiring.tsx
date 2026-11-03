import {useEffect,useState} from 'react';
import {Link} from 'react-router-dom';
import {EXPIRING_PATH,parseExpiring,type ExpiringView} from '../lib/system-model';
import type {NativeRequestOptions} from '../lib/real-access';
import {Icon} from './Icon';

type Port={system?:(path:string,options?:NativeRequestOptions)=>Promise<unknown>};
/** Roles that read products (erp_catalog.allowed): only they see the alert, and the server checks again. */
export const EXPIRY_ROLES=['admin','consulta','vendas','estoque','fiscal'];
const brDate=(value:string)=>value.split('-').reverse().join('/');

/** Página inicial: "Produtos próximos da validade" (migration 187). Products whose Data de validade is up to the days of
 * Preferências › Cadastros › Configurações de produtos, already expired included. Nothing is shown when no product is due;
 * the page is keyed by actor and role, so a late answer of another session never appears here. */
export function HomeExpiring({controller,role}:{controller:Port;role:string|undefined}){
 const [view,setView]=useState<ExpiringView|null>(null);
 const allowed=typeof controller.system==='function'&&Boolean(role&&EXPIRY_ROLES.includes(role));
 useEffect(()=>{setView(null);if(!allowed)return;const p=new AbortController();
  void controller.system!(EXPIRING_PATH,{method:'GET',signal:p.signal}).then(raw=>{if(!p.signal.aborted)setView(parseExpiring(raw));}).catch(()=>{/* The alert stays hidden; the home keeps working. */});
  return()=>p.abort();},[controller,allowed]);
 if(!view||view.total===0)return null;
 return <section className="home-expiring" aria-labelledby="home-expiring-title">
  <h2 id="home-expiring-title"><Icon name="triangle-exclamation" size={13}/>Produtos próximos da validade</h2>
  <p className="real-help">Data de validade até {view.days===0?'hoje':`${view.days} dia(s) a partir de hoje`} (Preferências › Cadastros › Configurações de produtos), inclusive as já vencidas.</p>
  <div className="table-scroll" role="region" aria-label="Produtos próximos da validade" tabIndex={0}><table className="data-table"><thead><tr><th scope="col">Código</th><th scope="col">Produto</th><th scope="col">Validade</th></tr></thead>
   <tbody>{view.items.map(item=><tr key={item.product_id}><td>{item.code??'—'}</td><td>{item.name}</td><td>{brDate(item.expiry_date)}{item.expired&&<> <span className="status-badge status-danger">Vencido</span></>}</td></tr>)}</tbody></table></div>
  {view.total>view.items.length&&<p className="real-help">Mostrando os {view.items.length} primeiros de {view.total} produtos.</p>}
  <Link to="/cadastros-reais?cadastro=products" className="text-button">Ver produtos<Icon name="right" size={10}/></Link>
 </section>;
}
