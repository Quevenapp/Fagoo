import test from 'node:test';
import assert from 'node:assert/strict';
import {createCnabStorage} from '../src/cnab.mjs';
const config={baseUrl:'https://abcdefghijklmnopqrst.supabase.co',key:'synthetic-service-key',timeoutMs:1000};
const file={bucket:'brufap-cnab',path:'profiles/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/returns/'+('a'.repeat(64))+'.ret'};
test('already aborted CNAB storage read does not issue a network request',async()=>{
 let calls=0;const p=createCnabStorage({...config,fetchImpl:async()=>{calls++;assert.fail('No request');}});
 await assert.rejects(p.getFile({...file,signal:AbortSignal.abort()}),{status:503,code:'ERP_CNAB_STORAGE_ABORTED'});assert.equal(calls,0);
});
test('CNAB storage abort cancels the fetch signal even if the fake network ignores it',async()=>{
 const c=new AbortController();let started,seen;
 const ready=new Promise(r=>{started=r;});
 const p=createCnabStorage({...config,fetchImpl:async(_url,init)=>{seen=init.signal;started();return new Promise(()=>{});}});
 const pending=p.getFile({...file,signal:c.signal});await ready;c.abort();
 await assert.rejects(pending,{status:503,code:'ERP_CNAB_STORAGE_ABORTED'});assert.equal(seen.aborted,true);
});
test('CNAB storage abort bounds body consumption and releases the reader',async()=>{
 const c=new AbortController();let reading,cancelled=false,seen;
 const ready=new Promise(r=>{reading=r;});
 const p=createCnabStorage({...config,fetchImpl:async(_url,init)=>{seen=init.signal;return new Response(new ReadableStream({pull(){reading();return new Promise(()=>{});},cancel(){cancelled=true;}}));}});
 const pending=p.getFile({...file,signal:c.signal});await ready;await new Promise(r=>setTimeout(r,0));c.abort();
 await assert.rejects(pending,{status:503,code:'ERP_CNAB_STORAGE_ABORTED'});assert.equal(cancelled,true);assert.equal(seen.aborted,true);
});
test('CNAB storage optional signal leaves legacy byte reads unchanged',async()=>{
 const bytes=new Uint8Array([65,66]);const p=createCnabStorage({...config,fetchImpl:async()=>new Response(bytes)});
 assert.deepEqual(await p.getFile(file),bytes);
});
