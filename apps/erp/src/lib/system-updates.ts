export type UpdateAction='status'|'check'|'apply';
export type UpdateOptions={body?:unknown;signal?:AbortSignal};
export type UpdatePort={updates:(action:UpdateAction,options?:UpdateOptions)=>Promise<unknown>};
export type UpdateSnapshot={protocol:1;installed:{version:string;revision:string|null;installed_at:string|null};
 latest:{version:string;revision:string;notes:string;manifest_sha256:string}|null;update_available:boolean;cloudflare_configured:boolean;can_apply:boolean;
 status:{state:'idle'|'checking'|'queued'|'running'|'succeeded'|'failed'|'interrupted';phase:string;job_id:string|null;version:string|null;updated_at:string|null;error:string|null;recovery_required:boolean;backup_id:string|null};progress_token?:string};
export const UPDATE_STEPS=[['download','Obter a versão'],['preflight','Conferir compatibilidade'],['build','Preparar a aplicação'],['backup','Salvar backup'],['runtime','Atualizar serviços'],['database','Atualizar banco de dados'],['cloudflare','Publicar API e interface'],['verification','Verificar a instalação']] as const;
export const UPDATE_PROGRESS_KEY='fagoo:system-update-progress';
export function updateSnapshot(value:unknown):UpdateSnapshot{
 const v=value as UpdateSnapshot;
 if(v?.protocol!==1||!/^v\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(v.installed?.version||'')
  ||!['idle','checking','queued','running','succeeded','failed','interrupted'].includes(v.status?.state)
  ||typeof v.status.recovery_required!=='boolean'||typeof v.can_apply!=='boolean'||typeof v.update_available!=='boolean'||typeof v.cloudflare_configured!=='boolean')throw new Error('INVALID_UPDATE_RESPONSE');
 return v;
}
export function updateMessage(error:unknown):string{
 const code=String((error as {code?:string})?.code||'');
 if(code.includes('NOT_CONFIGURED')||code.includes('CREDENTIAL'))return 'A publicação automática ainda precisa ser configurada no servidor. Siga a etapa de ativação das atualizações no manual de instalação.';
 if(code.includes('BUSY'))return 'Já existe uma atualização em andamento. Aguarde e consulte a situação novamente.';
 if(code.includes('CHECKED_RELEASE_CHANGED'))return 'A versão disponível mudou. Verifique as atualizações novamente antes de instalar.';
 if(code.includes('RECOVERY_REQUIRED'))return 'A instalação precisa de recuperação antes de uma nova tentativa. O backup está preservado no servidor.';
 if(code.includes('FORBIDDEN')||code.includes('ACCESS_DENIED'))return 'Somente o administrador pode gerenciar as atualizações.';
 return 'Não foi possível consultar o serviço de atualização. Tente novamente em alguns instantes.';
}
export async function fetchUpdateProgress(apiUrl:string,token:string,signal:AbortSignal):Promise<UpdateSnapshot>{
 if(!/^[A-Za-z0-9_-]{43}$/.test(token))throw new Error('INVALID_PROGRESS_TOKEN');
 const response=await fetch(apiUrl+'/v1/system/updates/progress',{headers:{Authorization:'Bearer '+token},credentials:'omit',redirect:'error',cache:'no-store',signal:AbortSignal.any([signal,AbortSignal.timeout(15000)])});
 if(!response.ok||!response.body||Number(response.headers.get('content-length'))>32768)throw new Error('PROGRESS_UNAVAILABLE');
 const reader=response.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let size=0,text='';
 try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>32768)throw new Error('INVALID_UPDATE_RESPONSE');text+=decoder.decode(part.value,{stream:true});}return updateSnapshot(JSON.parse(text+decoder.decode()));}
 finally{void reader.cancel().catch(()=>{});reader.releaseLock();}
}
