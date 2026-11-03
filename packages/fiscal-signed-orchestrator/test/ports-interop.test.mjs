import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,hash} from './fixture.mjs';
import {createFiscalSignedRpc} from '../../fiscal-signed-rpc/src/rpc.mjs';
import {createFiscalArtifactStorage} from '../../fiscal-artifact-storage/src/storage.mjs';
const projectUrl='https://abcdefghijklmnopqrst.supabase.co',serviceKey='SYNTHETIC_SERVICE_ONLY_NOT_REAL';
test('real050 through injected RPC and Storage HTTP ports signs once and recovers a missing finish ACK',{timeout:15000},async()=>{
 const f=await fixture({model:'65'});let lost=false,finish=0,puts=0;
 const fetchImpl=async(url,o)=>{
  assert.equal(o.redirect,'manual');assert.equal(o.headers.Authorization,'Bearer '+serviceKey);assert.equal(o.headers.apikey,serviceKey);assert.ok(o.signal instanceof AbortSignal);assert.equal(o.signal.aborted,false);
  const u=new URL(url);assert.equal(u.origin,projectUrl);assert.equal(u.search,'');
  if(u.pathname.startsWith('/rest/v1/rpc/')){
   assert.equal(o.method,'POST');const name=u.pathname.slice('/rest/v1/rpc/'.length),args=JSON.parse(Buffer.from(o.body).toString('utf8'));
   try{const data=await f.callSql(name,args);if(name.endsWith('_finish')){finish++;if(!lost){lost=true;throw Error('SYNTHETIC_FINISH_ACK_LOST');}}return Response.json(data);}
   catch(e){if(e.message==='SYNTHETIC_FINISH_ACK_LOST')throw e;return Response.json({code:e.code,message:'PRIVATE_DIAGNOSTIC_NOT_EXPOSED'},{status:400});}
  }
  const download=u.pathname.startsWith('/storage/v1/object/authenticated/brufap-fiscal-artifacts/'),prefix=download?'/storage/v1/object/authenticated/brufap-fiscal-artifacts/':'/storage/v1/object/brufap-fiscal-artifacts/';assert.ok(u.pathname.startsWith(prefix));const key=u.pathname.slice(prefix.length);
  if(download){assert.equal(o.method,'GET');const bytes=f.files.get(key);return bytes?new Response(Buffer.from(bytes),{headers:{'content-type':'application/octet-stream','content-length':String(bytes.length)}}):Response.json({code:'NoSuchKey'},{status:404});}
  assert.equal(o.method,'POST');assert.equal(o.headers['x-upsert'],'false');const bytes=Buffer.from(o.body);assert.equal(hash(bytes),key.split('/').at(-1).slice(0,-4));puts++;
  if(f.files.has(key))return Response.json({error:'Duplicate'},{status:400});f.files.set(key,bytes);await f.db.query('insert into storage.objects values($1,$2,$3::jsonb)',['brufap-fiscal-artifacts',key,JSON.stringify({size:bytes.length,mimetype:'application/octet-stream'})]);return Response.json({Key:key});
 };
 try{
  const rpc=createFiscalSignedRpc({projectUrl,serviceKey,fetchImpl}),storage=createFiscalArtifactStorage({projectUrl,serviceKey,fetchImpl});
  const result=await f.orchestrator({rpc,storage}).run(f.input);assert.equal(result.status,'stored',JSON.stringify(result));assert.equal(result.recovered,true);assert.equal(result.current.artifact_current,true);assert.equal(result.can_transmit,false);assert.equal(finish,1);assert.equal(puts,1);assert.equal(f.calls.custody.length,1);
  assert.equal((await f.orchestrator({rpc,storage}).run(f.input)).status,'stored');assert.equal(f.calls.custody.length,1);assert.equal(finish,1);assert.equal(puts,1);
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE_|SYNTHETIC_SERVICE|credential_id|certificate_fingerprint|lease_id|key_id|<NFe|cnpj/);
 }finally{await f.close();}
});
