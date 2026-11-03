import test from'node:test';import assert from'node:assert/strict';
import{parseWarehouseImportRoute as parse,executeWarehouseImportRoute as execute,warehouseImportMethods,WAREHOUSE_IMPORT_BASE as BASE}from'../src/origin-warehouse-import.mjs';
import{parseWarehousePage,parseWarehousePreview,parseWarehouseResult,captureWarehouseInput}from'../../../packages/erp-domain/src/origin-warehouse-import-dto.mjs';
import{ACTOR,COMMAND,source,page,preview,previewInput,input,result,deferred}from'./helpers/warehouse-import-response-fixture.mjs';
const req=(path='',body)=>new Request('https://synthetic.invalid'+BASE+path,{method:body?'POST':'GET',...(body?{headers:{'content-type':'application/json; charset=utf-8'},body:JSON.stringify(body)}:{})});
test('086 streaming body enforces elapsed time even before timers run and rejects empty chunks',async()=>{
 const original=Date.now;let now=1000;Date.now=()=>now;
 const request=stream=>new Request('https://synthetic.invalid'+BASE+'/14887671588/preview',{method:'POST',headers:{'content-type':'application/json'},body:stream,duplex:'half'});
 try{
  const bytes=new TextEncoder().encode(JSON.stringify(previewInput()));
  const stream=new ReadableStream({pull(c){now+=6000;c.enqueue(bytes);c.close();}});
  await assert.rejects(()=>parse(request(stream)),e=>e.status===408);
  const empty=new ReadableStream({pull(c){c.enqueue(new Uint8Array());}});
  await assert.rejects(()=>parse(request(empty)),e=>e.status===400);
 }finally{Date.now=original;}
});
test('086 closed routes, body limits, explicit confirmation and exact IDs',async()=>{
 assert.equal(await parse(new Request('https://synthetic.invalid/other')),null);assert.deepEqual(warehouseImportMethods(BASE+'/00120/import'),['POST']);
 for(const path of['?limit=26','?limit=01','?q=x&q=y','?after=0','/1/balance','/commands/x','/0/preview','/%31/import'])await assert.rejects(()=>parse(req(path)));
 for(const b of[{...input(),confirmed:false},{...input(),active:true},{...input(),expected_source_version:'9223372036854775808'},{...input(),secret:'x'.repeat(4096)}])await assert.rejects(()=>parse(req('/14887671588/import',b)));
 assert.equal((await parse(req('/00120/preview',previewInput()))).args.p_source_id,'00120');
});
test('086 real DTO projections bind IDs and receipt snapshots while allowing current differences',()=>{
 assert.equal(parseWarehousePage(page()).items.length,1);assert.ok(parseWarehousePreview(preview(),{sourceId:'14887671588',input:previewInput()}).can_create);
 const v=result(true);v.current.source={...v.current.source,source_hash:'c'.repeat(64),source_version:'2'};v.current.source_state='changed';v.current.record={...v.current.record,name:'Nome atual',version:2,human_edited:true};v.current.record_state='changed';assert.equal(parseWarehouseResult(v,{commandId:COMMAND,readOnly:true}).receipt.binding.record.name,'Geral sintético');
 for(const mutate of[v=>v.receipt.command_id=ACTOR,v=>v.receipt.binding.record.active=false,v=>v.receipt.binding.source.status=0,v=>v.receipt.binding.source.source_id='31',v=>v.current.record.id=ACTOR,v=>v.current.source_state='missing',v=>v.can_import_balance=true,v=>v.read_only=true,v=>v.receipt.binding.record.version=2]){const bad=result();mutate(bad);assert.throws(()=>parseWarehouseResult(bad,{commandId:COMMAND,sourceId:'14887671588',input:input()}));}
});
test('086 capture rejects accessors and returns frozen copies before awaits',async()=>{
 let gets=0;const bad={get expected_source_hash(){gets++;return'a'.repeat(64);},expected_source_version:'1'};assert.throws(()=>captureWarehouseInput(bad));assert.equal(gets,0);
 const raw=input(),captured=captureWarehouseInput(raw,true);raw.confirmed=false;assert.equal(captured.confirmed,true);assert.ok(Object.isFrozen(captured));
 const route=await parse(req('/14887671588/import',input())),hold=deferred();let sent;const enter=new Promise(r=>sent=r);const ctx={userId:ACTOR,rpc:async(name,args)=>{sent({name,args});return hold.promise;}};const work=execute(route,ctx);const call=await enter;ctx.userId=COMMAND;assert.equal(call.name,'erp_origin_warehouse_import');assert.equal(call.args.p_user_id,ACTOR);assert.ok(Object.isFrozen(call.args));hold.resolve(result());await work;
});
test('086 known atomic SQL refusals stay explicit; uncertain ACK/malformed result never becomes safe success',async()=>{
 const route=await parse(req('/14887671588/import',input()));for(const[code,status]of[['42501',403],['40001',409],['22023',400],['P0002',404]])await assert.rejects(()=>execute(route,{userId:ACTOR,rpc:()=>{throw{code,message:'PRIVATE_SQL'};}}),e=>e.status===status&&!e.message.includes('PRIVATE'));
 for(const rpc of[()=>{throw Error('PRIVATE');},()=>({...result(),payload:'PRIVATE'}),()=>new Promise(()=>{})])await assert.rejects(()=>execute(route,{userId:ACTOR,rpc,timeoutMs:5}),e=>e.status===503&&e.code==='ERP_RESULT_UNCONFIRMED');
 let getters=0;await assert.rejects(()=>execute(route,{userId:ACTOR,rpc:()=>{throw{get code(){getters++;return'40001';}};}}),e=>e.status===503);assert.equal(getters,0);
});
test('086 GET receipt lookup is read-only, single RPC, bounded and abortable; no automatic mutation retry',async()=>{
 const route=await parse(req('/commands/'+COMMAND));let calls=0;const value=await execute(route,{userId:ACTOR,rpc:(name,args)=>{calls++;assert.equal(name,'erp_origin_warehouse_command');assert.equal(args.p_command_id,COMMAND);return result(true);}});assert.equal(value.read_only,true);assert.equal(calls,1);
 const control=new AbortController();control.abort();await assert.rejects(()=>execute(route,{userId:ACTOR,signal:control.signal,rpc:()=>calls++}),e=>e.status===408);assert.equal(calls,1);
 await assert.rejects(()=>execute(route,{userId:ACTOR,rpc:()=>{throw{code:'P0002'};}}),e=>e.status===404);
});
test('086 page and source guards reject duplicate cursor, inconsistent validity and unknown side effects',()=>{
 for(const mutate of[v=>v.items.push(v.items[0]),v=>v.limit=100,v=>v.items[0].source.source_id='0',v=>v.items[0].source.is_default=1,v=>v.items[0].source.name=null,v=>v.items[0].source.valid=false,v=>v.items[0].source.last_seen_at='2026-02-30T10:00:00Z',v=>v.items[0].source.source_version='9223372036854775808',v=>v.stock_effects=true]){const raw=page();mutate(raw);assert.throws(()=>parseWarehousePage(raw));}
 const v=page(),checked=parseWarehousePage(v);v.items[0].source.name='Changed';assert.equal(checked.items[0].source.name,'Geral sintético');assert.ok(Object.isFrozen(checked.items[0].source));
});
