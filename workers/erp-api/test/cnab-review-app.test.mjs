import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {parseCnabRoute,executeCnabRoute} from '../src/cnab.mjs';
import {parseCnabReviewRoute,executeCnabReviewRoute,cnabReviewMethods} from '../src/cnab-review.mjs';
import {PROFILES,returnFile} from '../../../packages/cnab-core/test/fixtures.mjs';
let db,today,contact,profile,fileId,eventId,secondFile,sourceBytes,sourceBody,savedCommand,firstReview;
const users={},objects=new Map();
const scalar=async(sql,values=[])=> (await db.query(sql,values)).rows[0].value;
const sqlError=code=>error=>error.code===code;
async function rpc(name,args){
 assert.match(name,/^erp_[a-z_]+$/);
 const meta=(await db.query('SELECT proargnames,oidvectortypes(proargtypes) types FROM pg_proc WHERE proname=$1',[name])).rows[0];assert.ok(meta,name);
 const types=meta.types.split(', '),values=meta.proargnames.map((key,i)=>types[i]==='jsonb'||types[i]==='text[]'?JSON.stringify(args[key]):args[key]);
 const params=types.map((type,i)=>type==='text[]'?`ARRAY(SELECT jsonb_array_elements_text($${i+1}::jsonb))`:`$${i+1}::${type}`);
 await db.exec('SET ROLE service_role');try{return await scalar(`SELECT public.${name}(${params.join(',')}) value`,values);}finally{await db.exec('RESET ROLE');}
}
async function storeFile({bucket,path,bytes,upsert}){assert.equal(bucket,'brufap-cnab');assert.equal(upsert,false);const key=`${bucket}/${path}`;if(objects.has(key))return;objects.set(key,bytes.slice());await db.query('INSERT INTO storage.objects VALUES($1,$2,$3)',[bucket,path,JSON.stringify({size:bytes.length,mimetype:'application/octet-stream'})]);}
const getFile=async({bucket,path})=>new Response(objects.get(`${bucket}/${path}`)||null,{status:objects.has(`${bucket}/${path}`)?200:404});
const ports=extra=>({userId:users.financeiro,rpc,getFile,storeFile,...extra});
const request=(path,data)=>new Request(`https://test.invalid${path}`,data?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}:{});
const cnab=async(path,data,extra)=>executeCnabRoute(await parseCnabRoute(request(`/v1/cnab${path}`,data)),ports(extra));
const review=async(path,data,extra)=>executeCnabReviewRoute(await parseCnabReviewRoute(request(`/v1/conferencia-retornos${path}`,data)),ports(extra));
const native=(action,data)=>rpc('erp_finance_execute',{p_user_id:users.financeiro,p_command_id:randomUUID(),p_action:action,p_data:data});
const detail=(id=eventId,file=fileId)=>review(`/events/${id}?file_id=${file}&line=2`);
const preview=(id=eventId,file=fileId)=>review(`/events/${id}/preview`,{file_id:file,line:2});
const saveBody=d=>({file_id:d.context.occurrence.file_id,line:d.context.occurrence.line,command_id:randomUUID(),expected_review_version:d.review_version,expected_context_hash:d.context_hash,status:'confirmed',reason:'Conferência sintética em homologação.'});
const save=(data,id=eventId,extra)=>review(`/events/${id}/review`,data,extra);
const day=value=>value.slice(8,10)+value.slice(5,7)+value.slice(2,4);
const financeDigest=()=>scalar("SELECT md5(jsonb_build_object('titles',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM erp_finance.title t),'settlements',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM erp_finance.settlement t),'movements',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM erp_finance.movement t),'billing',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM erp_cnab.billing_title t),'events',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM erp_cnab.return_event t))::text) value");
before(async()=>{
 db=new PGlite();await db.exec('CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;CREATE SCHEMA auth;CREATE TABLE auth.users(id uuid PRIMARY KEY);CREATE SCHEMA storage;CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);CREATE TABLE storage.objects(bucket_id text,name text,metadata jsonb,PRIMARY KEY(bucket_id,name));ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;');
 for(const file of ['202610160001_origin_sync.sql','202610160002_origin_quotes_nfce.sql','202610160004_erp_access.sql','202610160006_erp_catalog.sql','202610160010_erp_finance.sql','202610160014_erp_cnab.sql','202610160024_cnab_human_review.sql'])await db.exec(await readFile(new URL(`../../../supabase/migrations/${file}`,import.meta.url),'utf8'));
 await db.exec("INSERT INTO storage.buckets VALUES('brufap-cnab','brufap-cnab',false,4020000,ARRAY['application/octet-stream'])");
 for(const role of ['admin','financeiro','consulta','vendas']){users[role]=randomUUID();await db.query('INSERT INTO auth.users VALUES($1)',[users[role]]);await db.query('INSERT INTO erp_access.membership(user_id,role) VALUES($1,$2)',[users[role],role]);}
 today=await scalar("SELECT (clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date::text value");
 contact=(await rpc('erp_catalog_save',{p_user_id:users.admin,p_entity:'contacts',p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_data:{name:'PAGADOR SINTETICO',person_type:'F',document:'12345678909',street:'RUA SINTETICA',number:'1',district:'TESTE',city:'PIRACICABA',state:'SP',postal_code:'13400000',roles:['customer']}})).record;
 const account=(await native('account_save',{expected_version:0,name:'CONTA FICTICIA',kind:'bank'})).record;
 const {accountId,...fields}=PROFILES.itau;
 profile=(await cnab('/profiles',{expected_version:0,command_id:randomUUID(),data:{...fields,account_id:account.id,ourNumberStart:'00000001',remittanceSequenceStart:'1'}},{userId:users.admin})).body.profile;
 const title=(await native('title_create_group',{kind:'receivable',contact_id:contact.id,description:'TITULO FICTICIO',issued_on:today,total_cents:'12345',installments:[{amount_cents:'12345',due_on:today}]})).items[0];
 const remittance=(await cnab('/remittances',{profile_id:profile.id,expected_version:profile.version,command_id:randomUUID(),generated_on:today,titles:[{title_id:title.id,expected_version:title.version,document_number:'SYNTH001'}]})).body;
 const reservation=await rpc('erp_cnab_reservation',{p_user_id:users.financeiro,p_id:remittance.id}),bt=reservation.snapshot.titles[0];
 sourceBody={profile:reservation.snapshot.profile,generatedDate:day(today),events:[{control:bt.control,documentNumber:bt.documentNumber,ourNumber:bt.ourNumber,amount:bt.amountCents,paid:bt.amountCents,dueDate:day(today),occurrenceDate:day(today),creditDate:day(today)}]};
 sourceBytes=returnFile(sourceBody);
 fileId=(await cnab('/returns',{profile_id:profile.id,command_id:randomUUID(),file_base64:Buffer.from(sourceBytes).toString('base64'),obtained_from_bank:true,reference_id:'SYNTHETIC_DECLARATION'})).body.id;
 eventId=(await review(`/files/${fileId}`)).items[0].event_id;
});
after(async()=>db?.close());
test('024 uses private RLS tables, service-only RPCs and existing financial role boundaries',async()=>{
 for(const table of ['human_review','human_review_revision']){
  assert.equal(await scalar('SELECT relrowsecurity value FROM pg_class WHERE oid=$1::regclass',[`erp_cnab.${table}`]),true);
  for(const role of ['anon','authenticated','service_role'])assert.equal(await scalar("SELECT has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE') value",[role,`erp_cnab.${table}`]),false);
 }
 const functions=(await db.query("SELECT oid::regprocedure::text name FROM pg_proc WHERE proname LIKE 'erp_cnab_human_review_%'")).rows;assert.equal(functions.length,5);
 for(const fn of functions)for(const role of ['anon','authenticated'])assert.equal(await scalar("SELECT has_function_privilege($1,$2,'EXECUTE') value",[role,fn.name]),false);
 await assert.rejects(()=>detail(eventId,fileId).then(()=>review(`/files/${fileId}`,null,{userId:users.vendas})),sqlError('42501'));
 assert.equal((await review(`/files/${fileId}`,null,{userId:users.consulta})).items.length,1);
 await assert.rejects(()=>review(`/events/${eventId}/preview`,{file_id:fileId,line:2},{userId:users.consulta}),sqlError('42501'));
 await db.exec('SET ROLE anon');try{await assert.rejects(()=>db.query('SELECT public.erp_cnab_human_review_get($1,$2,$3,2)',[users.admin,eventId,fileId]),sqlError('42501'));}finally{await db.exec('RESET ROLE');}
});
test('preview re-reads immutable private bytes, keeps exact cents and projects no identity secrets',async()=>{
 const d=await detail();assert.equal(d.review,null);assert.equal(d.review_version,0);assert.equal(d.bytes_verified,false);
 const p=await preview();assert.equal(p.bytes_verified,true);assert.equal(p.context_hash,d.context_hash);assert.equal(p.context.comparison.reason,'EXACT_MATCH_HOMOLOGATION_ONLY');
 assert.equal(p.context.event.amount_cents,'12345');assert.equal(p.context.title.balance_cents,'12345');
 assert.equal(p.canSettle,false);assert.equal(p.financialMutationPerformed,false);assert.equal(p.originAuthenticated,false);
 assert.doesNotMatch(JSON.stringify(p),/"cnpj"|"accountDigit"|"accountScope"|"actor"|"reviewedBy"|"payload"|"path"/);
 await assert.rejects(()=>preview(randomUUID(),fileId),sqlError('P0002'));
 const before=await financeDigest();assert.equal(await financeDigest(),before);
});
test('explicit human review is atomic, idempotent, immutable and cannot change source or finance',async()=>{
 const p=await preview(),before=await financeDigest();savedCommand=saveBody(p);firstReview=await save(savedCommand);
 assert.equal(firstReview.record.version,1);assert.equal(firstReview.record.status,'confirmed');assert.equal(firstReview.replayed,false);
 const replay=await save(savedCommand);assert.equal(replay.replayed,true);assert.deepEqual(replay.record,firstReview.record);
 assert.equal((await detail()).review.context_changed,false);assert.equal((await review(`/files/${fileId}`)).items[0].review_status,'confirmed');
 assert.equal(await financeDigest(),before);assert.equal(await scalar('SELECT count(*)::int value FROM erp_cnab.human_review_revision'),1);
 await assert.rejects(()=>save({...savedCommand,command_id:randomUUID()}),sqlError('40001'));
 await assert.rejects(()=>save({...savedCommand,reason:'Outra intenção com o mesmo comando.'}),sqlError('40001'));
 await assert.rejects(()=>db.query('UPDATE erp_cnab.human_review_revision SET reason=$1 WHERE event_id=$2',['ALTERADO',eventId]),sqlError('42501'));
 await assert.rejects(()=>db.query('DELETE FROM erp_cnab.human_review_revision WHERE event_id=$1',[eventId]),sqlError('42501'));
});
test('redelivery shares the canonical review and explicitly changes selected-file provenance',async()=>{
 const bytes=returnFile({...sourceBody,fileSequence:'00002'});
 secondFile=(await cnab('/returns',{profile_id:profile.id,command_id:randomUUID(),file_base64:Buffer.from(bytes).toString('base64')})).body.id;
 assert.notEqual(secondFile,fileId);const list=await review(`/files/${secondFile}`);assert.equal(list.items[0].event_id,eventId);assert.equal(list.items[0].duplicate,true);
 assert.equal(list.items[0].review_version,1);assert.equal(list.items[0].context_changed,true);
 const d=await detail(eventId,secondFile);assert.equal(d.context.occurrence.declared_bank_origin,false);assert.equal(d.review.context.occurrence.declared_bank_origin,true);
 assert.notEqual(d.context_hash,firstReview.record.context_hash);
 const p=await preview(eventId,secondFile),result=await save({...saveBody(p),status:'pending_issue',reason:'Reentrega sintética sem declaração de procedência.'});
 assert.equal(result.record.version,2);assert.equal(result.record.context.occurrence.file_id,secondFile);
 const replay=await save(savedCommand);assert.equal(replay.record.version,1);assert.equal(replay.replayed,true);
 assert.equal((await detail(eventId,secondFile)).review.version,2);assert.equal(await scalar('SELECT count(*)::int value FROM erp_cnab.human_review'),1);
 const history=await review(`/events/${eventId}/history?limit=1`);assert.equal(history.items[0].version,2);assert.equal(history.has_more,true);assert.equal(history.next_cursor,2);
 const older=await review(`/events/${eventId}/history?limit=1&before=2`);assert.equal(older.items[0].version,1);assert.equal(older.has_more,false);assert.equal(older.next_cursor,null);
});
test('changed title/profile/account context invalidates preview without creating a revision',async()=>{
 let p=await preview();const before=await scalar('SELECT count(*)::int value FROM erp_cnab.human_review_revision');
 await native('title_update',{id:p.context.title.id,expected_version:p.context.title.version,description:'DESCRICAO SINTETICA REVISADA'});
 await assert.rejects(()=>save(saveBody(p)),sqlError('40001'));assert.equal((await detail()).review.context_changed,true);
 p=await preview();await db.query('UPDATE erp_cnab.profile SET version=version+1 WHERE id=$1',[profile.id]);
 await assert.rejects(()=>save(saveBody(p)),sqlError('40001'));
 p=await preview();await native('account_save',{id:p.context.profile.account_id,expected_version:p.context.profile.account_version,name:'CONTA FICTICIA REVISADA',kind:'bank'});
 await assert.rejects(()=>save(saveBody(p)),sqlError('40001'));
 assert.equal(await scalar('SELECT count(*)::int value FROM erp_cnab.human_review_revision'),before);
 const fresh=await preview(),result=await save({...saveBody(fresh),status:'pending_issue',reason:'Contexto atual revisto sem baixa financeira.'});assert.equal(result.record.version,3);
});
test('audit failure rolls back head, revision and command together',async()=>{
 const p=await preview(),command=saveBody(p),n=await scalar('SELECT count(*)::int value FROM erp_cnab.human_review_revision');
 await db.exec("CREATE FUNCTION erp_cnab.synthetic_fail_review() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='human_review' THEN RAISE EXCEPTION 'synthetic failure'; END IF; RETURN NEW; END $$;CREATE TRIGGER synthetic_fail_review BEFORE INSERT ON erp_cnab.audit FOR EACH ROW EXECUTE FUNCTION erp_cnab.synthetic_fail_review();");
 await assert.rejects(()=>save(command),/synthetic failure/);
 await db.exec('DROP TRIGGER synthetic_fail_review ON erp_cnab.audit;DROP FUNCTION erp_cnab.synthetic_fail_review()');
 assert.equal(await scalar('SELECT count(*)::int value FROM erp_cnab.human_review_revision'),n);assert.equal((await detail()).review_version,p.review_version);
 assert.equal(await scalar('SELECT count(*)::int value FROM erp_cnab.command WHERE id=$1',[command.command_id]),0);
 assert.equal((await save(command)).record.version,p.review_version+1);
});
test('corrupted bytes, wrong payload, public bucket and revoked membership fail before recording',async()=>{
 const p=await preview(),command=saveBody(p),n=await scalar('SELECT count(*)::int value FROM erp_cnab.human_review_revision');
 const broken=sourceBytes.slice();broken[50]=broken[50]===32?65:32;
 await assert.rejects(()=>save(command,eventId,{getFile:async()=>broken}),error=>error.code==='ERP_CNAB_REVIEW_FILE_MISMATCH');
 await assert.rejects(()=>save(command,eventId,{rpc:async(name,args)=>{const v=await rpc(name,args);return name.endsWith('_verify')?{...v,payload:{...v.payload,paidCents:'1'}}:v;}}),error=>error.code==='ERP_CNAB_REVIEW_FILE_MISMATCH');
 await db.exec("UPDATE storage.buckets SET public=true WHERE id='brufap-cnab'");await assert.rejects(()=>save(command),sqlError('40001'));await db.exec("UPDATE storage.buckets SET public=false WHERE id='brufap-cnab'");
 await db.query('UPDATE erp_access.membership SET active=false WHERE user_id=$1',[users.financeiro]);await assert.rejects(()=>save(savedCommand),sqlError('42501'));await db.query('UPDATE erp_access.membership SET active=true WHERE user_id=$1',[users.financeiro]);
 assert.equal(await scalar('SELECT count(*)::int value FROM erp_cnab.human_review_revision'),n);
});
test('unknown reference may be reviewed but never gains a title or number binding',async()=>{
 const bytes=returnFile({...sourceBody,fileSequence:'00003',events:[{...sourceBody.events[0],control:'UNKNOWN',documentNumber:'UNKNOWN'}]});
 const file=(await cnab('/returns',{profile_id:profile.id,command_id:randomUUID(),file_base64:Buffer.from(bytes).toString('base64')})).body.id;
 const event=(await review(`/files/${file}`)).items[0].event_id,p=await preview(event,file);assert.equal(p.context.title,null);assert.equal(p.context.billing,null);assert.equal(p.context.comparison.reason,'UNLINKED_EVENT');
 const before=await financeDigest(),saved=await save({...saveBody(p),status:'pending_issue',reason:'Referência sintética não localizada.'},event);
 assert.equal(saved.record.status,'pending_issue');assert.equal(await financeDigest(),before);
});
test('strict route/body boundaries and scoped DTOs reject spoofing and malformed upstream values',async()=>{
 assert.equal(await parseCnabReviewRoute(request('/v1/other')),null);assert.deepEqual(cnabReviewMethods(`/v1/conferencia-retornos/events/${eventId}/review`),['POST']);
 for(const path of [`/files/${fileId}?limit=101`,`/files/${fileId}?limit=1&limit=2`,`/events/${eventId}?file_id=${fileId}&line=1`,`/events/${eventId}/history?before=0`,`/events/${eventId}?file_id=${fileId}&line=2&actor=x`])await assert.rejects(()=>review(path),error=>error.status===400);
 const p=await preview(),good=saveBody(p);
 for(const patch of [{status:'settled'},{actor:users.admin},{canSettle:true},{reason:'\nNo'},{expected_review_version:'1'},{line:1},{title_id:randomUUID()},{expected_context_hash:'a'}])await assert.rejects(()=>save({...good,...patch}),error=>error.status===400);
 await assert.rejects(()=>parseCnabReviewRoute(new Request(`https://test.invalid/v1/conferencia-retornos/events/${eventId}/review`,{method:'DELETE'})),error=>error.status===405);
 const upper=await review(`/events/${eventId.toUpperCase()}?file_id=${fileId.toUpperCase()}&line=2`);assert.equal(upper.event_id,eventId);
 for(const mutate of [v=>({...v,event_id:randomUUID()}),v=>({...v,canSettle:true}),v=>({...v,context:{...v.context,event:{...v.context.event,paid_cents:12345}}}),v=>({...v,context:{...v.context,occurrence:{...v.context.occurrence,line:3}}}),v=>({...v,context:{...v.context,comparison:{...v.context.comparison,amount_matches:!v.context.comparison.amount_matches}}})])
  await assert.rejects(()=>review(`/events/${eventId}?file_id=${fileId}&line=2`,null,{rpc:async(name,args)=>mutate(await rpc(name,args))}),error=>error.status===502);
});
test('a separate financial settlement and reversal invalidate context; replay never changes the ledger',async()=>{
 const p=await preview(),payment=await native('settle',{id:p.context.title.id,expected_version:p.context.title.version,account_id:p.context.profile.account_id,
  posted_on:today,principal_cents:'12345',interest_cents:'0',penalty_cents:'0',discount_cents:'0',fee_cents:'0',note:'BAIXA SINTETICA MANUAL SEPARADA'});
 await assert.rejects(()=>save(saveBody(p)),sqlError('40001'));
 const paid=await preview();assert.equal(paid.context.title.balance_cents,'0');assert.equal(paid.context.comparison.reason,'TITLE_NOT_FULLY_OPEN');
 const before=await financeDigest();await save({...saveBody(paid),status:'pending_issue',reason:'Título baixado por ação manual separada.'});assert.equal(await financeDigest(),before);
 await native('reverse',{id:paid.context.title.id,expected_version:paid.context.title.version,settlement_id:payment.settlement.id,posted_on:today,note:'ESTORNO SINTETICO MANUAL SEPARADO'});
 const reversed=await preview();assert.equal(reversed.context.title.balance_cents,'12345');assert.equal(reversed.review.context_changed,true);
 const digest=await financeDigest(),old=await save(savedCommand);assert.equal(old.record.version,1);assert.equal(old.replayed,true);assert.equal(await financeDigest(),digest);
 assert.equal(await scalar('SELECT count(*)::int value FROM erp_finance.settlement'),2);assert.equal(await scalar('SELECT count(*)::int value FROM erp_finance.movement'),2);
});
test('Inter112 registration stays an unbound number after human confirmation',async()=>{
 const account=(await native('account_save',{expected_version:0,name:'INTER FICTICIO',kind:'bank'})).record,{accountId,...fields}=PROFILES.inter;
 const p=(await cnab('/profiles',{expected_version:0,command_id:randomUUID(),data:{...fields,account_id:account.id,ourNumberStart:null,remittanceSequenceStart:'1'}},{userId:users.admin})).body.profile;
 const title=(await native('title_create_group',{kind:'receivable',contact_id:contact.id,description:'INTER FICTICIO',issued_on:today,total_cents:'301',installments:[{amount_cents:'301',due_on:today}]})).items[0];
 const rem=(await cnab('/remittances',{profile_id:p.id,expected_version:p.version,command_id:randomUUID(),generated_on:today,titles:[{title_id:title.id,expected_version:title.version,document_number:'INTER001',payment_limit_days:30}]})).body;
 const reserved=await rpc('erp_cnab_reservation',{p_user_id:users.financeiro,p_id:rem.id}),bt=reserved.snapshot.titles[0];
 const bytes=returnFile({bank:'077',profile:reserved.snapshot.profile,generatedDate:day(today),events:[{control:bt.control,documentNumber:bt.documentNumber,ourNumber:'00000000001',occurrence:'02',amount:'301',paid:'0',dueDate:day(today),occurrenceDate:day(today),creditDate:day(today)}]});
 const fid=(await cnab('/returns',{profile_id:p.id,command_id:randomUUID(),file_base64:Buffer.from(bytes).toString('base64'),obtained_from_bank:true,reference_id:'INTER_SYNTHETIC'})).body.id;
 const eid=(await review(`/files/${fid}`)).items[0].event_id,pre=await preview(eid,fid);assert.equal(pre.context.comparison.reason,'BANK_NUMBER_UNBOUND');assert.equal(pre.context.billing.our_number,null);
 const before=await financeDigest(),result=await save({...saveBody(pre),reason:'Registro recebido; número permanece sem vínculo.'},eid);
 assert.equal(result.record.status,'confirmed');assert.equal(result.canSettle,false);assert.equal(await scalar('SELECT our_number value FROM erp_cnab.billing_title WHERE id=$1',[bt.id]),null);
 assert.equal(await financeDigest(),before);
});
test('Unicode whitespace in a valid reason survives SQL normalization and replay without a false failure',async()=>{
 const p=await preview(),n=await scalar('SELECT count(*)::int value FROM erp_cnab.human_review_revision');
 const command={...saveBody(p),reason:'  \u00a0Conferência sintética NBSP\u00a0  '};
 const saved=await save(command),replay=await save(command);
 assert.equal(saved.record.reason,'\u00a0Conferência sintética NBSP\u00a0');
 assert.equal(saved.replayed,false);assert.equal(replay.replayed,true);assert.deepEqual(replay.record,saved.record);
 assert.equal(await scalar('SELECT count(*)::int value FROM erp_cnab.human_review_revision'),n+1);
});
