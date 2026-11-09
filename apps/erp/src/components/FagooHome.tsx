import { Link } from 'react-router-dom';
import type { FagooContext } from '../lib/fagoo-model';
export default function FagooHome({context}:{context:FagooContext|null}){
 if(!context)return null;const caps=new Set(context.units.flatMap(u=>u.capabilities));
 return <section className="fagoo-workspace" aria-label="Áreas do Fagoo"><div className="fagoo-module-grid">
 {(caps.has('communication.read')||caps.has('team.chat'))&&<Link className="fagoo-card" to="/atendimento">Atendimento <p>Mensagens, bots, menus e protocolos</p></Link>}
 {['queue.read','queue.operate','panel.read','ticket.issue'].some(c=>caps.has(c))&&<Link className="fagoo-card" to="/filas">Filas e painéis <p>Atendimento presencial e chamadas</p></Link>}
 {caps.has('crm.read')&&<Link className="fagoo-card" to="/crm">CRM <p>Contatos, oportunidades e tarefas</p></Link>}
 {context.role==='admin'&&<Link className="fagoo-card" to="/configurar">Configurar Fagoo <p>Assistente e modo avançado</p></Link>}
 </div>{!context.units.length&&<p>{context.role==='admin'?'Comece criando a primeira unidade no assistente.':'Nenhuma unidade foi atribuída ao seu acesso.'}</p>}</section>;
}
