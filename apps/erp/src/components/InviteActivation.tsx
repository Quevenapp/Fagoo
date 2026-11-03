import {useEffect,useRef,useState,type FormEvent} from 'react';
import type {createInviteActivation} from '../lib/invite-activation';
import {protectBeforeUnload} from '../lib/unsaved-changes-store';
import './invite-activation.css';
type Controller=ReturnType<typeof createInviteActivation>;
const issueLabels={too_short:'Use pelo menos 12 caracteres.',too_long:'Use no máximo 72 bytes; caracteres acentuados e emojis podem ocupar mais de um byte.',mismatch:'A confirmação deve ser idêntica à senha.',invalid_characters:'A senha não pode conter quebras de linha ou caracteres de controle.',rejected:'A senha foi recusada pela política de segurança. Escolha outra senha.'};
export default function InviteActivation({controller}:{controller:Controller}){
 const[state,setState]=useState(controller.getSnapshot),[password,setPassword]=useState(''),[confirmation,setConfirmation]=useState('');
 const recovery=controller.flow==='recovery';
 const pending=state.phase==='verifying'||state.phase==='saving',alive=useRef(true),form=useRef<HTMLFormElement>(null),heading=useRef<HTMLHeadingElement>(null);
 const isPending=()=>['verifying','saving'].includes(controller.getSnapshot().phase);
 const latest=useRef({pending,dirty:Boolean(password||confirmation)});latest.current={pending,dirty:Boolean(password||confirmation)};
 useEffect(()=>{alive.current=true;const update=()=>setState(controller.getSnapshot());const unsubscribe=controller.subscribe(update);update();return()=>{alive.current=false;unsubscribe();};},[controller]);
 // The controller is owned by main/pagehide, never by a StrictMode effect cleanup.
 useEffect(()=>protectBeforeUnload(window,()=>isPending()||latest.current.dirty),[]);
 useEffect(()=>{if(state.phase==='ready')form.current?.querySelector<HTMLInputElement>('input')?.focus();else if(['complete','password_unconfirmed','unavailable','invalid_link'].includes(state.phase))heading.current?.focus();},[state.phase]);
 const submit=async(event:FormEvent)=>{event.preventDefault();if(controller.getSnapshot().phase!=='ready')return;try{await controller.setPassword(password,confirmation);}finally{if(alive.current){setPassword('');setConfirmation('');}}};
 return<main className="invite-activation"><a className="activation-brand" href="/acesso" onClick={event=>{if(isPending())event.preventDefault();}} aria-disabled={pending}>FAGOO <span>ERP</span></a><section className="activation-card" aria-labelledby="activation-heading" aria-busy={pending}>
  <p className="activation-eyebrow">{recovery?'Recuperação de senha':'Acesso por convite'}</p><h1 id="activation-heading" ref={heading} tabIndex={-1}>{state.phase==='complete'?'Senha definida':state.phase==='ready'||state.phase==='saving'?'Defina sua senha':recovery?'Recupere seu acesso':'Ative sua conta'}</h1>
  <p>{recovery?'Use o link de recuperação enviado para o seu e-mail para escolher uma nova senha.':'Use o convite enviado pelo administrador. Você escolhe sua própria senha; a liberação dos dados da empresa é verificada separadamente.'}</p>
  {state.message&&<p className={state.phase==='complete'?'activation-success':'activation-message'} role={state.phase==='complete'?'status':'alert'}>{state.message}</p>}
  {state.phase==='awaiting_confirmation'&&<><p>{recovery?'Confira o link para continuar.':'Confira o convite para continuar.'} Nenhuma senha é enviada ou definida automaticamente.</p><button type="button" className="primary-button" onClick={()=>void controller.verify()}>{recovery?'Conferir link':'Conferir convite'}</button></>}
  {state.phase==='verifying'&&<p role="status">{recovery?'Conferindo o link…':'Conferindo o convite…'}</p>}
  {(state.phase==='ready'||state.phase==='saving')&&<form ref={form} onSubmit={submit}>
   <p className="activation-account">Conta confirmada: <strong>{state.email}</strong></p>
   <div className="form-field"><label htmlFor="activation-password">Nova senha</label><input id="activation-password" name="new-password" type="password" autoComplete="new-password" minLength={12} maxLength={72} required value={password} disabled={pending} aria-invalid={Boolean(state.passwordIssue)} aria-describedby="activation-password-help activation-password-error" onChange={event=>{if(controller.getSnapshot().phase==='ready')setPassword(event.target.value);}}/></div>
   <div className="form-field"><label htmlFor="activation-confirmation">Confirmar nova senha</label><input id="activation-confirmation" name="confirm-password" type="password" autoComplete="new-password" minLength={12} maxLength={72} required value={confirmation} disabled={pending} aria-invalid={state.passwordIssue==='mismatch'} aria-describedby="activation-password-error" onChange={event=>{if(controller.getSnapshot().phase==='ready')setConfirmation(event.target.value);}}/></div>
   <p id="activation-password-help" className="activation-help">Use pelo menos 12 caracteres e uma senha exclusiva. O limite é 72 bytes; acentos e emojis podem ocupar mais de um byte.</p><p id="activation-password-error" className="activation-error" role="alert">{state.passwordIssue?issueLabels[state.passwordIssue]:''}</p>
   <button type="submit" className="primary-button" disabled={pending}>{pending?'Definindo senha…':'Definir minha senha'}</button>
  </form>}
  <p className="activation-login"><a href="/acesso" aria-disabled={pending} tabIndex={pending?-1:0} onClick={event=>{if(isPending())event.preventDefault();}}>Ir para o login</a></p>
  <p className="activation-help">{recovery?'Se o link expirou ou já foi usado, peça um novo em “Esqueci minha senha” na tela de acesso.':'Se o convite expirou ou já foi usado, peça orientação ao administrador.'} Esta página não cria contas nem altera permissões.</p>
 </section></main>;
}
