import test from'node:test';import assert from'node:assert/strict';import{randomUUID}from'node:crypto';
import{systemFixture,fails}from'./helpers/system-fixture.mjs';
import{parseSituationsPage,captureSituationsQuery,captureSituationSave,captureTransitionSave,captureTransitionsDelete,parseSituationsResult}from'../../../packages/erp-domain/src/system-frameworks.mjs';

// Migration 148: Gerenciador de transições (the grupos de tags/tags of 148 were retired by migration 185, tested in
// preferences-c-sql). Synthetic data only.
const page=async(f,kind,user=f.users.admin)=>parseSituationsPage(await f.rpc('erp_preferences_situations',{p_user_id:user,p_kind:kind}),captureSituationsQuery({tipo:kind}));
const saveSituation=async(f,body,user=f.users.admin)=>{const s=captureSituationSave(body);return parseSituationsResult(await f.rpc('erp_preferences_situation_save',{p_user_id:user,p_command_id:s.command_id,p_kind:s.kind,p_situation:s.id,p_expected_version:s.expected_version,p_data:s.data}),s,'situation');};
const saveTransition=async(f,body,user=f.users.admin)=>{const s=captureTransitionSave(body);return parseSituationsResult(await f.rpc('erp_preferences_transition_save',{p_user_id:user,p_command_id:s.command_id,p_kind:s.kind,p_from:s.from,p_to:s.to,p_expected_version:s.expected_version,p_data:s.data}),s,'transition');};
const removeTransitions=async(f,body)=>{const s=captureTransitionsDelete(body);return parseSituationsResult(await f.rpc('erp_preferences_transitions_delete',{p_user_id:f.users.admin,p_command_id:s.command_id,p_kind:s.kind,p_items:s.items}),s,'delete');};
const situation=(kind,patch={})=>({command_id:randomUUID(),kind,id:null,expected_version:0,data:{base_status:'open',name:'Aguardando pagamento',color:'#ff8800',active:true,...patch}});

test('148 situações: the defaults come from the document rule; a custom situação is based on one, unique by name, CAS and idempotent',async()=>{const f=await systemFixture();try{
 const sales=await page(f,'sales_orders');
 assert.deepEqual(sales.situations.map(s=>s.name),['Em digitação','Em aberto','Verificado','Em andamento','Atendido parcialmente','Atendido','Cancelado']);
 assert.equal(sales.adopted,false);assert.equal(sales.transitions.length,34);assert.ok(sales.transitions.every(t=>t.default&&t.active&&t.version===0&&!t.actions.length));
 assert.deepEqual(sales.rules.partially_fulfilled,['in_progress','fulfilled','cancelled']);
 assert.deepEqual((await page(f,'service_orders')).situations.map(s=>s.name).slice(0,3),['Em aberto','Orçada','Aprovada']);
 assert.equal((await page(f,'purchase_orders')).transitions.length,10);
 for(const user of[f.users.vendas,f.users.consulta,f.users.inactive,randomUUID()])await fails(assert,()=>page(f,'sales_orders',user),'42501');
 await fails(assert,()=>f.rpc('erp_preferences_situations',{p_user_id:f.users.admin,p_kind:'sales_proposals'}),'22023');
 const body=situation('sales_orders'),created=await saveSituation(f,body);assert.equal(created.replayed,false);
 const replay=await saveSituation(f,body);assert.equal(replay.replayed,true);assert.equal(replay.receipt.target,created.receipt.target);
 await fails(assert,()=>f.rpc('erp_preferences_situation_save',{p_user_id:f.users.admin,p_command_id:body.command_id,p_kind:'sales_orders',p_situation:null,p_expected_version:0,p_data:{...body.data,name:'Outro nome'}}),'40001');
 await fails(assert,()=>saveSituation(f,situation('sales_orders')),'23505');
 await fails(assert,()=>saveSituation(f,situation('sales_orders',{name:'em aberto'})),'23505');
 assert.equal((await saveSituation(f,situation('purchase_orders'))).receipt.kind,'purchase_orders','the same name in another tab');
 await fails(assert,()=>saveSituation(f,situation('sales_orders',{name:'Sem base',base_status:'quoted'})),'22023');
 await fails(assert,()=>saveSituation(f,situation('sales_orders',{name:'Pelo vendedor'}),f.users.vendas),'42501');
 const key=created.receipt.target;let view=await page(f,'sales_orders');const custom=view.situations.find(s=>s.key===key);
 assert.deepEqual([custom.base_status,custom.name,custom.default,custom.active,custom.version],['open','Aguardando pagamento',false,true,1]);
 assert.equal(view.situations.findIndex(s=>s.key===key),2,'listed right after its base');
 // Editing: Nome, Cor and ativa; "Baseada em" is fixed; a stale version conflicts; the same values are refused.
 await saveSituation(f,{command_id:randomUUID(),kind:'sales_orders',id:key,expected_version:1,data:{base_status:'open',name:'Aguardando PIX',color:'#00aa00',active:false}});
 await fails(assert,()=>saveSituation(f,{command_id:randomUUID(),kind:'sales_orders',id:key,expected_version:1,data:{base_status:'open',name:'De novo',color:'#00aa00',active:true}}),'40001');
 await fails(assert,()=>saveSituation(f,{command_id:randomUUID(),kind:'sales_orders',id:key,expected_version:2,data:{base_status:'verified',name:'Aguardando PIX',color:'#00aa00',active:false}}),'22023');
 await fails(assert,()=>saveSituation(f,{command_id:randomUUID(),kind:'sales_orders',id:key,expected_version:2,data:{base_status:'open',name:'Aguardando PIX',color:'#00aa00',active:false}}),'22023');
 await fails(assert,()=>saveSituation(f,{command_id:randomUUID(),kind:'purchase_orders',id:key,expected_version:2,data:{base_status:'open',name:'Outra aba',color:'#00aa00',active:true}}),'P0002');
 view=await page(f,'sales_orders');assert.deepEqual(view.situations.filter(s=>!s.default).map(s=>[s.name,s.active,s.version]),[['Aguardando PIX',false,2]]);
 // Limit of 30 custom situações per tab.
 for(let i=0;i<29;i++)await saveSituation(f,situation('sales_orders',{name:`Situação ${i}`}));
 await fails(assert,()=>saveSituation(f,situation('sales_orders',{name:'Trigésima primeira'})),'22023');
 assert.equal((await page(f,'sales_orders')).situations.length,37);
 const audit=await f.db.query("select action,target,before_data,after_data from erp_preferences.framework_audit where area='situations' order by id limit 2");
 assert.deepEqual(audit.rows.map(r=>r.action),['situation_create','situation_create']);assert.equal(audit.rows[0].before_data,null);assert.equal(audit.rows[0].after_data.name,'Aguardando pagamento');
}finally{await f.close();}});

test('148 transições: custom pairs follow the base rule, default ones are only deactivated, actions wait for adoption and deletions are by version',async()=>{const f=await systemFixture();try{
 const a=(await saveSituation(f,situation('purchase_orders',{name:'Aguardando NF'}))).receipt.target;
 const b=(await saveSituation(f,situation('purchase_orders',{name:'Recebido conferido',base_status:'fulfilled'}))).receipt.target;
 // open → fulfilled is not allowed by the purchase rule; open → Aguardando NF (same base) and Aguardando NF → in_progress are.
 await fails(assert,()=>saveTransition(f,{command_id:randomUUID(),kind:'purchase_orders',from:a,to:b,expected_version:0,data:{active:true,actions:[]}}),'22023');
 await fails(assert,()=>saveTransition(f,{command_id:randomUUID(),kind:'purchase_orders',from:'open',to:'fulfilled',expected_version:0,data:{active:true,actions:[]}}),'22023');
 const body={command_id:randomUUID(),kind:'purchase_orders',from:'open',to:a,expected_version:0,data:{active:true,actions:[]}};await saveTransition(f,body);
 assert.equal((await saveTransition(f,body)).replayed,true);
 await saveTransition(f,{command_id:randomUUID(),kind:'purchase_orders',from:a,to:'in_progress',expected_version:0,data:{active:true,actions:[]}});
 await fails(assert,()=>saveTransition(f,{command_id:randomUUID(),kind:'purchase_orders',from:'open',to:a,expected_version:0,data:{active:false,actions:[]}}),'40001');
 await fails(assert,()=>saveTransition(f,{command_id:randomUUID(),kind:'purchase_orders',from:'open',to:randomUUID(),expected_version:0,data:{active:true,actions:[]}}),'P0002');
 let view=await page(f,'purchase_orders');const custom=view.transitions.find(t=>t.from==='open'&&t.to===a);
 assert.deepEqual([custom.default,custom.active,custom.actions],[false,true,[]]);assert.equal(view.transitions.length,12);
 // Actions are refused until the documents lane adopts the kind.
 await fails(assert,()=>saveTransition(f,{command_id:randomUUID(),kind:'purchase_orders',from:'in_progress',to:'fulfilled',expected_version:0,data:{active:true,actions:['post_stock']}}),'22023');
 // A default transition is deactivated by overriding it; it cannot be deleted.
 await saveTransition(f,{command_id:randomUUID(),kind:'purchase_orders',from:'fulfilled',to:'open',expected_version:0,data:{active:false,actions:[]}});
 await fails(assert,()=>saveTransition(f,{command_id:randomUUID(),kind:'purchase_orders',from:'cancelled',to:'open',expected_version:0,data:{active:true,actions:[]}}),'22023');
 view=await page(f,'purchase_orders');const off=view.transitions.find(t=>t.from==='fulfilled'&&t.to==='open');assert.deepEqual([off.default,off.active],[true,false]);assert.ok(off.version>0);
 await fails(assert,()=>removeTransitions(f,{command_id:randomUUID(),kind:'purchase_orders',items:[{from:'fulfilled',to:'open',expected_version:off.version}]}),'22023');
 // Adoption API read by the documents lane.
 assert.deepEqual(await f.scalar("select erp_preferences.transition_rule('purchase_orders','fulfilled','open') v"),{default:true,configured:true,active:false,actions:[],from_base:'fulfilled',to_base:'open'});
 assert.equal(await f.scalar("select erp_preferences.transition_rule('purchase_orders','open','fulfilled') v"),null);
 assert.deepEqual(await f.scalar("select erp_preferences.transition_rule('purchase_orders','in_progress','fulfilled') v"),{default:true,configured:true,active:true,actions:[],from_base:'in_progress',to_base:'fulfilled'});
 assert.equal((await f.scalar(`select erp_preferences.transition_rule('purchase_orders','${a}','open') v`)).configured,false);
 assert.equal((await f.scalar(`select erp_preferences.situation_of('purchase_orders','${a}') v`)).base_status,'open');
 await f.db.query("insert into erp_preferences.situation_adoption(kind,migration)values('purchase_orders','202610200160')");
 await saveTransition(f,{command_id:randomUUID(),kind:'purchase_orders',from:'in_progress',to:'fulfilled',expected_version:0,data:{active:true,actions:['post_finance','post_stock']}});
 // The contract refuses opposite actions; the SQL refuses them too.
 assert.throws(()=>captureTransitionSave({command_id:randomUUID(),kind:'purchase_orders',from:'fulfilled',to:'open',expected_version:off.version,data:{active:true,actions:['post_stock','reverse_stock']}}),/ERP_INVALID_INPUT/);
 await fails(assert,()=>f.rpc('erp_preferences_transition_save',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_kind:'purchase_orders',p_from:'fulfilled',p_to:'open',p_expected_version:off.version,p_data:{active:true,actions:['post_stock','reverse_stock']}}),'22023');
 assert.deepEqual((await f.scalar("select erp_preferences.transition_rule('purchase_orders','in_progress','fulfilled') v")).actions,['post_finance','post_stock']);
 view=await page(f,'purchase_orders');assert.equal(view.adopted,true);
 // A deactivated situação turns its transitions off for the documents.
 await saveSituation(f,{command_id:randomUUID(),kind:'purchase_orders',id:a,expected_version:1,data:{base_status:'open',name:'Aguardando NF',color:'#ff8800',active:false}});
 assert.equal((await f.scalar(`select erp_preferences.transition_rule('purchase_orders','open','${a}') v`)).active,false);
 // Excluir selecionados: all or nothing, each by version; a pair created again gets a version never used before.
 view=await page(f,'purchase_orders');const items=view.transitions.filter(t=>!t.default).map(t=>({from:t.from,to:t.to,expected_version:t.version}));assert.equal(items.length,2);
 await fails(assert,()=>removeTransitions(f,{command_id:randomUUID(),kind:'purchase_orders',items:[items[0],{...items[1],expected_version:items[1].expected_version+100}]}),'40001');
 assert.equal((await page(f,'purchase_orders')).transitions.filter(t=>!t.default).length,2);
 const removed=await removeTransitions(f,{command_id:randomUUID(),kind:'purchase_orders',items});assert.equal(removed.receipt.count,2);
 assert.equal((await page(f,'purchase_orders')).transitions.filter(t=>!t.default).length,0);
 await saveTransition(f,{command_id:randomUUID(),kind:'purchase_orders',from:'open',to:a,expected_version:0,data:{active:true,actions:[]}});
 const again=(await page(f,'purchase_orders')).transitions.find(t=>t.from==='open'&&t.to===a);assert.ok(again.version>Math.max(...items.map(i=>i.expected_version)));
 await fails(assert,()=>removeTransitions(f,{command_id:randomUUID(),kind:'purchase_orders',items:[items.find(i=>i.from==='open')]}),'40001');
 const audit=(await f.db.query("select action from erp_preferences.framework_audit where area='situations' and action like 'transition%' order by id")).rows.map(r=>r.action);
 assert.deepEqual(audit,['transition_save','transition_save','transition_save','transition_save','transition_delete','transition_delete','transition_save']);
}finally{await f.close();}});

test('148 situações RPCs: only service_role executes them; the history is immutable',async()=>{const f=await systemFixture();try{
 await saveSituation(f,situation('sales_orders'));
 for(const role of['anon','authenticated'])assert.equal(await f.scalar(`select has_function_privilege('${role}','public.erp_preferences_transitions_delete(uuid,uuid,text,jsonb)','execute') v`),false);
 assert.equal(await f.scalar("select has_function_privilege('service_role','public.erp_preferences_situations(uuid,text)','execute') v"),true);
 assert.equal(await f.scalar("select has_function_privilege('service_role','erp_preferences.transition_rule(text,text,text)','execute') v"),false);
 await assert.rejects(()=>f.db.query('delete from erp_preferences.framework_audit'),/erp_preferences_history_immutable/);
}finally{await f.close();}});

test('148 Registro de atividades: these screens enter the log and an entry opens antes e depois; modules without them say so',async()=>{const f=await systemFixture();try{
 const{captureActivityQuery,parseActivity,captureActivityDetailQuery,parseActivityDetail}=await import('../../../packages/erp-domain/src/activity.mjs');
 const day=await f.scalar("select (clock_timestamp() at time zone 'America/Sao_Paulo')::date::text v");
 const key=(await saveSituation(f,situation('sales_orders'))).receipt.target;
 await saveSituation(f,{command_id:randomUUID(),kind:'sales_orders',id:key,expected_version:1,data:{base_status:'open',name:'Aguardando PIX',color:'#ff8800',active:true}});
 const c=await f.catalog('contacts',{name:'Cliente do registro'});
 const q=captureActivityQuery({from:day,to:day,module:'preferencias'});
 const log=parseActivity(await f.rpc('erp_activity_list',{p_user_id:f.users.admin,p_from:q.from,p_to:q.to,p_module:q.module,p_operation:q.operation,p_actor:q.actor,p_query:q.q,p_limit:q.limit,p_offset:q.offset}),q);
 assert.deepEqual(log.items.map(e=>[e.source,e.operation,e.description]),[['frameworks','atualizacao','Situação personalizada'],['frameworks','criacao','Situação personalizada']]);
 const dq=captureActivityDetailQuery({source:'frameworks',id:log.items[0].id}),detail=parseActivityDetail(await f.rpc('erp_activity_detail',{p_user_id:f.users.admin,p_source:dq.source,p_entry_id:dq.id}),dq);
 assert.deepEqual([detail.available,detail.before.name,detail.after.name],[true,'Aguardando pagamento','Aguardando PIX']);
 const all=captureActivityQuery({from:day,to:day,module:'clientes_fornecedores'});
 const entry=parseActivity(await f.rpc('erp_activity_list',{p_user_id:f.users.admin,p_from:all.from,p_to:all.to,p_module:all.module,p_operation:null,p_actor:null,p_query:null,p_limit:100,p_offset:0}),all).items[0];
 const created=await f.rpc('erp_activity_detail',{p_user_id:f.users.admin,p_source:'catalog',p_entry_id:entry.id});assert.equal(created.before,null);assert.ok(created.after&&created.available);assert.ok(c.id);
 const stock=await f.rpc('erp_activity_detail',{p_user_id:f.users.admin,p_source:'stock',p_entry_id:'60000000-0000-4000-8000-000000000001'});
 assert.deepEqual([stock.available,stock.truncated,stock.before,stock.after],[false,false,null,null]);
 await fails(assert,()=>f.rpc('erp_activity_detail',{p_user_id:f.users.admin,p_source:'catalog',p_entry_id:'999999'}),'P0002');
 await fails(assert,()=>f.rpc('erp_activity_detail',{p_user_id:f.users.admin,p_source:'catalog',p_entry_id:'x'}),'22023');
 await fails(assert,()=>f.rpc('erp_activity_detail',{p_user_id:f.users.vendas,p_source:'frameworks',p_entry_id:log.items[0].id}),'42501');
}finally{await f.close();}});

test('148 review: the antes e depois of an entry is measured in bytes, so an accented detail never passes the route bound',async()=>{const f=await systemFixture();try{
 const{captureActivityDetailQuery,parseActivityDetail}=await import('../../../packages/erp-domain/src/activity.mjs');
 const command=randomUUID(),big=JSON.stringify({nome:'Á'.repeat(140000)});
 await f.db.query("insert into erp_preferences.framework_command(id,actor,area,request_hash,result) values($1,$2,'tags',repeat('a',64),'{}'::jsonb)",[command,f.users.admin]);
 const id=await f.scalar("insert into erp_preferences.framework_audit(actor,command_id,area,action,target,before_data,after_data) values($1,$2,'tags','tag_update','sintetico',$3::jsonb,'{}'::jsonb) returning id::text v",[f.users.admin,command,big]);
 // 140 000 characters but 280 000 bytes: above the 256 KiB the Worker reads, so the detail must come truncated.
 const v=parseActivityDetail(await f.rpc('erp_activity_detail',{p_user_id:f.users.admin,p_source:'frameworks',p_entry_id:id}),captureActivityDetailQuery({source:'frameworks',id}));
 assert.deepEqual([v.available,v.truncated,v.before,v.after],[true,true,null,null]);
}finally{await f.close();}});
