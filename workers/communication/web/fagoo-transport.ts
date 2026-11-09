export function communicationPath(value:string,unitId:string){
 const clean=value.replace(/^\/?api\//,'');
 const root=`v1/profiles/${unitId}`;
 const prefix=`/v1/communication/units/${unitId}`;
 if(clean===root || clean.startsWith(root+'/'))return prefix+clean.slice(root.length);
 if(/^v1\/(applications|keys)(\/|$)/.test(clean))return prefix+clean.slice(2);
 if(clean===prefix || clean.startsWith(prefix+'/'))return clean;
 throw new Error('Rota de comunicação fora desta unidade.');
}
export function rawCommunicationOptions(options:RequestInit={}){
 const headers=new Headers(options.headers),contentType=headers.get('Content-Type') || undefined;
 return {method:options.method || 'GET',body:typeof options.body==='string' && contentType?.includes('application/json')?JSON.parse(options.body):options.body,contentType,idempotencyKey:headers.get('Idempotency-Key') || crypto.randomUUID(),rawResponse:true};
}
/** Keep the controller's status/code/class for recovery while presenting useful text. */
export function communicationFailure(error:any,method='GET'){
 if(error?.name==='AbortError' || error?.message!=='access_request_failed')return error;
 const reading=method==='GET' || method==='HEAD';
 const message=error.code==='COMMUNICATION_NOT_CONFIGURED'?'O atendimento ainda não está configurado nesta instalação.':
  error.code==='maintenance'?'O Fagoo está em manutenção. Tente novamente em instantes.':
  error.status===401?'Sua sessão precisa ser verificada. Entre novamente pelo Fagoo.':
  error.status===403?'Seu acesso não permite esta ação no atendimento.':
  error.status===404?'Este recurso de atendimento não está disponível.':
  error.status===409?'Este registro mudou. Confira o resultado antes de tentar novamente.':
  error.status===429?'Há muitas solicitações ao atendimento. Aguarde um instante.':
  reading?'Não foi possível atualizar o atendimento. A próxima atualização tentará novamente.':
  'Não foi possível confirmar a operação. Confira o resultado antes de tentar novamente.';
 error.message=message;
 return error;
}
