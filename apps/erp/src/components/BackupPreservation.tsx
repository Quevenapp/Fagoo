import {useEffect,useRef,useState,useSyncExternalStore} from 'react';
import type {AccessController} from '../lib/real-access';
import {BACKUP_IMPORT_BASE,backupCapabilities,prepareBackupBundle,uploadBackupBundle,type BackupBundle,type BackupCapabilities,type BackupProgress,type BackupResult} from '../lib/backup-import';
import {useUnsavedChanges} from '../hooks/useUnsavedChanges';

export default function BackupPreservation({controller,onComplete}:{controller:AccessController;onComplete:()=>void}){
  const access=useSyncExternalStore(controller.subscribe,controller.getSnapshot,controller.getSnapshot);
  const admin=access.phase==='ready'&&access.membership?.role==='admin',actor=access.membership?.user_id;
  const [cap,setCap]=useState<BackupCapabilities|null>(null),[file,setFile]=useState<File|null>(null),[bundle,setBundle]=useState<BackupBundle|null>(null);
  const [busy,setBusy]=useState(false),[progress,setProgress]=useState<BackupProgress|null>(null),[message,setMessage]=useState(''),[result,setResult]=useState<BackupResult|null>(null),[attempted,setAttempted]=useState(false);
  const operation=useRef<AbortController|null>(null),selection=useRef(0),mounted=useRef(true);
  const stoppedMessage='O acompanhamento parou. A conferência já iniciada pode continuar. Retome este mesmo pacote para confirmar o resultado.';
  useUnsavedChanges(Boolean(file&&!result),busy);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;operation.current?.abort();};},[]);
  useEffect(()=>{
    operation.current?.abort();operation.current=null;selection.current++;setCap(null);setFile(null);setBundle(null);setBusy(false);setResult(null);setMessage('');setProgress(null);setAttempted(false);
    if(!admin||typeof controller.backupImport!=='function')return;
    const request=new AbortController();let live=true;
    void controller.backupImport(BACKUP_IMPORT_BASE+'/capabilities',{signal:request.signal}).then(value=>{if(live&&!request.signal.aborted)setCap(backupCapabilities(value));}).catch(()=>{/* Disabled/unavailable capability never offers a write action. */});
    return()=>{live=false;request.abort();operation.current?.abort();};
  },[controller,admin,actor]);
  const active=(request:AbortController,id:number)=>mounted.current&&operation.current===request&&!request.signal.aborted&&id===selection.current&&controller.getSnapshot().phase==='ready'&&controller.getSnapshot().membership?.role==='admin'&&controller.getSnapshot().membership?.user_id===actor;
  const validate=async(chosen:File)=>{
    if(!cap||operation.current)return;const request=new AbortController(),id=++selection.current;operation.current=request;
    setFile(chosen);setBundle(null);setBusy(true);setResult(null);setMessage('');setProgress(null);setAttempted(false);
    try{const value=await prepareBackupBundle(chosen,cap,{signal:request.signal,onProgress:p=>{if(active(request,id))setProgress(p);}});if(active(request,id)){setBundle(value);setMessage('Arquivo conferido. Pronto para preservar.');}}
    catch{if(mounted.current&&operation.current===request)setMessage(request.signal.aborted?'Conferência interrompida. Você pode conferir o arquivo novamente.':'Este arquivo não corresponde ao pacote de backup autorizado ou está incompleto. Selecione o pacote preparado.');}
    finally{if(operation.current===request){operation.current=null;if(mounted.current)setBusy(false);}}
  };
  const upload=async()=>{
    if(!bundle||operation.current||!admin)return;const request=new AbortController(),id=selection.current;operation.current=request;
    setAttempted(true);setBusy(true);setMessage('');setProgress(null);
    try{const value=await uploadBackupBundle(bundle,controller.backupImport,{signal:request.signal,onProgress:p=>{if(active(request,id))setProgress(p);}});
      if(active(request,id)){setResult(value);setMessage('');onComplete();}}
    catch{if(mounted.current&&operation.current===request)setMessage(request.signal.aborted?stoppedMessage:'A confirmação não terminou. Retome com este mesmo arquivo para conferir e concluir a preservação. Os arquivos já recebidos serão reconhecidos.');}
    finally{if(operation.current===request){operation.current=null;if(mounted.current)setBusy(false);}}
  };
  if(!admin||!cap)return null;
  const labels={validating:'Conferindo arquivos',objects:'Preservando arquivos',chunks:'Registrando conteúdo',verifying_objects:'Conferindo arquivos recebidos'};
  return <section className="real-records" aria-label="Preservar backup do Origin">
    <h2>Preservar novo backup</h2><p>Selecione o pacote preparado para guardar os arquivos originais e disponibilizá-los neste histórico.</p>
    <div className="form-field"><label htmlFor="backup-preservation-file">Pacote de backup</label><input id="backup-preservation-file" type="file" accept=".zip,application/zip" disabled={busy||attempted&&!result} onChange={event=>{const chosen=event.target.files?.[0];if(chosen)void validate(chosen);}}/></div>
    {file&&<p className="real-help">{file.name} · {(file.size/1024/1024).toLocaleString('pt-BR',{maximumFractionDigits:1})} MB</p>}
    {progress&&<div role="status" aria-live="polite"><p>{labels[progress.phase]}: {progress.completed.toLocaleString('pt-BR')} de {progress.total.toLocaleString('pt-BR')}</p><progress max={Math.max(1,progress.total)} value={progress.completed}/></div>}
    <div className="button-group">{!result&&bundle&&<button type="button" className="primary-button" disabled={busy} onClick={()=>void upload()}>{attempted?'Retomar preservação':'Preservar backup'}</button>}
      {!bundle&&file&&!busy&&<button type="button" className="secondary-button" onClick={()=>void validate(file)}>Conferir arquivo novamente</button>}
      {busy&&<button type="button" className="secondary-button" onClick={()=>{operation.current?.abort();if(attempted)setMessage(stoppedMessage);}}>{progress?.phase==='verifying_objects'?'Parar acompanhamento':'Interromper envio'}</button>}</div>
    {message&&<p role="status" className="real-help">{message}</p>}
    {result&&<p role="status" className="real-notice"><strong>Backup preservado e conferido.</strong>{result.status==='stored_with_issues'?' Há pendências de estrutura para revisão no histórico.':' O conteúdo está disponível no histórico.'}</p>}
  </section>;
}
