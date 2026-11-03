import { isConfiguredBackendOrigin } from '../../backend-config/src/origin.mjs';
/** Private089 composition. No environment, HTTP input, source fallback or automatic query. */
import {fileURLToPath} from 'node:url';
import {request} from 'node:https';
import {createReceiptQueryRpc} from '../../fiscal-authorization/src/receipt-query-rpc.mjs';
import {createAuthorizationStorage} from '../../fiscal-authorization/src/storage.mjs';
import {createAuthorizationValidator} from '../../fiscal-authorization/src/validator.mjs';
import {createReceiptQuerySource} from '../../fiscal-authorization/src/receipt-query-source.mjs';
import {captureReceiptQuerySourceInput,projectReceiptQuerySource} from '../../fiscal-authorization/src/receipt-query-evidence.mjs';
import {captureReceiptQueryRpc,projectReceiptQueryLedger} from '../../fiscal-authorization/src/receipt-query-ledger-dto.mjs';
import {createReceiptQueryStorage} from '../../fiscal-authorization/src/receipt-query-storage.mjs';
import {createReceiptValidator} from '../../fiscal-authorization/src/receipt-validator.mjs';
import {createSpReceiptQueryTlsLoader} from '../../fiscal-authorization/src/receipt-query-server-trust.mjs';
import {createReceiptQueryPreparationAuthorizer} from '../../fiscal-authorization/src/receipt-query-preparation.mjs';
import {createReceiptQueryCustodyPort} from '../../fiscal-authorization/src/receipt-query-custody.mjs';
import {createReceiptQueryTransport} from '../../fiscal-authorization/src/receipt-query-transport.mjs';
import {createReceiptQueryService} from '../../fiscal-authorization/src/receipt-query-service.mjs';
import {createAuthorizationVaultReader} from './authorization-vault-read.mjs';

const factories=Object.freeze({
 rpc:createReceiptQueryRpc,authorizationStorage:createAuthorizationStorage,
 authorizationValidator:createAuthorizationValidator,source:createReceiptQuerySource,
 queryStorage:createReceiptQueryStorage,receiptValidator:createReceiptValidator,
 tlsLoader:createSpReceiptQueryTlsLoader,vaultReader:createAuthorizationVaultReader,
 preparation:createReceiptQueryPreparationAuthorizer,custody:createReceiptQueryCustodyPort,
 transport:createReceiptQueryTransport,service:createReceiptQueryService,
});
const fail=()=>{throw new Error('RECEIPT_QUERY_RUNTIME_CONFIGURATION_INVALID');};
function object(raw,required,optional=[]){
 if(!raw||![Object.prototype,null].includes(Object.getPrototypeOf(raw)))fail();
 const ds=Object.getOwnPropertyDescriptors(raw),keys=Reflect.ownKeys(ds);
 if(!required.every(k=>Object.hasOwn(ds,k))||!keys.every(k=>typeof k==='string'&&[...required,...optional].includes(k)&&Object.hasOwn(ds[k],'value')))fail();
 return Object.fromEntries(keys.map(k=>[k,ds[k].value]));
}
function configuration(raw){
 const p=object(raw,['projectUrl','serviceKey','fetchImpl','keyring','binaryPath'],['allowLegacy','enabled','supabaseDeployment']);
 if(!isConfiguredBackendOrigin(p.projectUrl,p.supabaseDeployment)||
    typeof p.serviceKey!=='string'||p.serviceKey.length<20||p.serviceKey.length>8192||! /^[!-~]+$/.test(p.serviceKey)||
    typeof p.fetchImpl!=='function'||typeof p.binaryPath!=='string'||!/^\/[^\u0000\r\n]{1,1023}$/.test(p.binaryPath)||
    (p.enabled!==undefined&&typeof p.enabled!=='boolean')||(p.allowLegacy!==undefined&&typeof p.allowLegacy!=='boolean'))fail();
 let entries;try{entries=Array.from(Map.prototype.entries.call(p.keyring));}catch{fail();}
 if(entries.length<1||entries.length>5||!entries.every(([id,key])=>typeof id==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(id)&&key instanceof Uint8Array&&key.byteLength===32))fail();
 // Snapshot membership before the asynchronous loader. Key bytes stay caller-owned;
 // custody copies and erases them for each operation, and shutdown can erase originals.
 return Object.freeze({...p,keyring:new Map(entries),enabled:p.enabled===true,allowLegacy:p.allowLegacy===true});
}

/** The second argument contains trusted local test factories only. Never pass request/env objects. */
export async function createReceiptQueryComposition(raw,trustedFactories={}){
 const p=configuration(raw),overrides=object(trustedFactories,[],Object.keys(factories));
 if(!Object.values(overrides).every(v=>typeof v==='function'))fail();
 const f=Object.freeze({...factories,...overrides});
 const connection=Object.freeze({projectUrl:p.projectUrl,...(p.supabaseDeployment===undefined?{}:{supabaseDeployment:p.supabaseDeployment}),serviceKey:p.serviceKey,fetchImpl:p.fetchImpl});
 const rpc=f.rpc(connection),historical=f.authorizationStorage(connection),storage=f.queryStorage(connection);
 const validateProcessed=f.authorizationValidator(Object.freeze({
  pythonPath:'/opt/fiscal-validator/bin/python3',
  validatorPath:fileURLToPath(new URL('../../fiscal-authorization/validator.py',import.meta.url)),
 }));
 const readSource=f.source(Object.freeze({
  async readSource(rawInput,options){
   const input=captureReceiptQuerySourceInput(rawInput);
   const args=captureReceiptQueryRpc('context',{p_user_id:input.actor,p_source_kind:input.sourceKind,p_source_command_id:input.sourceCommandId,p_expected_attempt_id:input.authorizationAttemptId});
   const view=projectReceiptQueryLedger('context',await rpc('context',args,options),args);
   // This also checks the authorization command omitted from the context RPC arguments.
   return projectReceiptQuerySource(view.source,input);
  },
  readObject:historical.read,validate:validateProcessed,
 }));
 const validate=f.receiptValidator(Object.freeze({
  pythonPath:'/opt/fiscal-validator/bin/python3',
  validatorPath:fileURLToPath(new URL('../../fiscal-authorization/receipt-validator.py',import.meta.url)),
 }));
 const authorizePreparation=f.preparation(Object.freeze({rpc}));
 const readObject=f.vaultReader(connection);
 const loader=await f.tlsLoader(Object.freeze({binaryPath:p.binaryPath,allowLegacy:p.allowLegacy,timeoutMs:5000}));
 const withPreparedSession=f.custody(Object.freeze({readObject,loader,keyring:p.keyring,authorizePreparation}));
 const transport=f.transport(Object.freeze({requestImpl:request}));
 const service=f.service(Object.freeze({rpc,readSource,storage,validate,validateProcessed,withPreparedSession,transport,enabled:p.enabled}));
 const methods=object(service,['context','history','command','run','recover']);
 if(!Object.values(methods).every(v=>typeof v==='function'))fail();
 return Object.freeze({service:Object.freeze(methods),enabled:p.enabled});
}
