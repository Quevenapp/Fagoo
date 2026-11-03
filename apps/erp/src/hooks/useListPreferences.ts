import {useEffect,useRef,useState,useSyncExternalStore} from 'react';
import {AccessError,type AccessState,type NativeRequestOptions} from '../lib/real-access';
import {listPreferencesPath,listPreferencesCommandPath} from '../lib/list-preferences-request';
import {parseListPreferences,parseListPreferencesResult,type ListPreferences,type ListFilters,type ListPreferencesSaveInput} from '../../../../packages/erp-domain/src/list-preferences.mjs';
export type {ListFilters};
export interface ListPreferencesPort{getSnapshot:()=>AccessState;subscribe:(fn:()=>void)=>()=>void;listPreferences:(path:string,options?:NativeRequestOptions)=>Promise<unknown>}
export type ListPreferencesPending='none'|'saving'|'uncertain'|'missing';
export interface ListPreferencesState{
 loading:boolean;error:string;notice:string;pending:ListPreferencesPending;commandId:string|null;
 /** Visible columns in order: the saved custom list (only columns the screen still offers), otherwise the screen defaults. */
 columns:string[];customized:boolean;
 /** Default filters saved with "Tornar padrão", or null. The screen decides how to apply them. */
 filters:ListFilters|null;
 saveColumns:(columns:readonly string[]|null)=>void;saveFilters:(filters:ListFilters|null)=>void;check:()=>void;resend:()=>void;
}
type Attempt={body:ListPreferencesSaveInput;uncertain:boolean;retryAllowed:boolean};
const aborted=(e:unknown)=>e instanceof DOMException&&e.name==='AbortError';
const ready=(s:AccessState)=>s.phase==='ready'&&Boolean(s.membership);

/**
 * Per-user list preferences (migration 116) for any Origin list: "Listagem customizada" columns and "Tornar padrão" filters.
 * One command per save (command_id), CAS on the read version, an uncertain answer kept for "Conferir resultado", and no
 * late answer applied after the user, the list or the screen changed.
 */
export function useListPreferences(controller:ListPreferencesPort,listId:string,{available,defaults}:{available:readonly string[];defaults:readonly string[]}):ListPreferencesState{
 const snapshot=useSyncExternalStore(controller.subscribe,controller.getSnapshot);
 const actor=snapshot.membership?.user_id??null,allowed=ready(snapshot);
 const alive=useRef(true),request=useRef<AbortController|null>(null),attempt=useRef<Attempt|null>(null),owner=useRef(actor);
 const [value,setValue]=useState<ListPreferences|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const [pending,setPending]=useState<ListPreferencesPending>('none'),[reload,setReload]=useState(0);
 const may=()=>{const s=controller.getSnapshot();return alive.current&&ready(s)&&s.membership!.user_id===owner.current;};
 const valid=(p:AbortController)=>may()&&!p.signal.aborted&&request.current===p;
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;request.current?.abort();attempt.current=null;};},[controller]);
 // A different user never inherits the previous user's list or command.
 useEffect(()=>{if(owner.current===actor)return;owner.current=actor;request.current?.abort();request.current=null;attempt.current=null;setPending('none');setValue(null);setError('');setNotice('');setReload(n=>n+1);},[actor]);
 useEffect(()=>{if(!allowed||!may())return;const p=new AbortController();request.current=p;setLoading(true);void(async()=>{try{
  const raw=await controller.listPreferences(listPreferencesPath(listId),{method:'GET',signal:p.signal});if(valid(p))setValue(parseListPreferences(raw,listId));
 }catch(e){if(valid(p)&&!aborted(e))setError('Não foi possível carregar a listagem customizada. A listagem padrão continua disponível.');}finally{if(request.current===p){request.current=null;setLoading(false);}}})();
  return()=>{p.abort();if(request.current===p)request.current=null;};},[controller,listId,reload,allowed]);
 const run=async(a:Attempt,post:boolean)=>{
  if(!may()||request.current||attempt.current!==a||post&&a.uncertain&&!a.retryAllowed)return;
  const p=new AbortController();request.current=p;setPending('saving');setError('');setNotice('');a.retryAllowed=false;let settled=false;
  try{
   const raw=post?await controller.listPreferences(listPreferencesPath(listId),{method:'POST',body:a.body,signal:p.signal}):await controller.listPreferences(listPreferencesCommandPath(a.body.command_id),{method:'GET',signal:p.signal});
   if(!valid(p)||attempt.current!==a)return;
   const result=parseListPreferencesResult(raw,{commandId:a.body.command_id,listId,input:a.body,lookup:!post});
   settled=true;attempt.current=null;setPending('none');setValue(result.preference);setNotice(result.replayed?'Listagem salva (comando já registrado).':'Listagem salva.');
  }catch(e){if(valid(p)&&attempt.current===a&&!aborted(e)){
   const status=e instanceof AccessError?e.status:null;settled=true;
   if(!post&&status===404){a.retryAllowed=true;setPending('missing');setError('Este comando não foi registrado. Você pode reenviar exatamente a mesma listagem.');}
   else if(post&&!a.uncertain&&status!==null&&[400,403,404,409].includes(status)){attempt.current=null;setPending('none');setError(status===409?'A listagem mudou em outra tela. Nada foi salvo; recarregue e tente de novo.':'Nada foi salvo. Confira a listagem escolhida.');if(status===409)setReload(n=>n+1);}
   else{a.uncertain=true;setPending('uncertain');setError('Não foi possível confirmar se a listagem foi salva. Confira o resultado antes de tentar de novo.');}
  }}finally{
   if(request.current===p)request.current=null;
   // Interrupted (access changed, request cancelled) with the same command still held: only its own lookup can settle it.
   if(alive.current&&attempt.current===a&&!settled){a.uncertain=true;setPending('uncertain');}
  }
 };
 const start=(columns:readonly string[]|null,filters:ListFilters|null)=>{
  if(!value||!may()||request.current||attempt.current)return;
  const a:Attempt={body:{command_id:crypto.randomUUID(),expected_version:value.version,columns:columns?[...columns]:null,filters:filters?structuredClone(filters):null},uncertain:false,retryAllowed:false};
  attempt.current=a;void run(a,true);
 };
 const saved=value?.columns?.filter(c=>available.includes(c))??[];
 return{loading,error,notice,pending,commandId:attempt.current?.body.command_id??null,
  columns:saved.length?saved:[...defaults],customized:saved.length>0,filters:value?.filters??null,
  saveColumns:columns=>start(columns&&columns.length?columns:null,value?.filters??null),
  saveFilters:filters=>start(value?.columns??null,filters&&Object.keys(filters).length?filters:null),
  check:()=>{const a=attempt.current;if(a)void run(a,false);},resend:()=>{const a=attempt.current;if(a)void run(a,true);}};
}
