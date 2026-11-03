import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {seedFiscalNumbering} from '../qa/seed-fiscal-numbering.mjs';

async function setup(cnpj='11222333000181'){
 const db=new PGlite(),uid=randomUUID();await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);');
 for(const name of['0001_origin_sync','0002_origin_quotes_nfce','0004_erp_access','0006_erp_catalog','0008_erp_documents','0009_erp_stock','0010_erp_finance','0016_company','0022_fiscal_drafts','0023_product_details','0035_fiscal_item_preparation','0040_fiscal_tax_preparation','0046_fiscal_numbering'])await db.exec(await readFile(new URL('../../supabase/migrations/20261016'+name+'.sql',import.meta.url),'utf8'));
 await db.query('insert into auth.users values($1)',[uid]);await db.query("insert into erp_access.membership(user_id,role)values($1,'admin')",[uid]);
 await db.query('select public.erp_company_save_identity($1,0,$2,$3::jsonb)',[uid,randomUUID(),JSON.stringify({legal_name:'Empresa sintética para seed046',cnpj,postal_code:'13400000',street:'Rua fictícia',number:'1',district:'Bairro fictício',city:'Piracicaba',municipality_code:'3538709',state:'SP'})]);
 return{db,uid};
}
test('QA046 creates28 configurations with pagination25+3, two models and no numbering or native effects',async()=>{
 const f=await setup();try{assert.deepEqual(await seedFiscalNumbering(f),{series:28,reserved_numbers:0,models:['55','65']});const counts=async()=>(await f.db.query("select jsonb_build_array((select count(*)from erp_fiscal_numbering.series),(select count(*)from erp_fiscal_numbering.reservation),(select count(*)from erp_finance.title),(select count(*)from erp_stock.movement),(select count(*)from erp_fiscal_numbering.command))value")).rows[0].value;
  const before=await counts();assert.deepEqual(before,[28,0,0,0,28]);await assert.rejects(()=>seedFiscalNumbering(f),/QA_NUMBERING_ALREADY_SEEDED/);assert.deepEqual(await counts(),before);
 }finally{await f.db.close();}
});
test('QA046 refuses a non-PGlite port or unrecognized issuer before writing a configuration',async()=>{
 await assert.rejects(()=>seedFiscalNumbering({db:{},uid:randomUUID()}),/QA_NUMBERING_PGLITE_REQUIRED/);
 const f=await setup('11444777000161');try{await assert.rejects(()=>seedFiscalNumbering(f),/QA_NUMBERING_SYNTHETIC_IDENTITY_REQUIRED/);assert.equal((await f.db.query('select count(*)::integer n from erp_fiscal_numbering.series')).rows[0].n,0);}finally{await f.db.close();}
});
