import test from 'node:test';import assert from 'node:assert/strict';
import {OriginClient} from '../src/client.mjs';
import {RESOURCES,getResource,buildListParams} from '../src/resources.mjs';
import {syncPage,runSync} from '../src/sync.mjs';
import {sourcePageSlice,extraFailure} from '../src/extra-resources.mjs';
const fixed=Date.parse('2026-10-16T20:00:00Z'),now=new Date(fixed),env={ORIGIN_ENABLED: 'true', ORIGIN_API_ORIGIN: 'https://api.provider.example', SYNC_ENABLED: 'true',SYNC_START_DATE:'2020-01-01',MAX_API_REQUESTS:'120',EXTRA_RESOURCES_ENABLED:'true'};
function repo(cp={}){return{cp,commits:[],releases:[],async claim(){return {acquired:true,lease_token:'fence',checkpoint_version:1,checkpoint:structuredClone(this.cp)};},async apply(...a){this.commits.push(a);this.cp=structuredClone(a[5]);return {inserted:a[4].length};},async release(...a){this.releases.push(a);},async renew(){},async rpc(){throw Error('UNEXPECTED_RPC');}};}
const options={clock:()=>fixed,deadline:fixed+180000};
test('063 covers seven entities, explicitly gated, entry dates and documented partitions only',()=>{
 const xs=RESOURCES.filter(x=>x.extra);assert.equal(new Set(xs.map(x=>x.entity)).size,7);
 const os=buildListParams('service_orders',{from:'2026-10-01',to:'2026-10-31'});assert.deepEqual(os,{pagina:1,limite:100,dataInicial:'2026-10-01',dataFinal:'2026-10-31'});
 assert.deepEqual(xs.filter(x=>x.entity==='warehouses').map(x=>x.baseParams.situacao),[1,0]);
 assert.deepEqual(getResource('financial_categories').baseParams,{tipo:0,situacao:0});assert.equal(getResource('ledger_accounts').baseParams.ocultarInvisiveis,false);
 const cash=buildListParams('cash_entries_deleted',{from:'2026-10-01',to:'2026-10-31'});assert.equal(cash.situacao,'E');assert.equal(cash.situacaoConciliacao,3);assert.equal(cash.limite,undefined);
 assert.throws(()=>buildListParams('stock_balances'),{code:'ORIGIN_STOCK_IDS_REQUIRED'});
});
test('client accepts only fixed extra GETs and the documented bare cash detail',async()=>{
 const calls=[];const client=new OriginClient('synthetic',{ apiOrigin: 'https://api.provider.example',intervalMs:0,fetchImpl:async(url,init)=>{calls.push({url,init});return /\/caixas\/7$/.test(url)?Response.json({id:7,data:'2026-10-16',competencia:'2026-10-01',valor:2,situacao:'R'}):Response.json({data:/\/7$/.test(url)?{id:7}:[]});}});
 for(const path of ['/ordens/servico','/depositos','/categorias/produtos','/categorias/receitas-despesas','/contas-contabeis','/caixas']){await client.get(path);assert.equal((await client.get(path+'/7')).id,7);}
 await client.get('/contas-contabeis',{situacoes:[1,2,3,4]});assert.deepEqual(new URL(calls.at(-1).url).searchParams.getAll('situacoes'),['1','2','3','4']);assert.ok(calls.every(x=>x.init.method==='GET'&&x.init.redirect==='manual'));
 for(const path of ['/estoques','/estoques/saldos/7','/ordens/servico/7/lancar-estoque','/caixas/7/conciliar','/contas-contabeis/7/saldo','/depositos?x=1'])await assert.rejects(client.get(path),{code:'ORIGIN_INVALID_PATH'});
 const bare=new OriginClient('synthetic',{ apiOrigin: 'https://api.provider.example',intervalMs:0,fetchImpl:async()=>Response.json({id:7})});await assert.rejects(bare.get('/depositos/7'),{code:'ORIGIN_INVALID_RESPONSE'});
 const ambiguous=new OriginClient('synthetic',{ apiOrigin: 'https://api.provider.example',intervalMs:0,fetchImpl:async()=>Response.json({id:7,data:{id:8}})});await assert.rejects(ambiguous.get('/caixas/7'),{code:'ORIGIN_INVALID_RESPONSE'});
});
test('stock client requires bounded exact ID batches and explicit sign partition before fetch',async()=>{
 const calls=[];const client=new OriginClient('synthetic',{ apiOrigin: 'https://api.provider.example',intervalMs:0,fetchImpl:async(url)=>{calls.push(url);return Response.json({data:[]});}});
 for(const query of [{},{'idsProdutos[]':['1']},{'idsProdutos[]':['1','1'],filtroSaldoEstoque:0},{'idsProdutos[]':[1],filtroSaldoEstoque:0},{'idsProdutos[]':['1'],filtroSaldoEstoque:3},{'idsProdutos[]':['1'],filtroSaldoEstoque:1,pagina:1}])await assert.rejects(client.get('/estoques/saldos',query),{code:'ORIGIN_INVALID_PARAMS'});
 assert.equal(calls.length,0);await client.get('/estoques/saldos',{'idsProdutos[]':['9007199254740993','2'],filtroSaldoEstoque:0});assert.deepEqual(new URL(calls[0]).searchParams.getAll('idsProdutos[]'),['9007199254740993','2']);
});
test('cash resumes ten details inside one source page and ends only on empty page',async()=>{
 const db=repo(),rows=Array.from({length:13},(_,i)=>({id:i+1})),reads=[];
 const client={async get(path,params){reads.push({path,params});return path==='/caixas'?rows:{id:Number(path.split('/').at(-1))};}};
 await syncPage(db,client,getResource('cash_entries_registered'),'owner',env,now,options);assert.equal(db.commits[0][4].length,10);assert.equal(db.cp.recent.offset,10);assert.equal(db.cp.recent.page,1);assert.equal(db.cp.nextLane,'recent');
 await syncPage(db,client,getResource('cash_entries_registered'),'owner',env,now,options);assert.deepEqual(db.commits[1][4].map(x=>x.source_id),['11','12','13']);assert.equal(db.cp.recent.page,2);assert.equal(db.cp.recent.offset,undefined);assert.equal(reads[0].params.limite,undefined);
 db.cp.nextLane='recent';client.get=async()=>[];await syncPage(db,client,getResource('cash_entries_registered'),'owner',env,now,options);assert.equal(db.cp.recent,undefined);assert.ok(db.cp.recentCompletedAt);
});
test('changed cash page restarts offset without claiming a consistent snapshot',async()=>{
 const a=await sourcePageSlice([{id:1},{id:2}],{page:1}),b=await sourcePageSlice([{id:3},{id:1}],{...a.next,offset:1});assert.deepEqual(b.items.map(x=>x.id),[3,1]);
 await assert.rejects(sourcePageSlice([{id:1},{id:1}],{page:1}),/ORIGIN_DUPLICATE_SOURCE_ID/);
 await assert.rejects(sourcePageSlice(Array.from({length:1001},(_,i)=>({id:i+1})),{page:1}),/ORIGIN_SOURCE_PAGE_LIMIT/);
});
test('failed detail preserves cursor, records only backoff, and does not partially stage rows',async()=>{
 const db=repo({version:1,recent:{from:'2026-10-01 00:00:00',to:'2026-10-15 00:00:00',page:3}}),old=structuredClone(db.cp);let calls=0;
 const client={async get(){if(++calls===1)return[{id:1},{id:2}];if(calls===2)return{id:1};throw Object.assign(Error('PRIVATE_BODY'),{status:403,code:'ORIGIN_FORBIDDEN'});}};
 await assert.rejects(syncPage(db,client,getResource('service_orders'),'owner',env,now,options));assert.equal(db.commits.length,1);assert.deepEqual(db.commits[0][4],[]);assert.deepEqual(db.cp.recent,old.recent);assert.equal(Date.parse(db.cp.failure.next_attempt_at)-fixed,86400000);assert.equal(JSON.stringify(db.cp).includes('PRIVATE_BODY'),false);
 const before=calls;assert.equal((await syncPage(db,client,getResource('service_orders'),'owner',env,now,options)).deferred,true);assert.equal(calls,before);
});
test('uncertain database commit never sends another checkpoint command',async()=>{
 const db=repo();db.apply=async(...a)=>{db.commits.push(a);throw Error('DATABASE_UNAVAILABLE');};const client={async get(path,params){return params?[{id:1}]:{id:1};}};
 await assert.rejects(syncPage(db,client,getResource('warehouses_active'),'owner',env,now,options),/DATABASE_UNAVAILABLE/);assert.equal(db.commits.length,1);
});
function stockRepo(ids=['1','2','3']){const db=repo();db.rpc=async(name,args)=>{assert.equal(name,'origin_sync_stock_product_page');assert.equal(args.p_limit,25);return{items:ids,has_more:false,next_cursor:null,coverage_complete:false};};return db;}
test('stock requests all three partitions, preserves deposit IDs and leaves missing products unavailable',async()=>{
 const db=stockRepo(),calls=[];const client={async get(path,p){calls.push(p);return p.filtroSaldoEstoque===0?[{produto:{id:1},saldoFisicoTotal:0,depositos:[{id:'99',saldoFisico:0,saldoVirtual:0}]}]:p.filtroSaldoEstoque===2?[{produto:{id:3},saldoFisicoTotal:-0.123456,depositos:[{id:42,saldoFisico:-0.123456}]}]:[];}};
 const r=await syncPage(db,client,getResource('stock_balances'),'owner',env,now,options);assert.equal(r.unavailable,1);assert.deepEqual(calls.map(p=>p.filtroSaldoEstoque),[0,1,2]);assert.deepEqual(db.commits[0][4].map(x=>x.source_id),['1','3']);assert.equal(db.commits[0][4][0].payload.depositos[0].id,'99');assert.equal(db.cp.last_observation.coverage_complete,false);assert.ok(db.cp.next_attempt_at);
});
test('stock partition crossing, foreign product/deposit duplicates fail atomically without inventing missing rows',async()=>{
 for(const kind of ['cross','foreign','deposits']){const db=stockRepo(['1']);const client={async get(_path,p){return kind==='cross'?[{produto:{id:1},saldoFisicoTotal:p.filtroSaldoEstoque}]:p.filtroSaldoEstoque>0?[]:kind==='foreign'?[{produto:{id:2}}]:[{produto:{id:1},depositos:[{id:1},{id:1}]}];}};
 await assert.rejects(syncPage(db,client,getResource('stock_balances'),'owner',env,now,options),/ORIGIN_STOCK_RESPONSE_CONFLICT/);assert.deepEqual(db.commits[0][4],[]);assert.equal(db.cp.unfiltered,undefined);}
});
test('stock source cursor is exact, ordered and bounded; empty source never calls Origin',async()=>{
 const db=stockRepo([]);let calls=0;await syncPage(db,{async get(){calls++;}},getResource('stock_balances'),'owner',env,now,options);assert.equal(calls,0);assert.equal(db.cp.last_observation.requested,0);
 const invalid=stockRepo(['2','1']);await assert.rejects(syncPage(invalid,{},getResource('stock_balances'),'owner',env,now,options),/ORIGIN_STOCK_SOURCE_PAGE_INVALID/);
});
test('new resource flags default off and 403 cannot starve following resources',async()=>{
 class Client{remainingRequests=30;requestsMade=0;async get(path,query){this.requestsMade++;if(path==='/ordens/servico')throw Object.assign(Error('ORIGIN_FORBIDDEN'),{status:403});this.remainingRequests-=15;return query?[]:{id:1};}}
 const off=repo();const result=await runSync(off,{...env,EXTRA_RESOURCES_ENABLED:'false'},{now:()=>now,Client,getToken:async()=> 'synthetic',resources:[getResource('service_orders'),getResource('contacts')]});assert.equal(result.errors.length,0);assert.ok(off.commits.every(x=>x[0]!=='service_orders'));
 const on=repo(),checkpoints=new Map();on.claim=async resource=>({acquired:true,lease_token:'fence',checkpoint_version:1,checkpoint:structuredClone(checkpoints.get(resource)??{})});on.apply=async(...a)=>{on.commits.push(a);checkpoints.set(a[0],structuredClone(a[5]));return{inserted:a[4].length};};
 const result2=await runSync(on,env,{now:()=>now,Client,getToken:async()=> 'synthetic',resources:[getResource('service_orders'),getResource('warehouses_active')]});assert.ok(on.commits.some(x=>x[0]==='warehouses_active'));assert.equal(result2.status,'partial');
});
test('extra backoff is bounded and never prints arbitrary upstream text',()=>{
 assert.equal(extraFailure(Error('Bearer private token'),null,fixed).code,'EXTRA_COLLECTION_FAILED');assert.equal(Date.parse(extraFailure({status:404},null,fixed).next_attempt_at)-fixed,3600000);assert.equal(Date.parse(extraFailure({}, {failures:999},fixed).next_attempt_at)-fixed,3600000);
});
