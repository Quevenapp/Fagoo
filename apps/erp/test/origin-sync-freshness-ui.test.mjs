import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mountComponent,AccessError} from './helpers/component-recovery-harness.mjs';
import {createAccessController,AccessError as RealAccessError} from '../src/lib/real-access.ts';
import {parseOriginFreshness,FRESHNESS_ENTITIES,FRESHNESS_PATH,freshnessAge} from '../src/lib/origin-freshness-model.ts';
import {originSyncFreshnessResponse,FRESHNESS_ENTITIES as API_ENTITIES} from '../../../workers/erp-api/src/integration-progress.mjs';
import {freshnessResponse,measureEntity} from '../../../workers/erp-api/test/helpers/origin-sync-freshness-response.mjs';
import {progressFixture} from './helpers/integration-progress-fixtures.mjs';

const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
const sample=(records=4775)=>{const v=freshnessResponse();measureEntity(v,'contacts',{ageSeconds:120,records});measureEntity(v,'receivables',{ageSeconds:2400,records:12});return v;};
const controller=freshness=>({integrationProgress:async()=>progressFixture(),integrationFreshness:freshness});
const badges=app=>app.nodes().filter(n=>n.type==='span'&&String(n.props.className).startsWith('status-badge')).map(n=>[n.props.className,n.props.children]);

test('101 UI model mirrors the API projection and catalog exactly, dropping private additions',()=>{
 assert.deepEqual(FRESHNESS_ENTITIES.map(x=>[x.entity,x.level,x.lanes]),API_ENTITIES.map(([e,l,lanes])=>[e,l,lanes.map(x=>[...x])]));
 assert.ok(FRESHNESS_ENTITIES.every(x=>x.label&&!/_/.test(x.label)));
 const v=sample();v.private='PRIVATE_SECRET';v.entities[0].payload={nome:'PRIVATE_NAME'};v.entities[0].lanes[0].cursor={page:3};
 const parsed=parseOriginFreshness(v);assert.deepEqual(parsed,originSyncFreshnessResponse(v));assert.doesNotMatch(JSON.stringify(parsed),/PRIVATE_|cursor|payload/);
 for(const mutate of[x=>x.role='consulta',x=>x.coverage_certified=true,x=>x.entities.pop(),x=>x.entities[0].status='stale',x=>x.entities[0].age_seconds=10,
  x=>x.entities[0].freshness_at=null,x=>x.entities[0].lanes[1].completed_started_at=null,x=>x.entities[8].status='ok',x=>x.levels[2].stale_after_seconds=1,
  x=>x.collector.oauth_connected=true,x=>x.collector.last_error_code='private message',x=>x.as_of='2026-02-30T00:00:00Z']){
  const value=sample();mutate(value);assert.throws(()=>parseOriginFreshness(value),/ORIGIN_FRESHNESS_INVALID/);assert.throws(()=>originSyncFreshnessResponse(value),e=>e.status===502);
 }
 assert.deepEqual([30,60,600,3599,3600,4500,172799,172800].map(freshnessAge),['menos de 1 min','1 min','10 min','59 min','1 h','1 h 15 min','47 h 59 min','2 dias']);
});

test('101 section shows every Origin set with records, times, last complete pass, level and badge',async()=>{
 const value=sample();Object.assign(value.collector,{oauth_connected:true,oauth_expires_at:'2026-10-19T19:00:00.000Z',last_run_status:'partial',last_run_started_at:'2026-10-19T12:58:00.000Z',last_run_finished_at:'2026-10-19T12:59:30.000Z',last_run_error_count:1,last_error_code:'ORIGIN_HTTP_429',last_error_resource:'nfe_out'});
 const paths=[];const app=await mountComponent('IntegrationProgress.tsx',{controller:controller(async(path,options)=>{paths.push([path,options.method,options.body]);return value;})},{expandChildren:true});
 try{
  const text=app.text();assert.deepEqual(paths,[[FRESHNESS_PATH,undefined,undefined]]);
  assert.match(text,/Frescor da cópia do Origin/);
  for(const label of['Contatos','Produtos','Pedidos de venda','Notas fiscais (NF-e)','NFC-e','Propostas comerciais','Pedidos de compra','Ordens de serviço','Contas a receber','Contas a pagar','Caixas e bancos','Saldos de estoque','Vendedores','Formas de pagamento','Depósitos','Categorias de produtos','Categorias financeiras','Contas contábeis'])assert.ok(text.includes(label),label);
  for(const header of['Registros','Última alteração','Última leitura','Última passagem completa','Nível','Situação'])assert.ok(text.includes(header),header);
  assert.match(text,/4\.775/);assert.match(text,/A · 10 min/);assert.match(text,/B · 30 min/);assert.match(text,/C · 24 h/);
  assert.match(text,/Nível A até 10 min, B até 30 min e C até 24 h/);assert.match(text,/Desatualizado acima de três vezes o nível ou sem passagem completa/);assert.match(text,/Horários de São Paulo/);
  assert.match(text,/nunca o horário do último ciclo/);assert.match(text,/Idade do dado: 2 min/);assert.match(text,/Idade do dado: 40 min/);
  // Contacts: the deleted sweep has the oldest start and limits the set.
  assert.match(text,/19\/10\/2026,? 09:58 a 19\/10\/2026,? 09:58/);assert.match(text,/Excluídos · passagem sem período/);assert.match(text,/Emissão · passagem histórica/);
  assert.match(text,/Sem passagem completa/);assert.match(text,/2 de 2 consultas sem passagem completa medida/);assert.match(text,/1 de 1 consulta sem passagem completa medida/);
  const tones=badges(app);assert.equal(tones.length,18);
  assert.deepEqual(tones.filter(([,label])=>label!=='Desatualizado'),[['status-badge status-success','Em dia'],['status-badge status-warning','Atenção']]);
  assert.ok(tones.filter(([,label])=>label==='Desatualizado').every(([className])=>className==='status-badge status-danger'));
  assert.match(text,/Autorizada · acesso atual até 19\/10\/2026,? 16:00/);assert.match(text,/Ciclo com pendências · 19\/10\/2026,? 09:59/);assert.match(text,/ORIGIN_HTTP_429 em Notas fiscais \(NF-e\) · Saída/);
  assert.equal(app.nodes().filter(n=>n.type==='button').length,1);
 }finally{app.unmount();}
});

test('101 collector state never reads as healthy when the access expired or no cycle was recorded',async()=>{
 const render=async collector=>{const value=sample();Object.assign(value.collector,collector);const app=await mountComponent('IntegrationProgress.tsx',{controller:controller(async()=>value)},{expandChildren:true});try{return app.text();}finally{app.unmount();}};
 // The collector renews 5 min before expiry; an expiry already past the measurement is a stopped renewal.
 let text=await render({oauth_connected:true,oauth_expires_at:'2026-10-19T12:00:00.000Z'});
 assert.match(text,/Autorizada, mas o acesso venceu em 19\/10\/2026,? 09:00 sem renovação/);assert.doesNotMatch(text,/acesso atual até/);
 assert.match(text,/Último ciclo do coletorSem ciclo registrado/);assert.match(text,/Última falha registradaSem ciclo registrado/);assert.doesNotMatch(text,/Nenhuma no último ciclo/);
 text=await render({oauth_connected:true,oauth_expires_at:'2026-10-19T13:00:00.000Z',last_run_status:'completed',last_run_finished_at:'2026-10-19T12:59:00.000Z'});
 assert.match(text,/acesso venceu em/);assert.match(text,/Última falha registradaNão informada/);
 text=await render({last_run_status:'failed',last_run_finished_at:'2026-10-19T12:59:00.000Z',last_run_error_count:1,last_error_code:'SYNC_TIME_BUDGET',last_error_resource:'migration_sweep'});
 assert.match(text,/Não autorizada/);assert.match(text,/SYNC_TIME_BUDGET em migration_sweep/);
 text=await render({last_run_status:'partial',last_run_error_count:2});assert.match(text,/Falha sem código reconhecido/);
 text=await render({last_run_status:'completed',last_run_error_count:0});assert.match(text,/Nenhuma no último ciclo/);
});

test('101 refresh discards old freshness while pending and keeps only the newest answer',async()=>{
 const pending=deferred(),signals=[];let calls=0;
 const app=await mountComponent('IntegrationProgress.tsx',{controller:controller(async(_path,options)=>{signals.push(options.signal);return ++calls===1?sample(4775):pending.promise;})},{expandChildren:true});
 try{
  assert.match(app.text(),/4\.775/);await app.click('Atualizar andamento');
  assert.equal(signals[0].aborted,true);assert.doesNotMatch(app.text(),/4\.775/);assert.match(app.text(),/Consultando frescor/);
  pending.resolve(sample(1234));await app.flush();assert.match(app.text(),/1\.234/);assert.doesNotMatch(app.text(),/4\.775|Consultando frescor/);
 }finally{app.unmount();}
 assert.equal(signals[1].aborted,true);
});

test('101 late answers from an old controller or a closed screen never replace the current session',async()=>{
 const old=deferred(),last=deferred();let oldSignal,lastSignal;
 const app=await mountComponent('IntegrationProgress.tsx',{controller:controller((_p,o)=>{oldSignal=o.signal;return old.promise;})},{expandChildren:true});
 await app.updateProps({controller:controller(async()=>sample(2222))});assert.equal(oldSignal.aborted,true);assert.match(app.text(),/2\.222/);
 old.resolve(sample(9999));await app.flush();assert.doesNotMatch(app.text(),/9\.999/);assert.match(app.text(),/2\.222/);
 await app.updateProps({controller:controller((_p,o)=>{lastSignal=o.signal;return last.promise;})});assert.doesNotMatch(app.text(),/2\.222/);
 app.unmount();assert.equal(lastSignal.aborted,true);last.resolve(sample(8888));
});

test('101 a role change (403) or an invalid answer shows no stale freshness; retry is a plain GET',async()=>{
 let step=0;const methods=[];
 const app=await mountComponent('IntegrationProgress.tsx',{controller:controller(async(_p,o)=>{methods.push(o.method);step++;if(step===2)throw new AccessError(403);if(step===3)return{...sample(),role:'consulta'};if(step===4)throw new AccessError(503);return sample(4321);})},{expandChildren:true});
 try{
  assert.match(app.text(),/4\.321/);
  await app.click('Atualizar andamento');assert.match(app.text(),/restrito aos administradores ativos/);assert.doesNotMatch(app.text(),/4\.321|Última passagem completa/);assert.equal(badges(app).length,0);
  await app.click('Atualizar andamento');assert.match(app.text(),/Não foi possível consultar o frescor/);assert.doesNotMatch(app.text(),/Última passagem completa|Medido em/);assert.equal(badges(app).length,0);
  await app.click('Atualizar andamento');assert.match(app.text(),/Não foi possível consultar o frescor/);
  await app.click('Atualizar andamento');assert.match(app.text(),/4\.321/);assert.doesNotMatch(app.text(),/Não foi possível consultar o frescor|restrito/);
  assert.deepEqual(methods,[undefined,undefined,undefined,undefined,undefined]);
 }finally{app.unmount();}
});

test('101 a controller without the freshness port keeps the previous panel untouched',async()=>{
 const app=await mountComponent('IntegrationProgress.tsx',{controller:{integrationProgress:async()=>progressFixture(1234)}},{expandChildren:true});
 try{assert.match(app.text(),/1\.234/);assert.doesNotMatch(app.text(),/Frescor da cópia do Origin/);}finally{app.unmount();}
});

const uid='a0000000-0000-4000-8000-000000000001',session={access_token:'synthetic-token',user:{id:uid}};
const auth={getSession:async()=>({data:{session},error:null}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}}),signOut:async()=>({error:null})};
const me=role=>({user_id:uid,role,resources:[],data_mode:'staging_readonly'});
const tick=()=>new Promise(resolve=>setTimeout(resolve,0)),status=n=>e=>e instanceof RealAccessError&&e.status===n;
test('101 access controller: admin only, one fixed GET path, bounded body, aborted on logout',async()=>{
 for(const role of['consulta','vendas','financeiro','estoque','fiscal']){
  let queries=0;const c=createAccessController(auth,'https://api.example.test',async url=>{if(url.endsWith('/me'))return Response.json(me(role));queries++;return Response.json({});});
  const stop=c.start();await tick();try{await assert.rejects(()=>c.integrationFreshness(FRESHNESS_PATH),status(403));assert.equal(queries,0);}finally{stop();}
 }
 const calls=[];const c=createAccessController(auth,'https://api.example.test',async(url,options)=>{if(url.endsWith('/me'))return Response.json(me('admin'));calls.push({url,options});return Response.json(sample());});const stop=c.start();await tick();
 try{
  assert.deepEqual(parseOriginFreshness(await c.integrationFreshness(FRESHNESS_PATH)),originSyncFreshnessResponse(sample()));
  assert.equal(calls.length,1);assert.equal(calls[0].url,`https://api.example.test${FRESHNESS_PATH}`);assert.equal(calls[0].options.headers.Authorization,'Bearer synthetic-token');assert.equal(calls[0].options.redirect,'error');
  for(const method of['POST','PATCH'])await assert.rejects(()=>c.integrationFreshness(FRESHNESS_PATH,{method}),status(400));
  await assert.rejects(()=>c.integrationFreshness(FRESHNESS_PATH,{body:{}}),status(400));
  for(const path of[`${FRESHNESS_PATH}?entity=contacts`,`${FRESHNESS_PATH}/contacts`,'/v1/integracao-origin','/v1/integracao-origin/extra',`https://other.invalid${FRESHNESS_PATH}`])await assert.rejects(()=>c.integrationFreshness(path),status(400));
  assert.equal(calls.length,1);
 }finally{stop();}
 const bounded=createAccessController(auth,'https://api.example.test',async url=>url.endsWith('/me')?Response.json(me('admin')):new Response('{}',{headers:{'Content-Type':'application/json','Content-Length':String(256*1024+1)}}));const end=bounded.start();await tick();
 try{await assert.rejects(()=>bounded.integrationFreshness(FRESHNESS_PATH),status(502));}finally{end();}
 let finish,signal;const late=createAccessController(auth,'https://api.example.test',async(url,options)=>{if(url.endsWith('/me'))return Response.json(me('admin'));signal=options.signal;return new Promise(resolve=>{finish=resolve;});});const close=late.start();await tick();
 const result=late.integrationFreshness(FRESHNESS_PATH);await tick();await late.logout();assert.equal(signal.aborted,true);finish(Response.json(sample()));await assert.rejects(result,e=>e.name==='AbortError');close();
 // Server-side denial rechecks membership once; the demoted role is then refused locally.
 let checks=0,queries=0;const changed=createAccessController(auth,'https://api.example.test',async url=>{if(url.endsWith('/me'))return Response.json(me(++checks===1?'admin':'consulta'));queries++;return Response.json({error:{code:'ERP_FORBIDDEN'}},{status:403});});const done=changed.start();await tick();
 try{await assert.rejects(()=>changed.integrationFreshness(FRESHNESS_PATH),status(403));await tick();assert.equal(changed.getSnapshot().membership.role,'consulta');await assert.rejects(()=>changed.integrationFreshness(FRESHNESS_PATH),status(403));assert.equal(checks,2);assert.equal(queries,1);}finally{done();}
});
