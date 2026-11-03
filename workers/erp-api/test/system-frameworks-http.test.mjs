import test from'node:test';import assert from'node:assert/strict';
import{parsePreferencesRoute as parse,preferencesMethods,executePreferencesRoute}from'../src/preferences.mjs';
import{parseSituationsPage}from'../../../packages/erp-domain/src/system-frameworks.mjs';
import{createHandler}from'../src/index.mjs';
const ACTOR='10000000-0000-4000-8000-000000000148',COMMAND='20000000-0000-4000-8000-000000000148',ID='30000000-0000-4000-8000-000000000148',STAMP='2026-10-20T12:00:00.000000+00:00';
const req=(path,init)=>new Request('https://synthetic.invalid'+path,init);
const json=(path,body)=>req(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
const page=(over={})=>({scope:'situations_page',data_mode:'erp_native',kind:'purchase_orders',adopted:false,
 situations:[{key:'open',base_status:'open',name:'Em aberto',color:'#e6a700',default:true,active:true,version:0},{key:'cancelled',base_status:'cancelled',name:'Cancelado',color:'#d32f2f',default:true,active:true,version:0},
  {key:ID,base_status:'open',name:'Aguardando NF',color:'#ff8800',default:false,active:true,version:1}],
 rules:{open:['cancelled'],cancelled:['open']},
 transitions:[{from:'open',to:'cancelled',default:true,active:true,actions:[],version:0},{from:'cancelled',to:'open',default:true,active:false,actions:[],version:4},{from:'open',to:ID,default:false,active:true,actions:[],version:5}],...over});

test('148 strict /v1/sistema routes for situações and transições; the tags routes are gone (185)',async()=>{
 assert.deepEqual(preferencesMethods('/v1/sistema/situacoes'),['GET','POST']);assert.deepEqual(preferencesMethods('/v1/sistema/transicoes'),['POST']);
 for(const path of['/v1/sistema/tags','/v1/sistema/tags/grupos'])await assert.rejects(()=>parse(req(path)),e=>e.status===404,path);
 for(const path of['/v1/sistema/tags/grupos?tipo=produtos','/v1/sistema/tags?grupo='+ID])await assert.rejects(()=>parse(req(path)),e=>e.status===400,path);
 for(const path of['/v1/sistema/tags','/v1/sistema/tags/grupos','/v1/sistema/tags/exclusao','/v1/sistema/tags/grupos/exclusao'])await assert.rejects(()=>parse(json(path,{command_id:COMMAND,items:[{id:ID,expected_version:2}]})),e=>[400,404,405].includes(e.status),path);
 assert.deepEqual({...(await parse(req('/v1/sistema/situacoes?tipo=service_orders'))).args},{p_kind:'service_orders'});
 assert.deepEqual({...(await parse(req('/v1/sistema/situacoes'))).args},{p_kind:'sales_orders'});
 const save=await parse(json('/v1/sistema/situacoes',{command_id:COMMAND,kind:'sales_orders',id:null,expected_version:0,data:{base_status:'open',name:'Aguardando pagamento',color:'#ff8800',active:true}}));
 assert.equal(save.mutation,true);assert.equal(save.rpc,'erp_preferences_situation_save');assert.equal(save.args.p_situation,null);
 const t=await parse(json('/v1/sistema/transicoes',{command_id:COMMAND,kind:'sales_orders',from:'open',to:ID,expected_version:0,data:{active:true,actions:['post_finance','post_stock']}}));assert.deepEqual(t.args.p_data,{active:true,actions:['post_finance','post_stock']});
 for(const path of['/v1/sistema/situacoes?tipo=sales_proposals','/v1/sistema/situacoes?tipo=a&tipo=b'])
  await assert.rejects(()=>parse(req(path)),e=>e.status===400,path);
 for(const [path,body] of[['/v1/sistema/situacoes',{command_id:COMMAND,kind:'sales_orders',id:null,expected_version:1,data:{base_status:'open',name:'X',color:'#ff8800',active:true}}],
  ['/v1/sistema/situacoes',{command_id:COMMAND,kind:'sales_orders',id:null,expected_version:0,data:{base_status:'open',name:' X',color:'#ff8800',active:true}}],
  ['/v1/sistema/situacoes',{command_id:COMMAND,kind:'sales_orders',id:null,expected_version:0,data:{base_status:'open',name:'X',color:'red',active:true}}],
  ['/v1/sistema/transicoes',{command_id:COMMAND,kind:'sales_orders',from:'open',to:'open',expected_version:0,data:{active:true,actions:[]}}],
  ['/v1/sistema/transicoes',{command_id:COMMAND,kind:'sales_orders',from:'open',to:ID,expected_version:0,data:{active:true,actions:['post_stock','post_finance']}}],
  ['/v1/sistema/transicoes',{command_id:COMMAND,kind:'sales_orders',from:'open',to:ID,expected_version:0,data:{active:true,actions:['post_stock','reverse_stock']}}],
  ['/v1/sistema/transicoes/exclusao',{command_id:COMMAND,kind:'sales_orders',items:[{from:'open',to:ID,expected_version:0}]}]])
  await assert.rejects(()=>parse(json(path,body)),e=>e.status===400,JSON.stringify(body));
 await assert.rejects(()=>parse(req('/v1/sistema/transicoes')),e=>e.status===405);
});

test('148 projections fail closed: default pairs present, keys known, actions only after adoption',()=>{
 const q={kind:'purchase_orders'};assert.equal(parseSituationsPage(page(),q).transitions.length,3);
 for(const mutate of[v=>v.transitions.shift(),v=>v.transitions[2].to='in_progress',v=>v.transitions[2].actions=['post_stock'],v=>v.transitions[0].active=false,v=>v.situations[2].base_status='fulfilled',
  v=>v.situations[2].name='em aberto',v=>v.situations[0].version=1,v=>v.kind='sales_orders',v=>v.rules.open=['open'],v=>v.transitions[2].default=true,v=>v.situations[2].extra=1])
 {const v=page();mutate(v);assert.throws(()=>parseSituationsPage(v,q),undefined,String(mutate));}
 const adopted=page({adopted:true});adopted.transitions[2].actions=['post_finance','post_stock'];assert.equal(parseSituationsPage(adopted,q).adopted,true);
});

const env={SUPABASE_URL:'https://project.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic-148',ALLOWED_ORIGINS:'https://erp.synthetic.test'},headers={Authorization:'Bearer synthetic-token',Origin:'https://erp.synthetic.test'};
test('148 composed handler binds the token actor; a lost situação command is ERP_RESULT_UNCONFIRMED',async()=>{
 const calls=[],h=createHandler({fetchImpl:async(url,o)=>{calls.push({url,o});return Response.json(url.endsWith('/auth/v1/user')?{id:ACTOR}:page());}});
 const r=await h(new Request('https://api.synthetic.test/v1/sistema/situacoes?tipo=purchase_orders',{headers}),env);assert.equal(r.status,200);
 assert.ok(calls[1].url.endsWith('/rest/v1/rpc/erp_preferences_situations'));assert.deepEqual(JSON.parse(calls[1].o.body),{p_kind:'purchase_orders',p_user_id:ACTOR});
 const route=await parse(json('/v1/sistema/transicoes/exclusao',{command_id:COMMAND,kind:'purchase_orders',items:[{from:'open',to:ID,expected_version:5}]}));
 await assert.rejects(()=>executePreferencesRoute(route,{userId:ACTOR,rpc:async()=>{throw new TypeError('network');}}),e=>e.status===503&&e.code==='ERP_RESULT_UNCONFIRMED');
 await assert.rejects(()=>executePreferencesRoute(route,{userId:ACTOR,rpc:async()=>{throw Object.assign(new Error('x'),{code:'40001'});}}),e=>e.status===409);
});

test('148 Registro de atividades detail: strict route and a closed answer',async()=>{
 const{parseActivityDetail}=await import('../../../packages/erp-domain/src/activity.mjs');
 assert.deepEqual(preferencesMethods('/v1/registro-atividades/detalhe'),['GET']);
 const route=await parse(req('/v1/registro-atividades/detalhe?origem=catalog&id=12'));assert.equal(route.rpc,'erp_activity_detail');assert.deepEqual({...route.args},{p_source:'catalog',p_entry_id:'12'});
 for(const path of['/v1/registro-atividades/detalhe?origem=x&id=1','/v1/registro-atividades/detalhe?origem=catalog','/v1/registro-atividades/detalhe?origem=catalog&id=1&id=2','/v1/registro-atividades/detalhe?origem=catalog&id=%20'])
  await assert.rejects(()=>parse(req(path)),e=>e.status===400,path);
 await assert.rejects(()=>parse(req('/v1/registro-atividades/outro')),e=>e.status===404);
 const ok={scope:'activity_detail',data_mode:'erp_native',source:'catalog',id:'12',available:true,truncated:false,before:null,after:{name:'X'}},q={source:'catalog',id:'12'};
 assert.equal(parseActivityDetail(ok,q).after.name,'X');
 for(const bad of[{...ok,available:false},{...ok,truncated:true},{...ok,id:'13'},{...ok,extra:1}])assert.throws(()=>parseActivityDetail(bad,q));
 assert.throws(()=>parseActivityDetail({...ok,source:'stock',before:{a:1}},{source:'stock',id:'12'}));
});
