import test from 'node:test';
import assert from 'node:assert/strict';
import { fiscalMirrorFixture } from './helpers/fiscal-mirror-fixture.mjs';
import { listPage, originDetail } from '../../../packages/erp-domain/src/fiscal-invoice-contract.mjs';

const MIGRATION='202610220005_fiscal_mirror_invalid_state.sql';
const note=(id,state)=>({id,numero:id,serie:1,tipo:1,situacao:5,dataEmissao:'2026-10-22',valorNota:10,contato:{nome:'Sintético',endereco:{uf:state}}});
const parse=p=>listPage(p,{origin:p.origin,model:p.model,direction:p.direction,page:p.page,limit:p.limit,order:p.order});

test('005 repairs only invalid current UFs, preserves raw/history/timestamps/counts, and accepts the real list DTO',async()=>{
 const f=await fiscalMirrorFixture();try{
  for(const [id,state]of[['1','0'],['2','ZZ'],['3','SP'],['4','ex']])await f.stage('nfce',id,note(id,state));
  const before=(await f.db.query("select source_id,to_jsonb(c)-'listing' body,listing-'state' other_listing,listing->>'state' state from erp_fiscal_mirror.current c order by source_id")).rows;
  const history=await f.scalar('select jsonb_agg(to_jsonb(o)order by entity,source_id,source_version)v from erp_fiscal_mirror.observation o');
  const raw=await f.scalar("select jsonb_agg(to_jsonb(r)order by entity,source_id)v from origin_sync.raw_record r where entity='nfce'");
  const changes=await f.scalar('select jsonb_agg(to_jsonb(s)order by entity,source_id,source_version)v from erp_fiscal_mirror.status_change s');
  const oldPage=await f.fiscalList({p_model:'65'});assert.equal(oldPage.total_count,4);assert.throws(()=>parse(oldPage),/FISCAL_RESPONSE_INVALID/);
  await f.migrate(MIGRATION);
  const after=(await f.db.query("select source_id,to_jsonb(c)-'listing' body,listing-'state' other_listing,listing->>'state' state from erp_fiscal_mirror.current c order by source_id")).rows;
  assert.deepEqual(after.map(x=>x.state),[null,null,'SP','EX']);
  assert.equal(before.filter((r,i)=>r.state!==after[i].state).length,2);
  assert.deepEqual(after.map(({state,...r})=>r),before.map(({state,...r})=>r));
  assert.deepEqual(await f.scalar('select jsonb_agg(to_jsonb(o)order by entity,source_id,source_version)v from erp_fiscal_mirror.observation o'),history);
  assert.deepEqual(await f.scalar("select jsonb_agg(to_jsonb(r)order by entity,source_id)v from origin_sync.raw_record r where entity='nfce'"),raw);
  assert.deepEqual(await f.scalar('select jsonb_agg(to_jsonb(s)order by entity,source_id,source_version)v from erp_fiscal_mirror.status_change s'),changes);
  const page=parse(await f.fiscalList({p_model:'65'}));assert.equal(page.total_count,4);assert.equal(page.total_amount,oldPage.total_amount);assert.deepEqual(page.coverage,oldPage.coverage);
  for(const [id,state]of[['1','0'],['2','ZZ']])assert.equal(originDetail(await f.rpc('erp_fiscal_invoice_origin_get',{p_user_id:f.users.admin,p_entity:'nfce',p_source_id:id})).contact.state,state);
  for(const [id,state]of[['5','0'],['6','ZZ'],['7','SP'],['8','ex']])await f.stage('nfce',id,note(id,state));
  const current=parse(await f.fiscalList({p_model:'65'}));assert.equal(current.total_count,8);
  for(const [id,state]of[['5',null],['6',null],['7','SP'],['8','EX']])assert.equal(current.items.find(r=>r.id===id).state,state);
  for(const table of['erp_fiscal_invoices.invoice','erp_finance.title','erp_stock.movement','erp_stock.balance'])assert.equal(Number(await f.scalar(`select count(*)v from ${table}`)),0);
 }finally{await f.close();}
});

test('005 refuses list_data drift before repairing any current summary',async()=>{
 const f=await fiscalMirrorFixture();try{
  await f.stage('nfce','1',note('1','0'));
  const definition=await f.scalar("select pg_get_functiondef('erp_fiscal_mirror.list_data(jsonb)'::regprocedure)v");
  await f.db.exec(definition.replace("select jsonb_build_object('number'","select /* synthetic drift */ jsonb_build_object('number'"));
  await assert.rejects(f.migrate(MIGRATION),e=>e.code==='55000'&&/previous_definition_changed/.test(e.message));await f.db.exec('rollback');
  assert.equal(await f.scalar("select listing->>'state'v from erp_fiscal_mirror.current where source_id='1'"),'0');
 }finally{await f.close();}
});
