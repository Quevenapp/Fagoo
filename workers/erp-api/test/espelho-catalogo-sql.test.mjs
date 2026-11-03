import test from'node:test';import assert from'node:assert/strict';import{randomUUID}from'node:crypto';
import{espelhoHFixture,fails}from'./helpers/espelho-h-fixture.mjs';

// Leva H, lane espelho (350-352: CTT-083, PRD-112, EST-057, PRD-138, PRD-006). Synthetic Origin payloads only.
const contact=(id,extra={})=>({id,nome:`Contato ${id}`,codigo:`C${id}`,situacao:'A',tipo:'J',numeroDocumento:'',fantasia:'',...extra});
const product=(id,extra={})=>({id,nome:`Produto ${id}`,codigo:`P${id}`,situacao:'A',tipo:'P',formato:'S',unidade:'UN',preco:10,...extra});
const recordOf=async(f,entity,source)=>f.scalar('select record_id v from erp_catalog.origin where entity=$1 and source_id=$2',[entity,String(source)]);

test('H 350: the contact mirror keeps the Origin fields apart, maps tiposContato and is idempotent',async()=>{const f=await espelhoHFixture();try{
 await f.mirror('contacts','501',contact(501,{fantasia:'Transp Sintética',indicadorIe:1,ie:'123',rg:'',emailNotaFiscal:'nfe@sintetico.test',
  endereco:{geral:{cep:'01001-000',endereco:'Rua A',numero:'1',bairro:'Centro',municipio:'São Paulo',uf:'SP'},cobranca:{cep:'02002-000',endereco:'Rua B',municipio:'Santos',uf:'SP'}},
  tiposContato:[{id:1,descricao:'Transportador'},{id:2,descricao:'Cliente'}],vendedor:{id:77},financeiro:{limiteCredito:1500.5,condicaoPagamento:'30 60'},pais:{nome:'Brasil'}}));
 assert.equal((await f.importOrigin('contacts',['501'])).items[0].action,'create');
 const id=await recordOf(f,'contacts',501);
 assert.deepEqual(await f.scalar("select to_jsonb(roles) v from erp_catalog.contact where record_id=$1",[id]),['carrier','customer']);
 const mirror=await f.rpc('erp_catalog_origin_mirror_get',{p_user_id:f.users.admin,p_entity:'contacts',p_id:id});
 assert.equal(mirror.linked,true);assert.equal(mirror.source_id,'501');assert.equal(mirror.pending,false);assert.ok(mirror.synced_at);
 assert.equal(mirror.fields.nfe_email,'nfe@sintetico.test');assert.equal(mirror.fields.billing_address.city,'Santos');assert.equal(mirror.fields.credit_limit,'1500.500000');
 assert.deepEqual(mirror.fields.contact_types,['Cliente','Transportador']);assert.equal(mirror.fields.seller_source_id,'77');
 assert.equal(mirror.fields.rg,undefined,'an empty Origin value is not a field');
 const synced=mirror.synced_at;
 // The same payload again (a repeated event): nothing to apply, the mirror keeps its synchronization date.
 await f.mirror('contacts','501',contact(501,{fantasia:'Transp Sintética',indicadorIe:1,ie:'123',rg:'',emailNotaFiscal:'nfe@sintetico.test',
  endereco:{geral:{cep:'01001-000',endereco:'Rua A',numero:'1',bairro:'Centro',municipio:'São Paulo',uf:'SP'},cobranca:{cep:'02002-000',endereco:'Rua B',municipio:'Santos',uf:'SP'}},
  tiposContato:[{id:1,descricao:'Transportador'},{id:2,descricao:'Cliente'}],vendedor:{id:77},financeiro:{limiteCredito:1500.5,condicaoPagamento:'30 60'},pais:{nome:'Brasil'}}));
 assert.equal((await f.importOrigin('contacts',['501'])).items[0].action,'unchanged');
 assert.equal((await f.rpc('erp_catalog_origin_mirror_get',{p_user_id:f.users.admin,p_entity:'contacts',p_id:id})).synced_at,synced);
 // A newer source not yet applied shows as pending; applying it moves the mirror.
 await f.mirror('contacts','501',contact(501,{fantasia:'Transp Renomeada',tiposContato:[{descricao:'Transportadora'}]}));
 assert.equal((await f.rpc('erp_catalog_origin_mirror_get',{p_user_id:f.users.admin,p_entity:'contacts',p_id:id})).pending,true);
 await f.importOrigin('contacts',['501']);
 const after=await f.rpc('erp_catalog_origin_mirror_get',{p_user_id:f.users.admin,p_entity:'contacts',p_id:id});
 assert.equal(after.pending,false);assert.equal(after.fields.trade_name,'Transp Renomeada');assert.equal(after.fields.nfe_email,undefined);
 // Brufap-only complements are listed apart and a local contact has no mirror.
 const local=(await f.catalog('contacts',{name:'Contato local'})).id;
 const none=await f.rpc('erp_catalog_origin_mirror_get',{p_user_id:f.users.admin,p_entity:'contacts',p_id:local});
 assert.equal(none.linked,false);assert.deepEqual(none.fields,{});
 await fails(assert,()=>f.rpc('erp_catalog_origin_mirror_get',{p_user_id:f.users.admin,p_entity:'contacts',p_id:randomUUID()}),'P0002');
}finally{await f.close();}});

test('H 350: product import brings the widened Origin fields; an invalid value stays only in the mirror',async()=>{const f=await espelhoHFixture();try{
 await f.mirror('products','601',product(601,{marca:'Marca X',condicao:1,tipoProducao:'T',pesoLiquido:0.5,pesoBruto:0.75,volumes:2,itensPorCaixa:12,
  dimensoes:{largura:10,altura:20.5,profundidade:3,unidadeMedida:1},gtin:'7891234567895',gtinEmbalagem:'ABC',estoque:{minimo:1,maximo:9,crossdocking:3,localizacao:'A-01'},
  tributacao:{origem:0,ncm:'8471.30.12',cest:'01.003.00',dadosAdicionais:'Info sintética'},descricaoComplementar:'<p>Rica</p>',categoria:{id:900}}));
 assert.equal((await f.importOrigin('products',['601'])).items[0].action,'create');
 const id=await recordOf(f,'products',601);
 const row=await f.scalar("select jsonb_build_object('brand',brand,'condition',condition,'production',production,'net',net_weight::text,'gross',gross_weight::text,'width',width::text,'unit',dimension_unit,'volumes',volumes,'box',items_per_box,'gtin_tax',gtin_tax,'min',stock_min::text,'max',stock_max::text,'location',location,'cest',cest,'origin',origin,'info',additional_info,'ncm',ncm) v from erp_catalog.product where record_id=$1",[id]);
 assert.deepEqual(row,{brand:'Marca X',condition:'new',production:'third_party',net:'0.500000',gross:'0.750000',width:'10.000000',unit:'cm',volumes:2,box:12,gtin_tax:null,
  min:'1.000000',max:'9.000000',location:'A-01',cest:'0100300',origin:'0',info:'Info sintética',ncm:'84713012'});
 const mirror=await f.rpc('erp_catalog_origin_mirror_get',{p_user_id:f.users.consulta,p_entity:'products',p_id:id});
 assert.equal(mirror.fields.gtin_package,'ABC');assert.equal(mirror.fields.crossdocking,'3');assert.equal(mirror.fields.category_source_id,'900');
 assert.equal(mirror.fields.complementary_description,'<p>Rica</p>');
 // min > max in the Origin: both limits are left out, the rest still applies.
 await f.mirror('products','602',product(602,{estoque:{minimo:5,maximo:1},marca:''}));
 assert.equal((await f.importOrigin('products',['602'])).items[0].action,'create');
 assert.equal(await f.scalar('select stock_min v from erp_catalog.product where record_id=$1',[await recordOf(f,'products',602)]),null);
}finally{await f.close();}});

test('H 350: Transportador search lists carriers first and the complement never edits the mirrored contact',async()=>{const f=await espelhoHFixture();try{
 await f.mirror('contacts','701',contact(701,{nome:'B Transportes',tiposContato:[{descricao:'Transportador'}]}));
 await f.mirror('contacts','702',contact(702,{nome:'A Sem Tipo'}));
 await f.mirror('contacts','703',contact(703,{nome:'C Cliente',tiposContato:[{descricao:'Cliente'}]}));
 await f.importOrigin('contacts',['701','702','703']);
 const options=async()=>(await f.rpc('erp_catalog_contact_options',{p_user_id:f.users.vendas,p_query:null,p_role:'carrier',p_city:null,p_limit:25})).items.map(i=>[i.name,i.carrier_match]);
 assert.deepEqual(await options(),[['B Transportes','role'],['A Sem Tipo','untyped']]);
 const client=await recordOf(f,'contacts',703),version=await f.scalar('select version v from erp_catalog.record where id=$1',[client]);
 const command=randomUUID(),mark={p_user_id:f.users.vendas,p_contact_id:client,p_carrier:true,p_command_id:command};
 const marked=await f.rpc('erp_catalog_contact_carrier_complement',mark);
 assert.equal(marked.carrier_match,'complement');assert.equal(marked.changed,true);
 assert.equal((await f.rpc('erp_catalog_contact_carrier_complement',mark)).replayed,true);
 await fails(assert,()=>f.rpc('erp_catalog_contact_carrier_complement',{...mark,p_carrier:false}),'40001');
 assert.deepEqual(await options(),[['B Transportes','role'],['C Cliente','complement'],['A Sem Tipo','untyped']]);
 assert.equal(await f.scalar('select version v from erp_catalog.record where id=$1',[client]),version);
 assert.equal(await f.scalar('select human_edited v from erp_catalog.record where id=$1',[client]),false);
 assert.equal(await f.scalar("select state v from erp_catalog.origin where record_id=$1",[client]),'synced');
 await fails(assert,()=>f.rpc('erp_catalog_contact_carrier_complement',{...mark,p_command_id:randomUUID(),p_user_id:f.users.consulta}),'42501');
 // Other roles keep their filter.
 assert.deepEqual((await f.rpc('erp_catalog_contact_options',{p_user_id:f.users.vendas,p_query:null,p_role:'customer',p_city:null,p_limit:25})).items.map(i=>i.name),['C Cliente']);
}finally{await f.close();}});

test('H 351: Origin categories keep a stable tree through renames, moves, repeats and local deletion',async()=>{const f=await espelhoHFixture();try{
 const cat=(id,name,parent=0,extra={})=>f.mirror('product_categories',String(id),{id,descricao:name,categoriaPai:{id:parent},...extra});
 const local=await f.rpc('erp_catalog_taxonomy_save',{p_user_id:f.users.admin,p_kind:'categories',p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_data:{name:'Ferramentas'}});
 await cat(12,'Elétricas',11);await cat(11,'Ferramentas');await cat(13,'Manuais',11);
 const sync=async()=>f.rpc('erp_catalog_origin_categories_sync',{p_user_id:f.users.admin,p_command_id:randomUUID()});
 const first=await sync();
 assert.deepEqual(first.counts,{adopted:1,created:2});assert.deepEqual(first.issues,[]);
 const tree=async()=>f.scalar("select jsonb_object_agg(s.source_id,jsonb_build_object('name',t.name,'parent',p.source_id)) v from erp_catalog.taxonomy_source s join erp_catalog.taxonomy t on t.id=s.taxonomy_id left join erp_catalog.taxonomy_source p on p.taxonomy_id=t.parent_id");
 assert.deepEqual(await tree(),{11:{name:'Ferramentas',parent:null},12:{name:'Elétricas',parent:'11'},13:{name:'Manuais',parent:'11'}});
 assert.equal(await f.scalar("select taxonomy_id v from erp_catalog.taxonomy_source where source_id='11'"),local.item.id);
 const count=()=>f.scalar("select count(*)::integer v from erp_catalog.taxonomy where kind='categories'");
 assert.equal(await count(),3);
 assert.deepEqual((await sync()).counts,{unchanged:3});
 // Rename, move under another parent and a cycle in the Origin.
 await cat(12,'Elétricas e Bateria',13);await cat(14,'Loop A',15);await cat(15,'Loop B',14);await cat(13,'Manuais',11,{situacao:'I'});
 const second=await sync();
 assert.deepEqual(await tree(),{11:{name:'Ferramentas',parent:null},12:{name:'Elétricas e Bateria',parent:'13'},13:{name:'Manuais',parent:'11'},14:{name:'Loop A',parent:null},15:{name:'Loop B',parent:null}});
 assert.deepEqual(second.issues.map(i=>i.issue).sort(),['cycle','cycle']);
 assert.equal(await count(),5);
 const listed=await f.rpc('erp_catalog_origin_categories',{p_user_id:f.users.consulta});
 assert.equal(listed.items.find(i=>i.source_id==='13').inactive,true);assert.equal(listed.pending,0);
 // A Origin category deleted in the Brufap is not recreated.
 const manual=await f.scalar("select t.id v from erp_catalog.taxonomy t join erp_catalog.taxonomy_source s on s.taxonomy_id=t.id where s.source_id='12'");
 const version=await f.scalar('select version v from erp_catalog.taxonomy where id=$1',[manual]);
 await f.rpc('erp_catalog_taxonomy_delete',{p_user_id:f.users.admin,p_kind:'categories',p_id:manual,p_expected_version:version,p_command_id:randomUUID()});
 assert.equal((await sync()).counts.removed_locally,1);assert.equal(await count(),4);
 await fails(assert,()=>f.rpc('erp_catalog_origin_categories_sync',{p_user_id:f.users.consulta,p_command_id:randomUUID()}),'42501');
}finally{await f.close();}});

test('H 352: a product excluded in the Origin goes to Excluídos only by the reviewed action and comes back by Restaurar',async()=>{const f=await espelhoHFixture();try{
 await f.mirror('products','801',product(801,{marca:'Antes'}));await f.importOrigin('products',['801']);
 const id=await recordOf(f,'products',801);
 const list=async(user=f.users.admin)=>(await f.rpc('erp_catalog_origin_deletions',{p_user_id:user,p_limit:50,p_after:null}));
 assert.deepEqual((await list()).items,[]);
 await f.mirror('products','801',product(801,{marca:'Antes',situacao:'E'}));
 assert.equal((await f.importOrigin('products',['801'])).items[0].action,'pending_source_deleted');
 const pending=await list(f.users.consulta);
 assert.equal(pending.writable,false);assert.deepEqual(pending.items.map(i=>[i.id,i.action,i.source_status]),[[id,'delete','E']]);
 const version=pending.items[0].version,command=randomUUID();
 await fails(assert,()=>f.rpc('erp_catalog_origin_deletion_apply',{p_user_id:f.users.consulta,p_id:id,p_expected_version:version,p_command_id:command,p_action:'delete'}),'42501');
 await fails(assert,()=>f.rpc('erp_catalog_origin_deletion_apply',{p_user_id:f.users.admin,p_id:id,p_expected_version:version,p_command_id:randomUUID(),p_action:'restore'}),'40001');
 const deleted=await f.rpc('erp_catalog_origin_deletion_apply',{p_user_id:f.users.admin,p_id:id,p_expected_version:version,p_command_id:command,p_action:'delete'});
 assert.equal(deleted.deleted,true);
 assert.equal((await f.rpc('erp_catalog_origin_deletion_apply',{p_user_id:f.users.admin,p_id:id,p_expected_version:version,p_command_id:command,p_action:'delete'})).replayed,true);
 assert.equal(await f.scalar("select state||':'||(applied_hash=latest_hash)::text||':'||(candidate is null)::text v from erp_catalog.origin where record_id=$1",[id]),'source_deleted:true:true');
 assert.equal((await f.rpc('erp_catalog_origin_mirror_get',{p_user_id:f.users.admin,p_entity:'products',p_id:id})).fields.situation,'E');
 assert.deepEqual((await list()).items,[]);
 // The same deleted event again, or a newer edit of the excluded product: never restored or recreated by the import.
 assert.equal((await f.importOrigin('products',['801'])).items[0].action,'unchanged');
 await f.mirror('products','801',product(801,{marca:'Editada no Origin',situacao:'E'}));
 assert.notEqual((await f.importOrigin('products',['801'])).items[0].action,'update');
 assert.notEqual(await f.scalar('select deleted_at v from erp_catalog.product_detail where record_id=$1',[id]),null);
 // Restored in the Origin: listed for Restaurar; restored, it follows the Origin again.
 await f.mirror('products','801',product(801,{marca:'Restaurada'}));
 const back=(await list()).items;assert.deepEqual(back.map(i=>[i.action,i.source_status]),[['restore','A']]);
 const restored=await f.rpc('erp_catalog_origin_deletion_apply',{p_user_id:f.users.admin,p_id:id,p_expected_version:back[0].version,p_command_id:randomUUID(),p_action:'restore'});
 assert.equal(restored.deleted,false);
 assert.equal(await f.scalar('select active::text||human_edited::text v from erp_catalog.record where id=$1',[id]),'truefalse');
 assert.equal((await f.importOrigin('products',['801'])).items[0].action,'update');
 assert.equal(await f.scalar('select brand v from erp_catalog.product where record_id=$1',[id]),'Restaurada');
}finally{await f.close();}});

test('H 350 refuses to replace a function that changed since it was written',async()=>{const g=await espelhoHFixture({before:'202610210350'});try{
 await g.db.exec("create or replace function erp_catalog.import_changes(p_entity text,p_before jsonb,p_after jsonb) returns jsonb language sql immutable as $$ select '[]'::jsonb $$");
 await assert.rejects(()=>g.migrate('202610210350_catalog_origin_mirror.sql'),e=>e.code==='55000'&&/previous_definition_changed/.test(e.message));
}finally{await g.close();}});
