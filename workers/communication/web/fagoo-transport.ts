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
