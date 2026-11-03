import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {parseFinanceTransfersRoute as parse,executeFinanceTransfersRoute as execute,financeTransfersRoute,financeTransfersMethods,financeTransfersResponse,FINANCE_TRANSFERS_RESPONSE_BYTES} from '../src/finance-transfers.mjs';
import {parseFinanceRoute,executeFinanceRoute} from '../src/finance.mjs';
let db,today,yesterday,tomorrow,received;const users={};
const code=c=>e=>e.code===c;
const scalar=async(sql,args=[]) => (await db.query(sql,args)).rows[0].value;
async function rpc(name,args){
 await db.exec('SET ROLE service_role');
 try{const entries=Object.entries(args);return await scalar(`SELECT public.${name}(${entries.map(([key],i)=>`${key}=>$${i+1}`).join(',')}) AS value`,entries.map(([key,v])=>key==='p_data'?JSON.stringify(v):v));}
 finally{await db.exec('RESET ROLE');}
}
const native=(action,data,actor=users.financeiro,command=randomUUID())=>rpc('erp_finance_execute',{p_user_id:actor,p_command_id:command,p_action:action,p_data:data});
const account=async(name='Conta fictícia')=>(await native('account_save',{expected_version:0,name,kind:'cash'})).record;
const current=id=>rpc('erp_finance_get',{p_user_id:users.consulta,p_entity:'accounts',p_id:id});
const input=(a,b,extra={})=>({command_id:randomUUID(),from_account_id:a.id,to_account_id:b.id,expected_from_version:a.version,expected_to_version:b.version,amount_cents:'12345',posted_on:today,note:'Transferência interna fictícia',confirmed:true,...extra});
const post=(body,actor=users.financeiro)=>{const {command_id,...data}=body;return rpc('erp_finance_transfer_post',{p_user_id:actor,p_command_id:command_id,p_data:data});};
const get=(id,actor=users.consulta)=>rpc('erp_finance_transfer_get',{p_user_id:actor,p_id:id});
const command=(id,actor=users.financeiro)=>rpc('erp_finance_transfer_command',{p_user_id:actor,p_command_id:id});
const list=(opts={})=>rpc('erp_finance_transfer_list',{p_user_id:opts.actor??users.consulta,p_account_id:opts.account??null,p_limit:opts.limit??25,p_after:opts.after??null});
const request=(path='',method='GET',body)=>new Request('https://example.test/v1/transferencias-internas'+path,{method,headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined});
async function api(path='',method='GET',body,actor=users.financeiro){const route=await parse(request(path,method,body));return execute(route,{userId:actor,rpc});}
before(async()=>{
 db=new PGlite();await db.exec('CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;CREATE SCHEMA auth;CREATE TABLE auth.users(id uuid PRIMARY KEY);');
 for(const file of ['202610160001_origin_sync.sql','202610160002_origin_quotes_nfce.sql','202610160004_erp_access.sql','202610160006_erp_catalog.sql','202610160010_erp_finance.sql','202610160053_finance_transfers.sql'])await db.exec(await readFile(new URL('../../../supabase/migrations/'+file,import.meta.url),'utf8'));
 for(const role of ['admin','financeiro','consulta','vendas','estoque','fiscal','inactive','missing']){users[role]=randomUUID();await db.query('INSERT INTO auth.users VALUES($1)',[users[role]]);if(role!=='missing')await db.query('INSERT INTO erp_access.membership(user_id,role,active)VALUES($1,$2,$3)',[users[role],role==='inactive'?'admin':role,role!=='inactive']);}
 today=await scalar("SELECT (clock_timestamp()AT TIME ZONE'America/Sao_Paulo')::date::text AS value");
 yesterday=await scalar("SELECT ((clock_timestamp()AT TIME ZONE'America/Sao_Paulo')::date-1)::text AS value");tomorrow=await scalar("SELECT ((clock_timestamp()AT TIME ZONE'America/Sao_Paulo')::date+1)::text AS value");
});
after(async()=>db?.close());

test('053 is private, service-only and financial role is required for every read/write/replay',async()=>{
 assert.equal(await scalar("SELECT relrowsecurity AS value FROM pg_class WHERE oid='erp_finance.transfer'::regclass"),true);
 for(const role of ['anon','authenticated','service_role'])assert.equal(await scalar("SELECT has_table_privilege($1,'erp_finance.transfer','SELECT,INSERT,UPDATE,DELETE') AS value",[role]),false);
 for(const role of ['anon','authenticated'])for(const signature of ['erp_finance_transfer_post(uuid,uuid,jsonb)','erp_finance_transfer_get(uuid,uuid)','erp_finance_transfer_command(uuid,uuid)','erp_finance_transfer_list(uuid,uuid,integer,uuid)'])assert.equal(await scalar('SELECT has_function_privilege($1,$2,\'EXECUTE\') AS value',[role,'public.'+signature]),false);
 const a=await account(),b=await account(),body=input(a,b),done=await post(body);
 for(const role of ['vendas','estoque','fiscal','inactive','missing'])for(const fn of [()=>post(body,users[role]),()=>get(done.receipt.id,users[role]),()=>list({actor:users[role]}),()=>command(body.command_id,users[role])])await assert.rejects(fn,code('42501'));
 await assert.rejects(()=>post(body,users.consulta),code('42501'));
 assert.equal((await get(done.receipt.id,users.consulta)).read_only,true);
 await assert.rejects(()=>command(body.command_id,users.admin),code('P0002'));await assert.rejects(()=>command(randomUUID()),code('P0002'));
 await db.query('UPDATE erp_access.membership SET active=false WHERE user_id=$1',[users.financeiro]);
 await assert.rejects(()=>post(body),code('42501'));await assert.rejects(()=>command(body.command_id),code('42501'));
 await db.query('UPDATE erp_access.membership SET active=true WHERE user_id=$1',[users.financeiro]);
});

test('two ledger legs, exact cents and account versions are atomic with no title/opening effects',async()=>{
 const a=await account('Caixa A fictício'),b=await account('Caixa B fictício'),body=input(a,b,{amount_cents:'999999999999999'});
 const before=await scalar('SELECT count(*)::int AS value FROM erp_finance.title');const done=await post(body,users.admin),r=done.receipt;
 assert.equal(done.bank_operation_performed,false);assert.equal(done.title_mutation_performed,false);assert.equal(done.opening_mutation_performed,false);
 assert.equal(r.amount_cents,'999999999999999');assert.equal(r.from_account.balance_before_cents,'0');assert.equal(r.from_account.balance_after_cents,'-999999999999999');
 assert.equal(r.to_account.balance_after_cents,'999999999999999');assert.equal(r.from_account.version_after,2);assert.equal(r.to_account.version_after,2);
 assert.deepEqual(r.movements.map(m=>[m.kind,m.delta_cents]),[['transfer_out','-999999999999999'],['transfer_in','999999999999999']]);
 assert.equal(done.current.from_account.opening_recorded,false);assert.equal(done.current.to_account.opening_recorded,false);
 assert.equal(await scalar('SELECT sum(delta_cents)::text AS value FROM erp_finance.movement WHERE transfer_id=$1',[r.id]),'0');
 assert.equal(await scalar('SELECT count(*)::int AS value FROM erp_finance.title'),before);assert.equal(await scalar("SELECT count(*)::int AS value FROM erp_finance.settlement"),0);
 assert.equal((await current(a.id)).record.balance_cents,r.from_account.balance_after_cents);
 received=done;
});

test('receipt is immutable, replay does not repost and current accounts are separate',async()=>{
 const a=await account(),b=await account(),body=input(a,b),done=await post(body);
 await native('account_save',{id:a.id,expected_version:2,name:'Nome posterior fictício',kind:'other',active:false});
 const replay=await post(body);assert.equal(replay.replayed,true);assert.deepEqual(replay.receipt,done.receipt);assert.equal(replay.current.from_account.version,3);assert.equal(replay.current.from_account.active,false);assert.equal(replay.current.from_account.name,'Nome posterior fictício');
 assert.deepEqual((await command(body.command_id)).receipt,done.receipt);
 for(const patch of [{amount_cents:'12346'},{note:'Outro motivo'},{from_account_id:b.id,to_account_id:a.id}])await assert.rejects(()=>post({...body,...patch}),code('40001'));
 await assert.rejects(()=>post(body,users.admin),code('40001'));
 await assert.rejects(()=>db.query('UPDATE erp_finance.transfer SET note=$1 WHERE id=$2',['Outra',done.receipt.id]),code('55000'));
 await assert.rejects(()=>db.query('DELETE FROM erp_finance.movement WHERE transfer_id=$1',[done.receipt.id]),code('55000'));
 await assert.rejects(()=>db.query('UPDATE erp_finance.command SET result=$1 WHERE id=$2',['{}',body.command_id]),code('55000'));
 assert.equal(await scalar('SELECT count(*)::int AS value FROM erp_finance.movement WHERE transfer_id=$1',[done.receipt.id]),2);
});

test('command namespace prevents reuse between transfer, opening and legacy financial actions',async()=>{
 const a=await account(),b=await account(),body=input(a,b);await post(body);
 await assert.rejects(()=>native('opening',{id:a.id,expected_version:2,amount_cents:'1',posted_on:today,note:'Abertura fictícia'},users.financeiro,body.command_id),code('40001'));
 const cmd=randomUUID();const c=await native('account_save',{expected_version:0,name:'Outra',kind:'cash'},users.financeiro,cmd);
 await assert.rejects(()=>post(input(c.record,b,{command_id:cmd,expected_to_version:2})),code('40001'));
});

test('dates honor both openings, never future, and later opening cannot cross existing transfer',async()=>{
 const a=await account(),b=await account();const opened=await native('opening',{id:b.id,expected_version:1,amount_cents:'0',posted_on:today,note:'Abertura fictícia'});
 for(const posted_on of [yesterday,tomorrow,'2026-02-30'])await assert.rejects(()=>post(input(a,opened.record,{posted_on})),code('22023'));
 const done=await post(input(a,opened.record));assert.equal(done.receipt.to_account.opening_on,today);
 const c=await account(),d=await account();await post(input(c,d,{posted_on:yesterday}));
 await assert.rejects(()=>native('opening',{id:c.id,expected_version:2,amount_cents:'1',posted_on:today,note:'Abertura posterior inválida'}),code('22023'));
 const allowed=await native('opening',{id:c.id,expected_version:2,amount_cents:'10',posted_on:yesterday,note:'Abertura na data'});assert.equal(allowed.record.balance_cents,'-12335');
});

test('CAS on both active accounts, strict cents/confirmation/note and limits fail without effects',async()=>{
 const a=await account(),b=await account(),body=input(a,b);const before=await scalar('SELECT count(*)::int AS value FROM erp_finance.transfer');
 for(const extra of [{to_account_id:a.id},{amount_cents:123},{amount_cents:'01'},{amount_cents:'0'},{amount_cents:'-1'},{amount_cents:'1.00'},{amount_cents:'1000000000000000'},{confirmed:false},{note:'  '},{note:'\u00a0\u2003\u200b'},{note:'a\nb'},{note:' x '},{bank_api:true}])await assert.rejects(()=>post({...body,...extra}),code('22023'));
 for(const extra of [{expected_from_version:2},{expected_to_version:2}])await assert.rejects(()=>post({...body,...extra}),code('40001'));
 await native('account_save',{id:b.id,expected_version:1,name:'Arquivada',kind:'cash',active:false});
 await assert.rejects(()=>post({...body,expected_to_version:2}),code('40001'));
 await assert.rejects(()=>post({...body,to_account_id:randomUUID()}),code('P0002'));
 assert.equal(await scalar('SELECT count(*)::int AS value FROM erp_finance.transfer'),before);assert.equal((await current(a.id)).record.balance_cents,'0');
});

test('failure on second leg or final audit rolls back both balances, receipt, command and versions',async()=>{
 const a=await account(),b=await account(),body=input(a,b);const before=await scalar('SELECT count(*)::int AS value FROM erp_finance.movement');
 await db.exec("CREATE FUNCTION public.test_transfer_fail() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'synthetic failure' USING ERRCODE='P0001';END$$; CREATE TRIGGER test_transfer_fail BEFORE INSERT ON erp_finance.movement FOR EACH ROW WHEN(NEW.kind='transfer_in') EXECUTE FUNCTION public.test_transfer_fail();");
 await assert.rejects(()=>post(body),code('P0001'));await db.exec('DROP TRIGGER test_transfer_fail ON erp_finance.movement');
 assert.equal((await current(a.id)).record.version,1);assert.equal((await current(b.id)).record.version,1);assert.equal(await scalar('SELECT count(*)::int AS value FROM erp_finance.movement'),before);await assert.rejects(()=>command(body.command_id),code('P0002'));
 await db.exec("CREATE TRIGGER test_transfer_fail BEFORE INSERT ON erp_finance.audit FOR EACH ROW WHEN(NEW.action='internal_transfer') EXECUTE FUNCTION public.test_transfer_fail();");
 await assert.rejects(()=>post(body),code('P0001'));await db.exec('DROP TRIGGER test_transfer_fail ON erp_finance.audit;DROP FUNCTION public.test_transfer_fail();');
 assert.equal((await current(a.id)).record.balance_cents,'0');assert.equal((await current(b.id)).record.balance_cents,'0');assert.equal((await post(body)).replayed,false);
});

test('pair and leg constraints forbid missing, mismatched, third or legacy-shaped legs',async()=>{
 const r=received.receipt;
 await assert.rejects(()=>db.query("INSERT INTO erp_finance.movement(account_id,kind,delta_cents,posted_on,note,actor,command_id,transfer_id)VALUES($1,'transfer_in',1,$2,$3,$4,$5,$6)",[r.to_account.id,r.posted_on,r.note,users.admin,r.command_id,r.id]),code('22023'));
 await assert.rejects(()=>db.query("INSERT INTO erp_finance.movement(account_id,kind,delta_cents,posted_on,note,actor,command_id,transfer_id)VALUES($1,'opening',0,$2,$3,$4,$5,$6)",[r.to_account.id,r.posted_on,r.note,users.admin,r.command_id,r.id]),code('22023'));
 const lone=randomUUID();await db.exec('BEGIN');try{
  await db.query('INSERT INTO erp_finance.command(id,actor,request_hash,result)VALUES($1,$2,$3,$4)',[lone,users.admin,'test','{}']);
  await db.query('INSERT INTO erp_finance.transfer(command_id,actor,from_account_id,to_account_id,amount_cents,posted_on,note,from_snapshot,to_snapshot)VALUES($1,$2,$3,$4,1,$5,$6,$7,$8)',[lone,users.admin,r.from_account.id,r.to_account.id,r.posted_on,r.note,JSON.stringify(r.from_account),JSON.stringify(r.to_account)]);
  await assert.rejects(()=>db.exec('SET CONSTRAINTS ALL IMMEDIATE'),code('22023'));
 }finally{await db.exec('ROLLBACK');}
});

test('SQL to HTTP DTO, recovery GET and legacy movement API retain exact link and no private fields',async()=>{
 const a=await account(),b=await account(),body=input(a,b),done=await api('','POST',body);
 assert.equal(done.receipt.amount_cents,'12345');assert.equal((await api('/commands/'+body.command_id)).receipt.id,done.receipt.id);
 assert.equal((await api('/'+done.receipt.id.toUpperCase())).receipt.id,done.receipt.id);
 const route=await parse(request('','POST',body));const projected=financeTransfersResponse({...done,raw:'private',receipt:{...done.receipt,actor:users.admin},current:{...done.current,raw:'private'}},route);
 assert.equal(projected.raw,undefined);assert.equal(projected.receipt.actor,undefined);assert.equal(projected.current.raw,undefined);
 const oldRoute=await parseFinanceRoute(new Request('https://example.test/v1/financeiro/movements?parent_id='+a.id));const old=await executeFinanceRoute(oldRoute,{userId:users.consulta,rpc});
 assert.equal(old.items[0].kind,'transfer_out');assert.equal(old.items[0].transfer_id,done.receipt.id);
 const oldAccount=await account();await native('opening',{id:oldAccount.id,expected_version:1,amount_cents:'1',posted_on:today,note:'Abertura legada'});
 const legacy=await executeFinanceRoute(await parseFinanceRoute(new Request('https://example.test/v1/financeiro/movements?parent_id='+oldAccount.id)),{userId:users.consulta,rpc});assert.equal(legacy.items[0].transfer_id,null);
 assert.ok(new TextEncoder().encode(JSON.stringify(await api('?limit=25'))).length<FINANCE_TRANSFERS_RESPONSE_BYTES);
});

test('list page/filter/cursor is exact and no command is created by reading',async()=>{
 const a=await account(),b=await account();let av=1,bv=1;
 for(let i=0;i<3;i++)await post(input(a,b,{expected_from_version:av++,expected_to_version:bv++}));
 const before=await scalar('SELECT count(*)::int AS value FROM erp_finance.command');const first=await api('?account_id='+a.id+'&limit=2');assert.equal(first.items.length,2);assert.equal(first.has_more,true);
 const last=await api('?account_id='+a.id+'&limit=2&after='+first.next_cursor);assert.equal(last.items.length,1);assert.equal(last.has_more,false);assert.equal(last.next_cursor,null);
 const ids=[...first.items,...last.items].map(v=>v.receipt.id);assert.deepEqual(ids,[...ids].sort());assert.equal(new Set(ids).size,3);
 assert.equal(await scalar('SELECT count(*)::int AS value FROM erp_finance.command'),before);
});

test('HTTP parser rejects unknown data, numbers, duplicate queries, unsupported encoding and oversized/malformed bodies',async()=>{
 assert.equal(await parse(new Request('https://example.test/v1/else')),null);assert.equal(financeTransfersRoute('/v1/transferencias-internas'),true);assert.deepEqual(financeTransfersMethods('/v1/transferencias-internas'),['GET','POST']);
 for(const path of ['/bad','?limit=0','?limit=26','?limit=01','?limit=1&limit=2','?raw=1','?account_id=bad'])await assert.rejects(()=>parse(request(path)),e=>[400,404].includes(e.status));
 await assert.rejects(()=>parse(request('','PATCH')),e=>e.status===405);
 const a=await account(),b=await account(),base=input(a,b);
 for(const patch of [{amount_cents:1},{amount_cents:'01'},{note:'\u00a0\u200b\u2003'},{expected_from_version:0},{confirmed:false},{actor:users.admin},{to_account_id:a.id.toUpperCase()}])await assert.rejects(()=>parse(request('','POST',{...base,...patch})),e=>e.status===400);
 await assert.rejects(()=>parse(new Request(request('','POST',base),{headers:{'content-type':'application/json','content-encoding':'gzip'}})),e=>e.status===400);
 await assert.rejects(()=>parse(new Request('https://example.test/v1/transferencias-internas',{method:'POST',headers:{'content-type':'application/json'},body:' '.repeat(4097)})),e=>e.status===413);
 await assert.rejects(()=>parse(new Request('https://example.test/v1/transferencias-internas',{method:'POST',headers:{'content-type':'application/json'},body:new Uint8Array([0xff])})),e=>e.status===400);
});

test('DTO rejects wrong direction/accounts/versions/amount/date and inconsistent cash or command binding',async()=>{
 const a=await account(),b=await account(),body=input(a,b),route=await parse(request('','POST',body)),done=await post(body);
 for(const change of [v=>v.receipt.command_id=randomUUID(),v=>v.receipt.amount_cents='12346',v=>v.receipt.posted_on=yesterday,v=>v.receipt.from_account.version_before=2,
  v=>v.receipt.movements[0].kind='transfer_in',v=>v.receipt.movements[1].account_id=a.id,v=>v.receipt.movements[0].delta_cents='-12344',v=>v.current.from_account.balance_cents='1',v=>v.receipt.created_at='2026-02-30T00:00:00Z',v=>v.bank_operation_performed=true]){
  const altered=structuredClone(done);change(altered);assert.throws(()=>financeTransfersResponse(altered,route),e=>e.status===502);
 }
});

test('route and body are captured, actor injected; private diagnostics are sanitized',async()=>{
 const a=await account(),b=await account(),body=input(a,b),route=await parse(request('','POST',body));assert.ok(Object.isFrozen(route.args.p_data));
 assert.throws(()=>route.args.p_data.amount_cents='1',TypeError);let seen;
 await execute(route,{userId:users.financeiro.toUpperCase(),rpc:async(name,args)=>{seen=args;return rpc(name,args);}});assert.equal(seen.p_user_id,users.financeiro);assert.equal(seen.p_data.amount_cents,'12345');
 await assert.rejects(()=>execute({...route},{userId:users.financeiro,rpc}),e=>e.status===404);
 await assert.rejects(()=>execute(route,{userId:'invalid',rpc:()=>assert.fail()}),e=>e.status===401);
 for(const [error,status] of [[{code:'42501',message:'SECRET'},403],[{code:'40001',detail:'SECRET'},409],[{status:400,message:'SECRET'},400],[new Error('SECRET'),503]])await assert.rejects(()=>execute(route,{userId:users.financeiro,rpc:async()=>{throw error;}}),e=>e.status===status&&!e.message.includes('SECRET'));
});

test('accepted POST with lost response recovers by GET and exact replay; no partial or duplicate movements',async()=>{
 const a=await account(),b=await account(),body=input(a,b),route=await parse(request('','POST',body));let calls=0;
 await assert.rejects(()=>execute(route,{userId:users.financeiro,rpc:async(name,args)=>{calls++;await rpc(name,args);throw new Error('response lost');}}),e=>e.status===503&&e.code==='ERP_RESULT_UNCONFIRMED');
 const recovered=await api('/commands/'+body.command_id);const replay=await execute(route,{userId:users.financeiro,rpc});assert.equal(replay.replayed,true);assert.deepEqual(recovered.receipt,replay.receipt);assert.equal(calls,1);
 assert.equal(await scalar('SELECT count(*)::int AS value FROM erp_finance.movement WHERE transfer_id=$1',[replay.receipt.id]),2);
});

test('abort before dispatch does not send; abort/timeout after dispatch is uncertain without retry',async()=>{
 const a=await account(),b=await account(),route=await parse(request('','POST',input(a,b))),stop=new AbortController();stop.abort();let calls=0;
 await assert.rejects(()=>execute(route,{userId:users.financeiro,signal:stop.signal,rpc:()=>{calls++;}}),e=>e.status===400);assert.equal(calls,0);
 const active=new AbortController();let entered;const began=new Promise(resolve=>entered=resolve);
 const pending=execute(route,{userId:users.financeiro,signal:active.signal,rpc:async()=>{calls++;entered();return new Promise(()=>{});}});await began;active.abort();await assert.rejects(()=>pending,e=>e.status===503&&e.code==='ERP_RESULT_UNCONFIRMED');assert.equal(calls,1);
 await assert.rejects(()=>execute(route,{userId:users.financeiro,timeoutMs:5,rpc:async()=>new Promise(()=>{})}),e=>e.status===503&&e.code==='ERP_RESULT_UNCONFIRMED');
});

test('all transfer pairs reconcile exactly and every receipt has one audit and immutable command',async()=>{
 assert.equal(await scalar('SELECT count(*)::int AS value FROM erp_finance.transfer t WHERE (SELECT count(*) FROM erp_finance.movement m WHERE m.transfer_id=t.id)<>2 OR (SELECT sum(delta_cents)FROM erp_finance.movement m WHERE m.transfer_id=t.id)<>0'),0);
 assert.equal(await scalar("SELECT count(*)::int AS value FROM erp_finance.transfer t WHERE NOT EXISTS(SELECT 1 FROM erp_finance.command c WHERE c.id=t.command_id AND c.result->>'action'='internal_transfer') OR (SELECT count(*) FROM erp_finance.audit a WHERE a.command_id=t.command_id AND a.action='internal_transfer')<>1"),0);
});

test('full page with maximum Unicode account names and notes fits the bounded response',async()=>{
 const a=await account('😀'.repeat(200)),b=await account('🧾'.repeat(200));
 for(let i=0;i<25;i++)await post(input(a,b,{expected_from_version:i+1,expected_to_version:i+1,note:'📝'.repeat(500)}));
 const page=await api('?account_id='+a.id+'&limit=25');assert.equal(page.items.length,25);
 const bytes=new TextEncoder().encode(JSON.stringify(page)).length;
 assert.ok(bytes>131072,'Fixture exercises the former 128KiB boundary');assert.ok(bytes<FINANCE_TRANSFERS_RESPONSE_BYTES);
});

test('account names accepted by HTTP010 remain readable before and after transfer, including TAB/LF/CR',async()=>{
 const nativeApi=async data=>executeFinanceRoute(await parseFinanceRoute(new Request('https://example.test/v1/financeiro/actions/account_save',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({command_id:randomUUID(),data})})),{userId:users.financeiro,rpc});
 const a=(await nativeApi({expected_version:0,name:'Conta fictícia\nsegunda linha',kind:'cash'})).record,b=await account();
 const body=input(a,b),done=await api('','POST',body);assert.equal(done.receipt.from_account.name,a.name);
 await nativeApi({id:a.id,expected_version:2,name:'Nome\tposterior\rconferido',kind:'cash'});
 const recovered=await api('/commands/'+body.command_id);assert.equal(recovered.receipt.from_account.name,a.name);assert.equal(recovered.current.from_account.name,'Nome\tposterior\rconferido');
 assert.equal((await api('','POST',body)).replayed,true);assert.equal((await api('?account_id='+a.id)).items.length,1);
});

test('deferred pair check commits under service_role after the privileged RPC returns, without table grants',async()=>{
 const properties=(await db.query("SELECT prosecdef,proconfig FROM pg_proc WHERE oid='erp_finance.transfer_pair_check()'::regprocedure")).rows[0];
 assert.equal(properties.prosecdef,true);assert.ok(properties.proconfig.includes('search_path=pg_catalog'));
 assert.equal(await scalar("SELECT has_table_privilege('service_role','erp_finance.movement','SELECT,INSERT,UPDATE,DELETE') AS value"),false);
 const a=await account(),b=await account(),body=input(a,b),{command_id,...data}=body;let result;
 await db.exec('BEGIN; SET LOCAL ROLE service_role');
 try{
  result=await scalar('SELECT public.erp_finance_transfer_post($1,$2,$3::jsonb) AS value',[users.financeiro,command_id,JSON.stringify(data)]);
  // The deferred constraint runs here, after the function's definer scope ended.
  await db.exec('COMMIT');
 }catch(error){await db.exec('ROLLBACK');throw error;}
 assert.equal(result.replayed,false);assert.equal(await scalar('SELECT count(*)::int AS value FROM erp_finance.movement WHERE transfer_id=$1',[result.receipt.id]),2);
 assert.equal((await command(command_id)).receipt.id,result.receipt.id);
});
