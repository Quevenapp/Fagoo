import {useEffect,useRef,useState} from 'react';
import {AccessError,type NativeRequestOptions} from '../lib/real-access';
import {parseMfaResetAnswer} from '../../../../packages/erp-domain/src/access-security.mjs';
import {Modal} from './Modal';
import {userSecurityPath,parseUserSecurity,type SystemController,type UserSecurity} from '../lib/system-model';

export type SecurityView='historico'|'dispositivos'|'seguranca';
export const SECURITY_TITLES:Record<SecurityView,string>={historico:'Histórico do segundo fator',dispositivos:'Dispositivos utilizados',seguranca:'Segurança do usuário'};
const aborted=(e:unknown)=>e instanceof DOMException&&e.name==='AbortError';
const moment=(value:string|null)=>value?new Date(value).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo',dateStyle:'short',timeStyle:'short'}):'—';

/** Sistema > Usuários, menu ⋮ of the row (migration 151): read-only views of the Supabase Auth sessions and second factor. */
export function UserSecurityModal({controller,reset,userId,label,view,onClose}:{controller:Pick<SystemController,'system'>;reset?:((path:string,options?:NativeRequestOptions)=>Promise<unknown>)|null;userId:string;label:string;view:SecurityView;onClose:()=>void}){
 const [data,setData]=useState<UserSecurity|null>(null),[error,setError]=useState(''),[reload,setReload]=useState(0);
 // Leva H (PRF-209): Redefinir segundo fator (administrador numa sessão aal2; o mesmo comando é reenviado até ser confirmado).
 const command=useRef<string|null>(null),[resetState,setResetState]=useState<'idle'|'confirm'|'busy'>('idle'),[resetMessage,setResetMessage]=useState('');
 const runReset=async()=>{if(!reset||resetState==='busy')return;const id=command.current??crypto.randomUUID();command.current=id;setResetState('busy');setResetMessage('');
  try{const answer=parseMfaResetAnswer(await reset(`/v1/seguranca/usuarios/${userId}/redefinir-mfa`,{method:'POST',body:{command_id:id}}),{commandId:id,target:userId});command.current=null;setResetState('idle');
   setResetMessage(answer.removed?`Segundo fator redefinido (${answer.removed} cadastro(s) removido(s)). No próximo acesso o usuário cadastra um novo aplicativo.`:'O usuário não tinha aplicativo autenticador cadastrado.');setReload(n=>n+1);}
  catch(e){if(!(e instanceof AccessError&&e.status===503))command.current=null;setResetState('idle');
   setResetMessage(e instanceof AccessError?(e.code==='ERP_MFA_REQUIRED'?'Confirme o seu próprio código do aplicativo autenticador nesta sessão (Minha conta › Alterar senha e segundo fator) antes de redefinir o de outro usuário.':e.status===503?'A redefinição foi registrada, mas a remoção no Auth ficou sem confirmação. Clique de novo para concluir.':e.status===403?'Somente administradores redefinem o segundo fator, e nunca o próprio.':'Não foi possível redefinir agora.'):'Não foi possível redefinir agora.');}};
 useEffect(()=>{const p=new AbortController();setData(null);setError('');void controller.system(userSecurityPath(userId),{method:'GET',signal:p.signal}).then(raw=>{if(!p.signal.aborted)setData(parseUserSecurity(raw,userId));})
  .catch(e=>{if(!p.signal.aborted&&!aborted(e))setError('Não foi possível consultar a segurança deste usuário.');});return()=>p.abort();},[controller,userId,reload]);
 return <Modal title={`${SECURITY_TITLES[view]} · ${label}`} onClose={onClose} actions={<button type="button" className="secondary-button" onClick={onClose}>Fechar</button>}>
  {error&&<p className="real-alert" role="alert">{error}</p>}{!data&&!error&&<p role="status">Consultando…</p>}
  {data&&view==='historico'&&(data.challenges.length?<table className="data-table"><thead><tr><th scope="col">Data</th><th scope="col">Tentativa</th><th scope="col">Ação</th><th scope="col">Válido</th></tr></thead>
   <tbody>{data.challenges.map((c,i)=><tr key={i}><td>{moment(c.created_at)}</td><td>{c.ip??'—'}</td><td>Verificação {c.type==='totp'?'por aplicativo autenticador':c.type??'do segundo fator'}</td><td>{c.valid?'Sim':'Não'}</td></tr>)}</tbody></table>
   :<p className="empty-state">Nenhuma verificação do segundo fator registrada.</p>)}
  {data&&view==='dispositivos'&&(data.sessions.length?<table className="data-table"><thead><tr><th scope="col">Último acesso</th><th scope="col">Ip</th><th scope="col">Dispositivo</th></tr></thead>
   <tbody>{data.sessions.map((s,i)=><tr key={i}><td>{moment(s.last_access)}</td><td>{s.ip??'—'}</td><td>{s.device||'—'}</td></tr>)}</tbody></table>:<p className="empty-state">Nenhuma sessão ativa registrada para este usuário.</p>)}
  {data&&view==='seguranca'&&<dl className="user-security">
   <div><dt>MFA</dt><dd><span className={`status-badge ${data.mfa?'status-success':'status-neutral'}`}>{data.mfa?'Ativo':'Inativo'}</span></dd></div>
   <div><dt>Sessões</dt><dd>{data.sessions.length.toLocaleString('pt-BR')} registrada(s)</dd></div>
   {resetMessage&&<p className="real-notice" role="status">{resetMessage}</p>}
   {reset&&data.mfa&&(resetState==='confirm'?<div className="real-alert"><p>Redefinir o segundo fator de {label}? Use quando a pessoa perdeu o celular. O aplicativo atual deixa de valer e ela cadastra outro no próximo acesso.</p>
    <div className="real-editor-actions"><button type="button" className="secondary-button" onClick={()=>setResetState('idle')}>Cancelar</button><button type="button" className="primary-button" onClick={()=>void runReset()}>Redefinir</button></div></div>
    :<button type="button" className="secondary-button" disabled={resetState==='busy'} onClick={()=>command.current?void runReset():setResetState('confirm')}>{resetState==='busy'?'Redefinindo…':command.current?'Concluir redefinição':'Redefinir segundo fator'}</button>)}
   <p className="real-help">A exigência do segundo fator para a empresa fica em Minha conta › Alterar senha e segundo fator. Encerrar as sessões de outro usuário não existe no FAGOO; desativar o acesso dele vale na próxima ação.</p></dl>}
 </Modal>;
}
