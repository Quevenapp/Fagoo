import test from'node:test';import assert from'node:assert/strict';import{randomUUID}from'node:crypto';
import{mistoGFixture,fails}from'./helpers/misto-g-fixture.mjs';
import{companyOperation,companyResponse}from'../src/company.mjs';
import{normalizeCompany}from'../../../packages/erp-domain/src/company.mjs';

// Synthetic data only (CPF 529.982.247-25 and CNPJ 11.222.333/0001-81 are the usual check-digit examples). 302 (PRF-294): with Tipo da
// Pessoa = Pessoa Física the identity of the company keeps and checks a CPF in its document field, read by the native XML as the emitter.
const CPF='52998224725',CNPJ='11222333000181',OTHER_CPF='11144477735';
const identity=doc=>({legal_name:'Produtor Rural Sintético',trade_name:null,cnpj:doc,ie:'123456789',postal_code:'13400-000',street:'Estrada Sintética',number:'S/N',complement:null,
 district:'Zona Rural',city:'Piracicaba',municipality_code:'3538709',state:'SP',phone:null,email:null});
const extra=person=>({billing_email:null,cnae:null,company_size:null,contacts:null,employees:null,ie_exempt:false,mobile:null,municipal_registration:null,person_type:person,revenue:null,
 segments:['comercio'],site:null,substitute_ies:[],suframa:null});

test('302 PRF-294 the identity takes a CPF with Pessoa Física and a CNPJ with Pessoa Jurídica; an unchanged document is kept as it is',async()=>{const f=await mistoGFixture();try{
 const version=async()=>(await f.db.query('select version from erp_company.identity where singleton')).rows[0]?.version??0;
 const save=async(data,reason=null,command=randomUUID())=>f.rpc('erp_company_save_identity',{p_user_id:f.users.admin,p_expected_version:await version(),p_command_id:command,p_data:data,p_reason:reason});
 const setPerson=async person=>{const current=(await f.db.query('select version from erp_company.extra where singleton')).rows[0]?.version??0;
  return f.rpc('erp_company_extra_save',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_expected_version:current,p_data:extra(person)});};
 // Without Dados complementares the company is Pessoa Jurídica: a CPF is refused, the CNPJ is saved.
 await fails(assert,()=>save(identity(CPF)),'22023');
 const recorded=randomUUID(),first=await save(identity(CNPJ),null,recorded);assert.equal(first.record.data.cnpj,CNPJ);
 await f.db.query("update erp_company.fiscal set crt='1',confirmed_at=now(),confirmed_by=$1,reason='Conferência sintética',version=version+1 where singleton",[f.users.admin]);
 // Pessoa Física: the stored CNPJ stays editable (only the address changes); a new CNPJ is refused; the CPF needs the reason.
 await setPerson('fisica');
 const address=await save({...identity(CNPJ),street:'Estrada Nova'});assert.deepEqual([address.record.data.cnpj,address.record.data.street],[CNPJ,'Estrada Nova']);
 await fails(assert,()=>save({...identity('11444777000161'),street:'Estrada Nova'},'Correção sintética'),'22023');
 await fails(assert,()=>save({...identity('529.982.247-25'),street:'Estrada Nova'}),'22023');
 const corrected=await save({...identity('529.982.247-25'),street:'Estrada Nova'},'Produtor rural: CPF do cadastro');
 assert.equal(corrected.record.data.cnpj,CPF);
 // Changing the document retires the confirmation of the regime, as a new CNPJ did.
 assert.equal(await f.scalar("select crt v from erp_company.fiscal where singleton"),null);
 assert.equal(await f.scalar("select (after_data->>'motivo') v from erp_company.audit where action='save_identity' order by id desc limit 1"),'Produtor rural: CPF do cadastro');
 await fails(assert,()=>save({...identity('123.456.789-00'),street:'Estrada Nova'},'CPF inválido'),'22023');
 // The worker reads and accepts the CPF identity (before 302 it answered 502).
 const route={section:'identity'},read=await f.rpc('erp_company_get',{p_user_id:f.users.financeiro,p_section:'identity'});
 assert.equal(companyResponse(read,route,{type:'identity',rpc:'erp_company_get'}).record.data.cnpj,CPF);
 const request=new Request('https://api.synthetic.invalid/v1/empresa/identidade',{method:'POST',headers:{'content-type':'application/json'},
  body:JSON.stringify({command_id:randomUUID(),expected_version:3,data:{...identity('529.982.247-25'),street:'Estrada Nova'}})});
 assert.equal((await companyOperation(request,route,new URLSearchParams())).rpc,'erp_company_save_identity');
 // Back to Pessoa Jurídica: the CPF stays until it is corrected, and only a CNPJ is accepted then.
 await setPerson('juridica');
 await save({...identity(CPF),street:'Estrada Velha'});
 await fails(assert,()=>save({...identity(OTHER_CPF),street:'Estrada Velha'},'Outro CPF'),'22023');
 const back=await save({...identity(CNPJ),street:'Estrada Velha'},'Volta ao CNPJ');assert.equal(back.record.data.cnpj,CNPJ);
 // A command recorded before the change of Tipo da Pessoa answers its receipt (Conferir resultado).
 await setPerson('fisica');
 const replay=await f.rpc('erp_company_save_identity',{p_user_id:f.users.admin,p_expected_version:0,p_command_id:recorded,p_data:identity(CNPJ),p_reason:null});
 assert.deepEqual([replay.replayed,replay.record.data.cnpj],[true,CNPJ]);
 // The native XML source reads the document and the Tipo da Pessoa of the company (frente de notas, 273).
 assert.deepEqual(await f.scalar("select jsonb_build_object('document',data->>'cnpj','person',erp_company.person_type()) v from erp_company.identity where singleton"),{document:CNPJ,person:'fisica'});
 // Private helpers: no grant to the API roles; the RPC keeps only the service role.
 for(const sig of['erp_company.cpf(text)','erp_company.document(text,text)','erp_company.person_type()','erp_company.normalize_identity(jsonb,text)'])
  for(const role of['anon','authenticated','service_role'])assert.equal(await f.scalar(`select has_function_privilege('${role}','${sig}','execute') v`),false,`${role} ${sig}`);
 for(const role of['anon','authenticated'])assert.equal(await f.scalar(`select has_function_privilege('${role}','public.erp_company_save_identity(uuid,integer,uuid,jsonb,text)','execute') v`),false,role);
 // The SQL and the shared rules agree on the document of each kind.
 for(const[doc,kind,ok]of[[CPF,'cpf',true],['529.982.247-25','cpf',true],[CNPJ,'cpf',false],[CNPJ,'cnpj',true],[CPF,'cnpj',false],[CPF,'any',true],['11.222.333/0001-81','any',true],['00000000000','cpf',false],['12ABC34501DE35','any',true]]){
  let sql=true;try{await f.scalar('select erp_company.document($1,$2) v',[doc,kind]);}catch{sql=false;}
  let js=true;try{normalizeCompany(identity(doc),{document:kind});}catch{js=false;}
  assert.deepEqual([sql,js],[ok,ok],`${doc} ${kind}`);
 }
}finally{await f.close();}});

test('302 replaces only the published identity save: another version stops the migration',async()=>{const f=await mistoGFixture({before:'202610200302'});try{
 await f.db.exec(`create or replace function public.erp_company_save_identity(p_user_id uuid,p_expected_version integer,p_command_id uuid,p_data jsonb,p_reason text default null) returns jsonb language sql as $$ select '{}'::jsonb $$;`);
 await assert.rejects(()=>f.migrate('202610200302_company_identity_cpf.sql'),e=>e.code==='55000'&&/company_identity_cpf_302_previous_definition_changed/.test(e.message));
}finally{await f.close();}});
