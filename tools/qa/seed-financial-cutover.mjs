/** Embedded QA fixture only: source evidence and one contact, never native financial titles. */
import {PGlite} from '@electric-sql/pglite';
import {createHash,randomUUID} from 'node:crypto';

const marker='qa_financial_cutover_038';
const contactSource='9389000001',unmatchedContactSource='9389000099';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sha=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Requires migration038 and an existing local admin. Repeat attempts fail atomically. */
export async function seedFinancialCutover(db,{uid}={}){
 if(!(db instanceof PGlite))throw new TypeError('Synthetic financial cutover seed requires embedded PGlite');
 if(typeof uid!=='string'||!uuid.test(uid))throw new TypeError('Synthetic financial cutover seed requires a local admin UUID');
 await db.exec('begin');
 try{
  if(!(await db.query("select to_regprocedure('public.erp_cutover_financial_get(uuid,text,text)') is not null ready")).rows[0].ready)throw new Error('Synthetic financial cutover seed requires migration038');
  if(!(await db.query("select exists(select 1 from erp_access.membership where user_id=$1 and active and role='admin') ready",[uid])).rows[0].ready)throw new Error('Synthetic financial cutover seed requires an active local admin');
  if((await db.query('select exists(select 1 from origin_sync.resource_state where resource=$1) present',[marker])).rows[0].present)throw new Error('Synthetic financial cutover fixture already exists');
  await db.query('insert into origin_sync.resource_state(resource)values($1)',[marker]);
  const stage=async(entity,source,payload)=>{
   const hash=sha(payload);
   await db.query('insert into origin_sync.raw_record(entity,last_resource,source_id,payload,version_hash)values($1,$2,$3,$4::jsonb,$5)',[entity,marker,source,JSON.stringify(payload),hash]);
   return{source_id:source,source_hash:hash};
  };
  const source=await stage('contacts',contactSource,{id:contactSource,nome:'Contato fictício exclusivo QA038',codigo:'QA038-CONTATO',tipo:'J',situacao:'A',endereco:{geral:{municipio:'Piracicaba',uf:'SP'}}});
  // This is an in-memory native contact only. No title, installment, cash or stock RPC is invoked.
  const imported=(await db.query("select public.erp_catalog_import_origin($1,'contacts',$2::jsonb,$3,false) result",[uid,JSON.stringify([source]),randomUUID()])).rows[0].result;
  const nativeContact=imported.items?.[0]?.record_id;
  if(typeof nativeContact!=='string'||!uuid.test(nativeContact))throw new Error('Synthetic financial cutover contact was not created');
  const common=(id,index)=>({id,situacao:1,valor:100,saldo:100,dataEmissao:'2026-10-01',vencimento:'2026-11-20',vencimentoOriginal:'2026-11-20',competencia:'2026-10-01',
   numeroDocumento:`QA038/${String(index).padStart(3,'0')}`,historico:`Título de origem inteiramente fictício QA038 ${index}`,contato:{id:contactSource},synthetic_qa:true});
  const receivables=[];
  for(let index=1;index<=29;index++){
   const id=String(9380000000+index),payload=common(id,index);
   if(index===1)Object.assign(payload,{numeroDocumento:'QA/001',numeroBanco:'00000123',portador:{id:'0007'},formaPagamento:{id:'0008'},borderos:['0009'],ocorrencia:{tipo:2,numeroParcelas:3}});
   if(index===2)Object.assign(payload,{situacao:3,valor:123.45,saldo:23.45});
   if(index===3)payload.saldo=null;
   if(index===4)delete payload.saldo;
   if(index===5)payload.contato={id:unmatchedContactSource};
   if(index===29)payload.situacao='QA_UNKNOWN';
   await stage('receivables',id,payload);receivables.push(id);
  }
  const payables=[];
  for(let index=1;index<=2;index++){
   const id=String(9381000000+index),payload={...common(id,index),numeroDocumento:`QA038-AP/${index}`,valor:89.50,saldo:index===2?9.50:89.50,situacao:index===2?3:1};
   await stage('payables',id,payload);payables.push(id);
  }
  await db.exec('commit');
  return{synthetic:true,receivables:29,open_partial_receivables:28,payables:2,native_contacts:1,native_financial_writes:0,source_contact:contactSource,native_contact:nativeContact,receivable_ids:receivables,payable_ids:payables};
 }catch(error){await db.exec('rollback');throw error;}
}
