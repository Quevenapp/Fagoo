import {openapi} from '../src/openapi';

export function documentationHref(unitId:string){
 return `/atendimento?unit=${encodeURIComponent(unitId)}&page=api-docs`;
}
/** Only implemented delegated routes; standalone identity/update APIs never appear. */
export function managedApiOperations(unitId:string){
 if(!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(unitId))throw new Error('Unidade inválida.');
 const sections=new Set(['bots','conversations','tickets','knowledge','media','reports','presence','consents','bot-runs','events','webhook-subscriptions','webhook-deliveries','connections','groups','group-operations','calls','router','number-pools','numbers','meta-accounts','applications','keys']);
 const prefix=`/v1/communication/units/${unitId}`;
 const document=openapi('https://documentation.invalid');
 const rows:{method:string;path:string;summary:string}[]=[];
 for(const [path,operations] of Object.entries(document.paths)){
  const suffix=path.startsWith('/profiles/{profile}/')?path.slice('/profiles/{profile}'.length):/^\/(applications|keys)(\/|$)/.test(path)?path:null;
  if(!suffix || !sections.has(suffix.split('/')[1]) || /\/contacts?(?:\/|$)/.test(suffix))continue;
  for(const [method,operation] of Object.entries(operations as Record<string,any>)){
   if(!['get','post','put','patch','delete'].includes(method))continue;
   rows.push({method:method.toUpperCase(),path:prefix+suffix,summary:String(operation.summary || '').replaceAll('Wabotia','Fagoo')});
  }
 }
 return rows;
}
