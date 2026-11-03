import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import {readFile} from 'node:fs/promises';import {before,after,test} from 'node:test';import {PGlite} from '@electric-sql/pglite';
import {normalizeCompany,normalizeCnpj} from '../../packages/erp-domain/src/company.mjs';import {companyResponse,companyRoute} from '../../workers/erp-api/src/company.mjs';
let db;const users={};const types={identity:['uuid','int','uuid','jsonb'],fiscal:['uuid','int','int','uuid','text','boolean','text']};
const data=()=>({legal_name:'Empresa Sintética de QA',trade_name:null,cnpj:'12.ABC.345/01DE-35',ie:null,postal_code:'13400-000',street:'Rua fictícia',number:'S/N',complement:null,district:'Centro fictício',city:'Piracicaba',municipality_code:'3538709',state:'sp',phone:'+55 (19) 99999-0000',email:'empresa@example.invalid'});
const scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0].value;
async function role(name,action){await db.exec(`set role ${name}`);try{return await action();}finally{await db.exec('reset role');}}
const rpc=(name,types,args)=>role('service_role',()=>scalar(`select public.${name}(${types.map((t,i)=>`$${i+1}::${t}`).join(',')})value`,args));const code=expected=>error=>error.code===expected;
const identity=(body=data(),version=0,command=randomUUID(),actor=users.admin)=>rpc('erp_company_save_identity',types.identity,[actor,version,command,JSON.stringify(body)]);
const get=(section='identity',actor=users.admin)=>rpc('erp_company_get',['uuid','text'],[actor,section]);
const fiscal=({crt='3',confirmed=true,version,identityVersion,reason='Confirmação sintética para QA',command=randomUUID(),actor=users.fiscal}={})=>rpc('erp_company_confirm_fiscal',types.fiscal,[actor,version,identityVersion,command,crt,confirmed,reason]);
before(async()=>{
 db=new PGlite();await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);');
 for(const name of ['0001_origin_sync','0002_origin_quotes_nfce','0004_erp_access','0016_company'])await db.exec(await readFile(new URL(`../../supabase/migrations/20261016${name}.sql`,import.meta.url),'utf8'));
 for(const role of ['admin','fiscal','vendas','estoque','financeiro','consulta','inactive']){users[role]=randomUUID();await db.query('insert into auth.users values($1)',[users[role]]);await db.query('insert into erp_access.membership(user_id,role,active)values($1,$2,$3)',[users[role],role==='inactive'?'admin':role,role!=='inactive']);}
});after(async()=>db?.close());
test('empty company creates no data; identity is readable to active members and fiscal only admin/fiscal',async()=>{
 for(const actor of Object.values(users).filter(x=>x!==users.inactive))assert.equal((await get('identity',actor)).record,null);
 for(const roleName of ['vendas','estoque','financeiro','consulta']){
  await assert.rejects(()=>get('fiscal',users[roleName]),code('42501'));await assert.rejects(()=>identity(data(),0,randomUUID(),users[roleName]),code('42501'));
 }
 await assert.rejects(()=>identity(data(),0,randomUUID(),users.fiscal),code('42501'));await assert.rejects(()=>get('identity',users.inactive),code('42501'));
 const access=await rpc('erp_company_access',['uuid'],[users.fiscal]);assert.equal(access.read_identity,true);assert.equal(access.write_identity,false);assert.equal(access.write_fiscal,true);assert.equal(access.emission_enabled,false);
 const tables=(await db.query("select relname,relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='erp_company'and relkind='r'")).rows;assert.equal(tables.length,4);assert.ok(tables.every(row=>row.relrowsecurity));
 for(const who of ['anon','authenticated','service_role'])for(const table of tables)assert.equal(await scalar("select has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE')value",[who,`erp_company.${table.relname}`]),false);
 for(const who of ['anon','authenticated'])await assert.rejects(()=>role(who,()=>scalar("select public.erp_company_get($1,'identity')value",[users.admin])),code('42501'));
});
test('numeric and alphanumeric CNPJ DVs and address normalization match JS and SQL',async()=>{
 for(const cnpj of ['12.ABC.345/01DE-35','12abc34501de35','11.222.333/0001-81','00000000000191']){
  assert.equal(await scalar('select erp_company.cnpj($1)value',[cnpj]),normalizeCnpj(cnpj));
  const value={...data(),cnpj};assert.deepEqual(await scalar('select erp_company.normalize($1::jsonb)value',[JSON.stringify(value)]),normalizeCompany(value));
 }
 for(const cnpj of ['00000000000000','11111111111111','12ABC34501DE36','12ABC34501DE3A','12_ABC_345_01DE35','123','12ÁBC34501DE35']){assert.throws(()=>normalizeCnpj(cnpj));await assert.rejects(()=>scalar('select erp_company.cnpj($1)value',[cnpj]),code('22023'));}
 for(const patch of [{cnpj:'bad'},{state:'XX'},{municipality_code:'3304557'},{municipality_code:'353870'},{postal_code:'00000000'},{street:''},{legal_name:'\nprivate'},{email:'bad@'},{phone:'call-me'},{crt:'1'},{csc:'secret'},{certificate:'secret'}]){
  assert.throws(()=>normalizeCompany({...data(),...patch}));await assert.rejects(()=>identity({...data(),...patch}),code('22023'));
 }
 assert.equal((await get()).record,null);
});
test('identity saves by CAS with one singleton, immutable replay and no automatic fiscal confirmation',async()=>{
 const command=randomUUID(),first=await identity(data(),0,command);assert.equal(first.record.version,1);assert.equal(first.record.data.cnpj,'12ABC34501DE35');assert.equal(first.emission_enabled,false);
 assert.deepEqual(await identity(data(),0,command),{...first,replayed:true});
 await assert.rejects(()=>identity({...data(),legal_name:'Different'},0,command),code('40001'));await assert.rejects(()=>identity(data(),0),code('40001'));
 const initial=(await get('fiscal')).record;assert.equal(initial.crt,null);assert.equal(initial.confirmed,false);assert.equal(initial.version,1);
 const updated=await identity({...data(),trade_name:'Marca fictícia'},1);assert.equal(updated.record.version,2);
 assert.equal((await identity({...data(),trade_name:'Marca fictícia'},2)).record.version,2);
 const safe=companyResponse(updated,companyRoute('/v1/empresa/identidade'),{type:'identity',rpc:'erp_company_save_identity'});assert.equal(safe.record.data.trade_name,'Marca fictícia');assert.equal(safe.record.updated_by,undefined);
 assert.equal(await scalar('select count(*)::int value from erp_company.identity'),1);
});
test('CRT confirmation is separate, explicit, reasoned, versioned and revalidated on every replay',async()=>{
 for(const options of [{confirmed:false},{crt:'0'},{reason:'no'},{identityVersion:1},{version:0}])await assert.rejects(()=>fiscal({version:1,identityVersion:2,...options}),code(options.identityVersion===1?'40001':'22023'));
 await assert.rejects(()=>fiscal({version:1,identityVersion:2,actor:users.vendas}),code('42501'));
 const command=randomUUID(),confirmed=await fiscal({version:1,identityVersion:2,command});assert.equal(confirmed.record.crt,'3');assert.equal(confirmed.record.confirmed,true);assert.equal(confirmed.record.version,2);assert.equal(confirmed.emission_enabled,false);
 assert.deepEqual(await fiscal({version:1,identityVersion:2,command}),{...confirmed,replayed:true});
 await db.query('update erp_access.membership set active=false where user_id=$1',[users.fiscal]);await assert.rejects(()=>fiscal({version:1,identityVersion:2,command}),code('42501'));await db.query('update erp_access.membership set active=true where user_id=$1',[users.fiscal]);
 const cleared=await fiscal({version:2,identityVersion:2,crt:null,confirmed:false,reason:'Retirar confirmação para revisão'});assert.equal(cleared.record.crt,null);assert.equal(cleared.record.confirmed_at,null);
 const safe=companyResponse(cleared,companyRoute('/v1/empresa/fiscal'),{type:'fiscal',rpc:'erp_company_confirm_fiscal'});assert.equal(safe.record.confirmed,false);
});
test('CNPJ change invalidates the previous CRT, audits both changes and rejects stale fiscal identity versions',async()=>{
 await fiscal({version:3,identityVersion:2,crt:'1'});
 const updated=await identity({...data(),cnpj:'11.222.333/0001-81'},2);assert.equal(updated.record.version,3);
 const next=(await get('fiscal')).record;assert.equal(next.version,5);assert.equal(next.crt,null);assert.equal(next.confirmed,false);assert.equal(next.identity_version,3);
 await assert.rejects(()=>fiscal({version:5,identityVersion:2}),code('40001'));
 assert.equal(await scalar("select count(*)::int value from erp_company.audit where action='fiscal_reset_identity_changed'"),1);
 const commercial=await get('identity',users.vendas);assert.doesNotMatch(JSON.stringify(commercial),/crt|confirmed|reason/);
});
