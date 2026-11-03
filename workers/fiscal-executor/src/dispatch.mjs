import {mutationPath as authorizationMutationPath} from '../../../packages/fiscal-authorization-runtime/src/review-protocol.mjs';
import {createUnsignedExecutor} from '../../../packages/fiscal-unsigned-runtime/src/handler.mjs';
/** One private service binding, separate execution paths. Unsigned requests never start a container. */
export function createExecutorDispatch({fetchImpl,createUnsigned=createUnsignedExecutor}={}){
 const handlers=new WeakMap();
 return async(request,env)=>{
  let unsigned=false,kind='A1',path='';
  try{
   path=new URL(request.url).pathname;
   if(path==='/internal/v1/fiscal-authorization'||path.startsWith('/internal/v1/fiscal-authorization/'))kind='AUTHORIZATION';
   else if(path==='/internal/v1/fiscal-danfe'||path.startsWith('/internal/v1/fiscal-danfe/'))kind='DANFE';
   else if(path==='/internal/v1/fiscal-reconciliation'||path.startsWith('/internal/v1/fiscal-reconciliation/'))kind='RECONCILIATION';
   else if(path==='/internal/v1/fiscal-wsdl'||path.startsWith('/internal/v1/fiscal-wsdl/'))kind='WSDL';
   else if(path==='/internal/v1/fiscal-signed'||path.startsWith('/internal/v1/fiscal-signed/'))kind='SIGNED';
   if(path==='/internal/v1/fiscal-unsigned'||path.startsWith('/internal/v1/fiscal-unsigned/')){
    unsigned=true;
    let handler=handlers.get(env);
    if(!handler){handler=createUnsigned(env,fetchImpl);handlers.set(env,handler);}
    return await handler(request);
   }
   return await env.A1_CONTAINER.getByName('a1-custody-v1').fetch(request);
  }catch{return Response.json({error:unsigned?'UNSIGNED_RUNTIME_FAILED':`${kind}_UPSTREAM_UNAVAILABLE`,recovery_required:kind!=='DANFE'&&(kind!=='AUTHORIZATION'||authorizationMutationPath(path,request.method))&&request.method==='POST'&&(kind!=='RECONCILIATION'||['/internal/v1/fiscal-reconciliation/run','/internal/v1/fiscal-reconciliation/recover'].includes(path))},
   {status:503,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});}
 };
}
