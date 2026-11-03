import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {createQaDatabaseQueue} from './serial-database.mjs';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
const turn=()=>new Promise(resolve=>setImmediate(resolve));

test('QA queue keeps SET ROLE/query/RESET atomic and Storage inserts outside the RPC role',async()=>{
 const db=new PGlite(),enqueue=createQaDatabaseQueue(),entered=deferred(),release=deferred(),events=[];
 try{
  await db.exec('create role service_role;create table qa_storage(id integer primary key,writer text not null);');
  const scalar=async sql=>(await db.query(sql)).rows[0].value,owner=await scalar('select current_user::text value');
  const first=enqueue(async()=>{await db.exec('set role service_role');events.push('first:role');entered.resolve();await release.promise;try{const role=await scalar('select current_user::text value');events.push('first:query');return role;}finally{await db.exec('reset role');events.push('first:reset');}});
  await entered.promise;
  const second=enqueue(async()=>{await db.exec('set role service_role');events.push('second:role');try{return await scalar('select current_user::text value');}finally{await db.exec('reset role');events.push('second:reset');}});
  const storage=enqueue(async()=>{events.push('storage');await db.exec('insert into qa_storage values(1,current_user)');return scalar('select writer value from qa_storage where id=1');});
  await turn();assert.deepEqual(events,['first:role']);release.resolve();
  assert.deepEqual(await Promise.all([first,second,storage]),['service_role','service_role',owner]);
  assert.deepEqual(events,['first:role','first:query','first:reset','second:role','second:reset','storage']);assert.equal(await scalar('select current_user::text value'),owner);await enqueue.drain();
 }finally{release.resolve();await enqueue.drain();await db.close();}
});

test('a failed RPC resets its role and cannot poison later queued operations',async()=>{
 const db=new PGlite(),enqueue=createQaDatabaseQueue();try{
  await db.exec('create role service_role;');const owner=(await db.query('select current_user::text value')).rows[0].value;
  const failed=enqueue(async()=>{await db.exec('set role service_role');try{await db.query('select 1/0');}finally{await db.exec('reset role');}});
  const next=enqueue(async()=>(await db.query('select current_user::text value')).rows[0].value);
  await assert.rejects(()=>failed,e=>e.code==='22012');assert.equal(await next,owner);await enqueue.drain();
  const values=await Promise.all(Array.from({length:20},(_,index)=>enqueue(async()=>index)));assert.deepEqual(values,Array.from({length:20},(_,index)=>index));
 }finally{await enqueue.drain();await db.close();}
});
