import test from'node:test';import assert from'node:assert/strict';
import{parsePreferencesRoute as parse,preferencesMethods,executePreferencesRoute}from'../src/preferences.mjs';
import{parseReportRows,parseReports,REPORT_BASES,LABEL_DEFAULTS}from'../../../packages/erp-domain/src/reports-labels.mjs';
import{createHandler}from'../src/index.mjs';
const ACTOR='10000000-0000-4000-8000-000000000149',COMMAND='20000000-0000-4000-8000-000000000149',ID='30000000-0000-4000-8000-000000000149',STAMP='2026-10-20T12:00:00.000000+00:00';
const req=(path,init)=>new Request('https://synthetic.invalid'+path,init);
const json=(path,body)=>req(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
const run={base:'vendas',columns:['numero','total'],filters:[],view_limit:2000,offset:0,page:20};
const rows=(over={})=>({scope:'report_rows',data_mode:'erp_native',base:'vendas',columns:['numero','total'],rows:[['1','5.00']],offset:0,total_rows:1,truncated:false,totals:{total:'5.00'},...over});

test('149 strict /v1/sistema routes for relatórios and etiquetas',async()=>{
 assert.deepEqual(preferencesMethods('/v1/sistema/relatorios'),['GET','POST']);assert.deepEqual(preferencesMethods('/v1/sistema/relatorios/execucao'),['POST']);assert.deepEqual(preferencesMethods('/v1/sistema/etiquetas/registros'),['GET']);
 const r=await parse(json('/v1/sistema/relatorios/execucao',run));assert.equal(r.mutation,false);assert.equal(r.rpc,'erp_preferences_report_run');assert.deepEqual(r.args.p_columns,['numero','total']);
 const s=await parse(json('/v1/sistema/relatorios',{command_id:COMMAND,id:null,expected_version:0,data:{base:'vendas',title:'Vendas',columns:['numero'],filters:[],view_limit:10,with_totals:false,users:[ACTOR]}}));assert.equal(s.mutation,true);
 const l=await parse(json('/v1/sistema/etiquetas',{command_id:COMMAND,id:null,expected_version:0,data:{type:'produto',description:'Gôndola',config:LABEL_DEFAULTS[1].config}}));assert.equal(l.rpc,'erp_preferences_label_save');
 assert.deepEqual({...(await parse(json('/v1/sistema/etiquetas/exclusao',{command_id:COMMAND,items:[{id:ID,expected_version:1}]}))).args},{p_command_id:COMMAND,p_target:'labels',p_items:[{id:ID,expected_version:1}]});
 assert.deepEqual({...(await parse(req('/v1/sistema/etiquetas/registros?tipo=produto&busca=Caneta'))).args},{p_type:'produto',p_query:'Caneta'});
 for(const path of['/v1/sistema/relatorios?x=1','/v1/sistema/etiquetas/registros?tipo=notas','/v1/sistema/etiquetas/registros'])await assert.rejects(()=>parse(req(path)),e=>e.status===400,path);
 for(const body of[{...run,columns:['numero','numero']},{...run,filters:[{column:'total',value:'dez'}]},{...run,page:201},{...run,offset:2000},{...run,base:'notas'}])
  await assert.rejects(()=>parse(json('/v1/sistema/relatorios/execucao',body)),e=>e.status===400,JSON.stringify(body));
 const far=structuredClone(LABEL_DEFAULTS[1].config);far.fields[0].y='31';
 await assert.rejects(()=>parse(json('/v1/sistema/etiquetas',{command_id:COMMAND,id:null,expected_version:0,data:{type:'produto',description:'Fora',config:far}})),e=>e.status===400);
});

test('149 projections fail closed',()=>{
 assert.equal(parseReportRows(rows(),run).rows.length,1);
 for(const mutate of[v=>v.rows[0][1]='5',v=>v.totals={},v=>v.columns=['total','numero'],v=>v.total_rows=0,v=>v.rows.push(['2','1.00']),v=>v.rows[0].push('x'),v=>v.base='propostas'])
 {const v=rows();mutate(v);assert.throws(()=>parseReportRows(v,run),undefined,String(mutate));}
 const list={scope:'reports',data_mode:'erp_native',can_manage:false,bases:JSON.parse(JSON.stringify(REPORT_BASES.slice(0,2))),reports:[],directory:null};assert.equal(parseReports(list).bases.length,2);
 assert.throws(()=>parseReports({...list,bases:[list.bases[1],list.bases[0]]}));assert.throws(()=>parseReports({...list,directory:[]}));
 const changed=JSON.parse(JSON.stringify(list));changed.bases[0].columns[0].type='money';assert.throws(()=>parseReports(changed));
});

const env={SUPABASE_URL:'https://project.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic-149',ALLOWED_ORIGINS:'https://erp.synthetic.test'},headers={Authorization:'Bearer synthetic-token',Origin:'https://erp.synthetic.test','content-type':'application/json'};
test('149 composed handler binds the actor; a run is a read and a lost report save is ERP_RESULT_UNCONFIRMED',async()=>{
 const calls=[],h=createHandler({fetchImpl:async(url,o)=>{calls.push({url,o});return Response.json(url.endsWith('/auth/v1/user')?{id:ACTOR}:rows());}});
 const r=await h(new Request('https://api.synthetic.test/v1/sistema/relatorios/execucao',{method:'POST',headers,body:JSON.stringify(run)}),env);assert.equal(r.status,200);
 assert.ok(calls[1].url.endsWith('/rest/v1/rpc/erp_preferences_report_run'));assert.equal(JSON.parse(calls[1].o.body).p_user_id,ACTOR);
 const read=await parse(json('/v1/sistema/relatorios/execucao',run));
 await assert.rejects(()=>executePreferencesRoute(read,{userId:ACTOR,rpc:async()=>{throw new TypeError('network');}}),e=>e.status===502);
 const save=await parse(json('/v1/sistema/relatorios/exclusao',{command_id:COMMAND,items:[{id:ID,expected_version:1}]}));
 await assert.rejects(()=>executePreferencesRoute(save,{userId:ACTOR,rpc:async()=>{throw new TypeError('network');}}),e=>e.status===503&&e.code==='ERP_RESULT_UNCONFIRMED');
});
