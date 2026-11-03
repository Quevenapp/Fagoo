// Real local signature/XSD, in-memory089 SQL-shaped ports; no network, database or credential use.
import assert from 'node:assert/strict';
import {receiptFixture} from '../../fiscal-authorization/test/receipt-fixtures.mjs';
import {serviceFixture} from '../../fiscal-authorization/test/receipt-query-service-fixture.mjs';
import {createProcessedReceiptQuerySource} from '../src/processed-receipt-query-source.mjs';
export async function processedReceiptQueryFixtures(){
 const f=await receiptFixture();
 return{close:()=>f.close(),async create(model='55',kind='authorization',status='100'){
  const x=serviceFixture(f,model,kind);x.state.variant={status};const run=x.input(),result=await x.service().run(run);assert.equal(result.current.state,'authorized_homologation');
  const input={actor:x.actor,sourceKind:'receipt_query',commandId:run.request.command_id},calls={command:0,source:0,read:[],validate:0,validateProcessed:0};
  const ports={rpc:async(action,args,opts)=>{assert.equal(action,'command');if(args.p_user_id!==x.actor)throw Object.assign(Error('PRIVATE'),{code:'42501'});calls.command++;return x.ports.rpc(action,args,opts);},
   readSource:async(...args)=>{calls.source++;return x.ports.readSource(...args);},storage:{read:async r=>{calls.read.push(r.key);return r.key.startsWith('receipt-queries/')?x.ports.storage.read(r):x.x.ports.readObject(r);}},
   validate:async(...args)=>{calls.validate++;return x.ports.validate(...args);},validateProcessed:async(...args)=>{calls.validateProcessed++;return x.ports.validateProcessed(...args);}};
  return{x,input,result,calls,ports,read:(patch={},options={})=>createProcessedReceiptQuerySource({...ports,...patch})(input,options)};
 }};
}
