/** Production read composition. No synthetic binding, writer, custody, transport or validator port. */
import {AuthorizationServiceError,data,need,freeze} from './service-common.mjs';
import {createAuthorizationReadPorts,createAuthorizationReadOperations} from './read-operations.mjs';
const READ_RPC=new Set(['erp_fiscal_signed_get','erp_fiscal_authorization_preview','erp_fiscal_authorization_command','erp_fiscal_authorization_history']);
export function createAuthorizationReadService(configuration){
 const c=data(configuration,['rpc','storage']),storage=data(c.storage,['read']);need(typeof c.rpc==='function'&&typeof storage.read==='function');
 const rpcPort=c.rpc,readPort=storage.read;
 const ports=createAuthorizationReadPorts((name,args,options)=>{need(READ_RPC.has(name),'AUTHORIZATION_RPC_UNSUPPORTED');return rpcPort(name,args,options);},readPort);
 const readers=createAuthorizationReadOperations({...ports,serviceEnabled:false});
 const unavailable=()=>{throw new AuthorizationServiceError('AUTHORIZATION_OPERATIONAL_BINDING_UNAVAILABLE');};
 return freeze({preview:readers.preview,command:readers.command,history:readers.history,
  run:unavailable,
  async recover(input,options={}){
   // Check current ACL, actor and command existence first. No claim of recovery,
   // state change or journal interpretation is made without the reviewed binding.
   await readers.command(input,options);unavailable();
  },
 });
}
