/** Local import boundary. Never wrap a fetch, token request or a call into the loaded module. */
export const APP_UPDATE_REQUIRED = 'APP_UPDATE_REQUIRED' as const;
export const APP_UPDATE_MESSAGE = 'Não foi possível carregar esta etapa. Atualize a página quando for seguro para tentar novamente.';
export type AppImportFailure = Error & Readonly<{code:typeof APP_UPDATE_REQUIRED;request_dispatched:false}>;
const failures = new WeakSet<object>();

/**
 * The loader must contain ONLY a dynamic import, before any application request.
 * The marker describes this invocation; it does not cancel or disprove a prior command.
 * No original error, URL, response, body or credentials are retained.
 */
export async function importBeforeDispatch<T>(loader:()=>Promise<T>):Promise<T>{
 try{return await loader();}
 catch{
  const error=Object.assign(new Error(APP_UPDATE_MESSAGE),{name:'AppImportFailure',code:APP_UPDATE_REQUIRED,request_dispatched:false as const});
  failures.add(error);Object.freeze(error);throw error;
 }
}
export function isAppImportFailure(value:unknown):value is AppImportFailure{
 return typeof value==='object'&&value!==null&&failures.has(value);
}

/** Notify once for any Vite chunk/preload failure. No reload, suppression or state clearing. */
export function observePreloadFailures(target:Pick<EventTarget,'addEventListener'|'removeEventListener'>,onNotice:()=>void):()=>void{
 let reported=false,active=true;
 const listener=()=>{if(!active||reported)return;reported=true;try{onNotice();}catch{/* A notice must not mask the original import failure. */}};
 target.addEventListener('vite:preloadError',listener);
 return()=>{active=false;target.removeEventListener('vite:preloadError',listener);};
}
