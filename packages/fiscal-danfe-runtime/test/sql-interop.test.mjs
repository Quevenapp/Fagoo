import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture as signedFixture} from '../../fiscal-signed-orchestrator/test/fixture.mjs';
import {createDanfeRuntimeHandler} from '../src/handler.mjs';
import {signRuntimeRequest,digest} from '../src/auth.mjs';
import {secret,keyId,audience,result} from './fixtures.mjs';
const request=async(id,actor)=>{
 const path=`/internal/v1/fiscal-danfe/candidates/${id}/preview`,authorization=await signRuntimeRequest({secretBytes:secret,keyId,audience,actor,nonce:randomUUID(),method:'GET',path,bodyHash:await digest(new Uint8Array())});
 return new Request('http://runtime.internal'+path,{headers:{Authorization:authorization}});
};
const snapshot=async f=>(await f.db.query(`select (select count(*) from erp_fiscal_signed.candidate)::text candidates,(select count(*) from erp_fiscal_signed.command)::text commands,(select count(*) from erp_fiscal_signed.attempt)::text attempts,(select count(*) from erp_fiscal_signed.artifact)::text artifacts,(select count(*) from storage.objects)::text objects`)).rows[0];
test('real SQL050 candidate authorization and immutable Storage interoperate for models55/65 without new mutations',async()=>{
 for(const model of ['55','65']){
  const f=await signedFixture({model});let h;
  try{
   // This synthetic fixture uses a simulated XSD report only to prepare SQL state.
   // DANFE never claims to validate XSD, signatures, taxes or authorization.
   const created=await f.orchestrator().run(f.input);assert.equal(created.status,'stored');const id=created.candidate_id,before=await snapshot(f),counts={custody:f.calls.custody.length,schema:f.calls.schema.length,put:f.calls.put.length},seen=[];
   h=createDanfeRuntimeHandler({rpc:async(name,args,opts)=>{assert.equal(name,'erp_fiscal_signed_get');seen.push(name);return f.ports.rpc(name,args,opts);},storage:{read:f.ports.storage.read},transportSecret:secret,transportKeyId:keyId,audience});
   const v=await result(await h(await request(id,f.input.actor)));assert.equal(v.model,model);assert.equal(v.source_sha256,created.artifact.sha256);assert.equal(v.current.artifact_current,true);assert.match(v.html,/SEM VALOR FISCAL/);assert.equal(v.authorization_verified,false);assert.equal(Object.hasOwn(v,'xsd_validated'),false);
   assert.deepEqual(seen,['erp_fiscal_signed_get','erp_fiscal_signed_get']);assert.deepEqual(await snapshot(f),before);assert.deepEqual({custody:f.calls.custody.length,schema:f.calls.schema.length,put:f.calls.put.length},counts);
   await result(await h(await request(id,f.users.consulta)),403);
   const denied=createDanfeRuntimeHandler({rpc:f.ports.rpc,storage:{read:async options=>{const response=await f.ports.storage.read(options);await f.db.query('update erp_access.membership set active=false where user_id=$1',[f.input.actor]);return response;}},transportSecret:secret,transportKeyId:keyId,audience});
   try{assert.equal((await result(await denied(await request(id,f.input.actor)),403)).html,undefined);}finally{denied.dispose();}
   assert.deepEqual(await snapshot(f),before);
  }finally{h?.dispose();await f.close();}
 }
});
