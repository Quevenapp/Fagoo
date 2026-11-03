import { useEffect, useState } from 'react';
import type { NativeRequestOptions } from '../lib/real-access';
import { readCopyOrigin, type DocumentCopyOrigin as Origin } from '../lib/document-copy-model';
import type { DocumentRecord } from '../lib/real-documents-model';

export default function DocumentCopyOrigin({request,record,blocked,onOpen}:{request:(path:string,options?:NativeRequestOptions)=>Promise<unknown>;record:DocumentRecord;blocked:boolean;onOpen:(id:string)=>void}){
 const [value,setValue]=useState<Origin|null>(null),[error,setError]=useState(false),[reload,setReload]=useState(0);
 useEffect(()=>{const abort=new AbortController();setValue(null);setError(false);void request(`/v1/duplicacao-documentos/${record.kind}/${record.id}/origin`,{signal:abort.signal}).then(result=>{if(!abort.signal.aborted)setValue(readCopyOrigin(result,record));}).catch(()=>{if(!abort.signal.aborted)setError(true);});return()=>abort.abort();},[request,record.id,record.kind,reload]);
 if(error)return <p className="real-help" role="status">Não foi possível conferir a origem deste documento. <button type="button" className="text-button" disabled={blocked} onClick={()=>{if(!blocked)setReload(value=>value+1);}}>Conferir origem novamente</button></p>;
 if(!value?.copy_source)return null;
 return <p className="real-help">Criado como novo a partir do documento {value.copy_source.number}, versão {value.copy_source.version}. <button type="button" className="text-button" disabled={blocked} onClick={()=>{if(!blocked)onOpen(value.copy_source!.id);}}>Abrir documento de origem</button></p>;
}
