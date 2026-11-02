import test,{before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from '../../../packages/database/migrate.mjs';
import {createBankingService} from '../src/banking/service.mjs';
import {handleBankingRequest} from '../src/banking/router.mjs';
import {PROFILES,title,returnFile} from '../../../packages/cnab/test/fixtures.mjs';
let db,pool,service,actor;
before(async()=>{
  if(process.env.BANKING_TEST_DATABASE_URL){const url=new URL(process.env.BANKING_TEST_DATABASE_URL);assert(['localhost','127.0.0.1'].includes(url.hostname)&&url.pathname.endsWith('_test'));const{Pool}=await import('pg');pool=new Pool({connectionString:url.href});}
  else{db=new PGlite();let pending=Promise.resolve();pool={query:(...a)=>db.query(...a),async connect(){const prior=pending;let unlock;pending=new Promise(r=>{unlock=r;});await prior;return{query:(...a)=>db.query(...a),exec:(...a)=>db.exec(...a),release:unlock};}};}
  await migrate(pool);service=createBankingService({pool});
});
after(async()=>{await db?.close();await pool?.end?.();});
beforeEach(async()=>{await pool.query('TRUNCATE fagoo.company CASCADE');actor={id:'banking-test-admin',companyId:randomUUID(),scopes:['*']};await pool.query('INSERT INTO fagoo.company(id,name,document) VALUES($1,$2,$3)',[actor.companyId,'Empresa fictícia de teste',PROFILES.itau.cnpj]);});
const profileInput=()=>({command_id:randomUUID(),name:'Cobrança de teste',configuration:structuredClone(PROFILES.itau)});
const previewInput=()=>({command_id:randomUUID(),expected_version:1,generated_on:'2026-10-15',remittance_sequence:'1',titles:[title()]});

test('bank profiles require administrative scope, matching company and optimistic version',async()=>{
  const input=profileInput();await assert.rejects(service.save({...actor,scopes:['finance:write']},input),/FORBIDDEN/);
  await assert.rejects(service.save(actor,{...input,configuration:{...input.configuration,cnpj:'12345678000195'}}),/CNAB_COMPANY_DOCUMENT_MISMATCH/);
  const result=await service.save(actor,input);assert.equal(result.profile.status,'pending_homologation');assert.equal((await service.save(actor,input)).replayed,true);
  await assert.rejects(service.save(actor,{...profileInput(),expected_version:2},result.profile.id),/VERSION_CONFLICT/);
  const changed=await service.save(actor,{...profileInput(),expected_version:1,active:false},result.profile.id);assert.equal(changed.profile.version,2);assert.equal(changed.profile.active,false);
  const list=await service.list(actor);assert.equal(list.items.length,1);assert.equal(list.capabilities.automatic_settlement,false);assert.equal(list.capabilities.supplier_payments,false);
  assert.equal((await service.list({...actor,companyId:randomUUID()})).items.length,0);
});

test('homologation remittance replays exactly and does not post or transmit finance',async()=>{
  const row=(await service.save(actor,profileInput())).profile,input=previewInput();const result=await service.remittancePreview(actor,row.id,input);
  assert.equal(result.artifact.productionReady,false);assert.equal(result.artifact.bankTransmissionPerformed,false);assert.equal(result.artifact.financialMutationPerformed,false);assert.equal(Buffer.from(result.artifact.bytes_base64,'base64').length,1206);
  const replay=await service.remittancePreview(actor,row.id,input);assert.equal(replay.replayed,true);assert.equal(replay.artifact.fileHash,result.artifact.fileHash);
  await assert.rejects(service.remittancePreview(actor,row.id,{...input,remittance_sequence:'2'}),/COMMAND_REUSED/);
  assert.equal((await pool.query('SELECT count(*)::integer AS n FROM fagoo.finance_title')).rows[0].n,0);
  assert.equal((await pool.query("SELECT count(*)::integer AS n FROM fagoo.audit WHERE action LIKE 'cnab.remittance.preview:%'")).rows[0].n,1);
});

test('unconfirmed agreement, inactive profiles, stale versions and cross-company previews fail closed',async()=>{
  const input=profileInput();input.configuration.contractVerified=false;const row=(await service.save(actor,input)).profile;
  await assert.rejects(service.remittancePreview(actor,row.id,previewInput()),/CNAB_BANK_AGREEMENT_UNCONFIRMED/);
  const otherCompany=randomUUID();await pool.query('INSERT INTO fagoo.company(id,name) VALUES($1,$2)',[otherCompany,'Outra empresa fictícia']);
  await assert.rejects(service.remittancePreview({...actor,companyId:otherCompany},row.id,previewInput()),/NOT_FOUND/);
  await assert.rejects(service.remittancePreview(actor,row.id,{...previewInput(),expected_version:2}),/VERSION_CONFLICT/);
  await service.save(actor,{...profileInput(),expected_version:1,active:false},row.id);
  await assert.rejects(service.remittancePreview(actor,row.id,{...previewInput(),expected_version:2}),/CNAB_PROFILE_INACTIVE/);
});

test('return preview keeps structural validity separate from bank origin and settlement',async()=>{
  const row=(await service.save(actor,profileInput())).profile;const result=await service.returnPreview(actor,row.id,{expected_version:1,bytes_base64:Buffer.from(returnFile()).toString('base64')});
  assert.equal(result.parsed.validated,true);assert.equal(result.parsed.originAuthenticated,false);assert.equal(result.parsed.financialMutationPerformed,false);assert.equal(result.parsed.events[0].paidCents,'12345');
  await assert.rejects(service.returnPreview(actor,row.id,{expected_version:1,bytes_base64:'%invalid%'}),/CNAB_BASE64_INVALID/);
  assert.equal((await pool.query('SELECT count(*)::integer AS n FROM fagoo.finance_title')).rows[0].n,0);
});

test('banking HTTP routes enforce scopes, JSON encoding and no unsupported operational action',async()=>{
  const row=(await service.save(actor,profileInput())).profile;
  const make=(input,headers={})=>new Request(`https://erp.example/api/v1/banking/cnab/profiles/${row.id}/remittance-preview`,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(input)});
  assert.equal((await handleBankingRequest(make(previewInput()),{pool,actor:{...actor,scopes:['finance:read']}})).status,403);
  assert.equal((await handleBankingRequest(make(previewInput(),{'content-encoding':'gzip'}),{pool,actor})).status,415);
  assert.equal((await handleBankingRequest(make({...previewInput(),purpose:'operational'}),{pool,actor})).status,400);
  assert.equal(await handleBankingRequest(new Request('https://erp.example/api/v1/banking/cnab/transmit'),{pool,actor}),null);
});
