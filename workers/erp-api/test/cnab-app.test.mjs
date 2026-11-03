import test,{before,after}from'node:test';
import assert from'node:assert/strict';
import{readFile}from'node:fs/promises';
import{randomUUID}from'node:crypto';
import{PGlite}from'@electric-sql/pglite';
import{parseCnabRoute,executeCnabRoute,createCnabStorage}from'../src/cnab.mjs';
import{PROFILES,returnFile}from'../../../packages/cnab-core/test/fixtures.mjs';
let db,today,contact,itau,firstTitle,firstBody,firstResult;const users={},objects=new Map();
const scalar=async(sql,values=[])=> (await db.query(sql,values)).rows[0].value;
const state=code=>error=>error.code===code;
async function rpc(name,args){
  const meta=(await db.query('SELECT proargnames,oidvectortypes(proargtypes) types FROM pg_proc WHERE proname=$1',[name])).rows[0];assert.ok(meta,`RPC exists: ${name}`);
  const types=meta.types.split(', '),names=meta.proargnames;const values=names.map((key,index)=>types[index]==='jsonb'||types[index]==='text[]'?JSON.stringify(args[key]):args[key]);
  const params=types.map((type,index)=>type==='text[]'?`ARRAY(SELECT jsonb_array_elements_text($${index+1}::jsonb))`:`$${index+1}::${type}`);
  await db.exec('SET ROLE service_role');try{return await scalar(`SELECT public.${name}(${params.join(',')}) AS value`,values);}finally{await db.exec('RESET ROLE');}
}
const execute=(action,data,user=users.financeiro)=>rpc('erp_finance_execute',{p_user_id:user,p_command_id:randomUUID(),p_action:action,p_data:data});
const profileList=()=>rpc('erp_cnab_profiles',{p_user_id:users.admin});
async function storeFile({bucket,path,bytes,upsert}){assert.equal(bucket,'brufap-cnab');assert.equal(upsert,false);const key=`${bucket}/${path}`;if(objects.has(key))return;objects.set(key,bytes.slice());await db.query('INSERT INTO storage.objects(bucket_id,name,metadata) VALUES($1,$2,$3)',[bucket,path,JSON.stringify({size:bytes.length,mimetype:'application/octet-stream'})]);}
async function getFile({bucket,path}){return new Response(objects.get(`${bucket}/${path}`)||null,{status:objects.has(`${bucket}/${path}`)?200:404});}
const ports=(extra={})=>({userId:users.financeiro,rpc,storeFile,getFile,...extra});
async function http(path,body,extra={}){const request=new Request(`https://local.example.test/v1/cnab${path}`,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});const route=await parseCnabRoute(request);return executeCnabRoute(route,ports(extra));}
async function newProfile(source=PROFILES.itau,changes={}){const account=(await execute('account_save',{expected_version:0,name:'BANCO SINTETICO',kind:'bank'})).record;
  const{accountId,...fields}=source;const data={...fields,account_id:account.id,ourNumberStart:source.bank==='341'?'00000001':source.wallet==='110'?'0000000030':null,remittanceSequenceStart:'1',...changes};
  const result=await http('/profiles',{expected_version:0,command_id:randomUUID(),data},{userId:users.admin});return{...result.body.profile,data};}
async function newTitle(amount='12345'){return(await execute('title_create_group',{kind:'receivable',contact_id:contact.id,description:'TITULO FICTICIO',issued_on:today,total_cents:amount,installments:[{amount_cents:amount,due_on:today}]})).items[0];}
const generation=(profile,title,extra={})=>({profile_id:profile.id,expected_version:profile.version,command_id:randomUUID(),generated_on:today,titles:[{title_id:title.id,expected_version:title.version,document_number:`D${Math.random().toString(16).slice(2,10).toUpperCase()}`,...(profile.bank==='077'?{payment_limit_days:30}:{})}],...extra});
const currentProfile=async id=>(await profileList()).items.find(item=>item.id===id);
const day=value=>value.slice(8,10)+value.slice(5,7)+value.slice(2,4);
before(async()=>{
  db=new PGlite();await db.exec('CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;CREATE SCHEMA auth;CREATE TABLE auth.users(id uuid PRIMARY KEY);CREATE SCHEMA storage;CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);CREATE TABLE storage.objects(bucket_id text,name text,metadata jsonb,PRIMARY KEY(bucket_id,name));ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;GRANT USAGE ON SCHEMA storage TO anon,authenticated;GRANT SELECT,INSERT,UPDATE,DELETE ON storage.objects TO anon,authenticated;CREATE POLICY unrelated_broad_access ON storage.objects FOR ALL TO anon,authenticated USING(true) WITH CHECK(true);');
  for(const file of ['202610160001_origin_sync.sql','202610160002_origin_quotes_nfce.sql','202610160004_erp_access.sql','202610160006_erp_catalog.sql','202610160010_erp_finance.sql','202610160014_erp_cnab.sql'])await db.exec(await readFile(new URL(`../../../supabase/migrations/${file}`,import.meta.url),'utf8'));
  await db.exec("INSERT INTO storage.buckets VALUES('brufap-cnab','brufap-cnab',false,4020000,ARRAY['application/octet-stream'])");
  for(const role of ['admin','financeiro','consulta','vendas']){users[role]=randomUUID();await db.query('INSERT INTO auth.users VALUES($1)',[users[role]]);await db.query('INSERT INTO erp_access.membership(user_id,role) VALUES($1,$2)',[users[role],role]);}
  today=await scalar("SELECT (clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date::text AS value");
  contact=(await rpc('erp_catalog_save',{p_user_id:users.admin,p_entity:'contacts',p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_data:{name:'PAGADOR FICTICIO TESTE',person_type:'F',document:'12345678909',street:'RUA FICTICIA',number:'100',district:'TESTE',city:'PIRACICABA',state:'SP',postal_code:'13400000',roles:['customer']}})).record;
});
after(async()=>db?.close());
test('CNAB tables and RPCs are private, roles explicit and profile approval restricted to admin',async()=>{
  const rows=(await db.query("SELECT relname,relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='erp_cnab' AND c.relkind='r'")).rows;assert.equal(rows.length,8);assert.ok(rows.every(row=>row.relrowsecurity));
  for(const role of ['anon','authenticated','service_role'])for(const row of rows)assert.equal(await scalar("SELECT has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE') value",[role,`erp_cnab.${row.relname}`]),false);
  const functions=(await db.query("SELECT oid::regprocedure::text name FROM pg_proc WHERE proname LIKE 'erp_cnab_%'")).rows;for(const role of ['anon','authenticated'])for(const fn of functions)assert.equal(await scalar("SELECT has_function_privilege($1,$2,'EXECUTE') value",[role,fn.name]),false);
  assert.equal((await http('',null,{userId:users.consulta})).body.write,false);await assert.rejects(()=>http('',null,{userId:users.vendas}),state('42501'));
  await assert.rejects(()=>rpc('erp_cnab_profile_save',{p_user_id:users.financeiro,p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_data:{}}),state('42501'));
});
test('unconfirmed profiles cannot allocate numbers; immutable identity and starting counters cannot be reset',async()=>{
  itau=await newProfile(PROFILES.itau,{contractVerified:false});firstTitle=await newTitle();
  await assert.rejects(()=>http('/remittances',generation(itau,firstTitle)),state('40001'));assert.equal((await currentProfile(itau.id)).next_sequence,'1');
  const changed={...itau.data,contractVerified:true};const approved=await http('/profiles',{id:itau.id,expected_version:1,command_id:randomUUID(),data:changed},{userId:users.admin});itau={...approved.body.profile,data:changed};
  await assert.rejects(()=>http('/profiles',{id:itau.id,expected_version:2,command_id:randomUUID(),data:{...changed,ourNumberStart:'00000002'}},{userId:users.admin}),state('40001'));
});
test('generation reserves once, freezes native snapshots, verifies private bytes and can replay without duplicate numbering',async()=>{
  firstBody=generation(itau,firstTitle);firstResult=await http('/remittances',firstBody);assert.equal(firstResult.body.state,'ready');assert.equal(firstResult.body.productionReady,false);
  assert.equal((await currentProfile(itau.id)).next_sequence,'2');const reservation=await rpc('erp_cnab_reservation',{p_user_id:users.financeiro,p_id:firstResult.body.id});
  assert.equal(reservation.snapshot.titles[0].amountCents,firstTitle.amount_cents);assert.equal(reservation.snapshot.titles[0].ourNumber,'00000001');assert.equal(reservation.snapshot.profile.accountId,itau.account_id);
  const replay=await http('/remittances',firstBody);assert.equal(replay.body.file_hash,firstResult.body.file_hash);assert.equal((await currentProfile(itau.id)).next_sequence,'2');
  const download=await http(`/files/remittance/${firstResult.body.id}`,null,{userId:users.consulta});assert.equal(download.type,'download');assert.equal(download.bytes.length,1206);assert.equal(download.filename,'ITAU_TESTE_0000001.REM');
  assert.equal(await scalar('SELECT count(*)::int value FROM erp_finance.settlement'),0);
});
test('crash after reservation keeps its sequence and number consumed; identical command resumes after upload failure',async()=>{
  const p=await currentProfile(itau.id),title=await newTitle(),body=generation(p,title);let failed=false;
  await assert.rejects(()=>http('/remittances',body,{storeFile:async()=>{failed=true;throw new Error('synthetic upload interruption');}}),/synthetic upload/);assert.equal(failed,true);assert.equal((await currentProfile(itau.id)).next_sequence,'3');
  const reserved=(await db.query("SELECT r.id,b.our_number_base FROM erp_cnab.remittance r JOIN erp_cnab.billing_title b ON b.remittance_id=r.id WHERE b.title_id=$1",[title.id])).rows[0];assert.equal(reserved.our_number_base,'00000002');
  await assert.rejects(async()=>http('/remittances',generation(await currentProfile(itau.id),title)),state('40001'));
  const resumed=await http('/remittances',body);assert.equal(resumed.body.id,reserved.id);assert.equal(resumed.body.state,'ready');assert.equal((await currentProfile(itau.id)).next_sequence,'3');
});
test('hash verification and private-object checks block corrupted or publicly exposed artifacts',async()=>{
  await assert.rejects(()=>http(`/files/remittance/${firstResult.body.id}`,null,{getFile:async()=>new Uint8Array([1,2,3])}),error=>error.code==='ERP_CNAB_STORED_FILE_MISMATCH');
  const reservation=await rpc('erp_cnab_reservation',{p_user_id:users.financeiro,p_id:firstResult.body.id});
  await db.exec("UPDATE storage.buckets SET public=true WHERE id='brufap-cnab'");
  await assert.rejects(()=>http(`/files/remittance/${firstResult.body.id}`),state('40001'));
  await assert.rejects(()=>rpc('erp_cnab_finalize',{p_user_id:users.financeiro,p_command_id:randomUUID(),p_id:reservation.id,p_hash:reservation.file_hash,p_size:reservation.byte_size,p_path:reservation.object_path,p_manifest:[]}),state('40001'));
  await db.exec("UPDATE storage.buckets SET public=false WHERE id='brufap-cnab'");
});
test('a financial change after upload blocks finalization and cannot release the reserved number',async()=>{
  const profile=await currentProfile(itau.id),title=await newTitle(),body=generation(profile,title);
  const before=BigInt(profile.next_sequence);
  await assert.rejects(()=>http('/remittances',body,{storeFile:async input=>{await storeFile(input);await execute('title_update',{id:title.id,expected_version:title.version,description:'ALTERACAO CONCORRENTE SINTETICA'});}}),state('40001'));
  assert.equal((await currentProfile(itau.id)).next_sequence,(before+1n).toString());
  assert.equal(await scalar('SELECT r.state value FROM erp_cnab.remittance r JOIN erp_cnab.billing_title bt ON bt.remittance_id=r.id WHERE bt.title_id=$1',[title.id]),'reserved');
  await assert.rejects(()=>http('/remittances',body),state('40001'));
});
test('a second profile cannot bypass number uniqueness by changing wallet or beneficiary metadata',async()=>{
  await assert.rejects(()=>newProfile({...PROFILES.itau,wallet:'109'}),state('23505'));
});
test('return exact match creates review only, deduplicates file/event redelivery and preserves raw occurrences',async()=>{
  const reservation=await rpc('erp_cnab_reservation',{p_user_id:users.financeiro,p_id:firstResult.body.id}),title=reservation.snapshot.titles[0],profile=reservation.snapshot.profile;
  const bytes=returnFile({profile,generatedDate:day(today),events:[{control:title.control,documentNumber:title.documentNumber,ourNumber:title.ourNumber,amount:title.amountCents,paid:title.amountCents,dueDate:day(today),occurrenceDate:day(today),creditDate:day(today)}]});
  const body={profile_id:itau.id,command_id:randomUUID(),file_base64:Buffer.from(bytes).toString('base64'),obtained_from_bank:true,reference_id:'SYNTHETIC_BANK_DOWNLOAD'};
  const result=await http('/returns',body);assert.equal(result.body.new_events,1);assert.equal(result.body.canSettle,false);assert.equal(result.body.originAuthenticated,false);
  const review=await http(`/returns/${result.body.id}/review`);assert.equal(review.body.items[0].action,'PROPOSE_SETTLEMENT_REVIEW');assert.equal(review.body.items[0].billing_title_id,title.id);
  assert.equal((await http('/returns',body)).body.replayed,true);assert.equal((await http('/returns',{...body,command_id:randomUUID()})).body.duplicate_file,true);
  const other=returnFile({profile,generatedDate:day(today),fileSequence:'00002',events:[{control:title.control,documentNumber:title.documentNumber,ourNumber:title.ourNumber,amount:title.amountCents,paid:title.amountCents,dueDate:day(today),occurrenceDate:day(today),creditDate:day(today)}]});
  const repeated=await http('/returns',{...body,command_id:randomUUID(),file_base64:Buffer.from(other).toString('base64')});assert.equal(repeated.body.new_events,0);assert.equal(repeated.body.duplicate_events,1);
  assert.equal(await scalar('SELECT count(*)::int value FROM erp_cnab.return_event'),1);assert.equal(await scalar('SELECT count(*)::int value FROM erp_cnab.return_occurrence'),2);
  assert.equal(await scalar('SELECT count(*)::int value FROM erp_finance.settlement'),0);assert.equal(await scalar('SELECT count(*)::int value FROM erp_finance.movement'),0);
});
test('Inter112 bank-assigned number is only a proposed binding, and Inter110 range exhaustion never reuses a number',async()=>{
  const p=await newProfile(PROFILES.inter),title=await newTitle();const generated=await http('/remittances',generation(p,title));const reservation=await rpc('erp_cnab_reservation',{p_user_id:users.financeiro,p_id:generated.body.id});const bt=reservation.snapshot.titles[0];assert.equal(bt.ourNumber,undefined);
  const bytes=returnFile({bank:'077',profile:reservation.snapshot.profile,generatedDate:day(today),events:[{occurrence:'02',control:bt.control,documentNumber:bt.documentNumber,ourNumber:'00000000001',amount:bt.amountCents,paid:'0',dueDate:day(today),occurrenceDate:day(today),creditDate:day(today)}]});
  const result=await http('/returns',{profile_id:p.id,command_id:randomUUID(),file_base64:Buffer.from(bytes).toString('base64'),obtained_from_bank:true,reference_id:'SYNTHETIC_INTER'});const review=await http(`/returns/${result.body.id}/review`);assert.equal(review.body.items[0].action,'PROPOSE_BANK_NUMBER_BINDING_REVIEW');assert.equal(await scalar('SELECT our_number value FROM erp_cnab.billing_title WHERE id=$1',[bt.id]),null);
  const range=await newProfile({...PROFILES.inter,wallet:'110',account:'000123457'},{reservedRange:{verified:true,start:'0000000030',end:'0000000030'}});await http('/remittances',generation(range,await newTitle()));await assert.rejects(async()=>http('/remittances',generation(await currentProfile(range.id),await newTitle())),state('40001'));
});
test('revoked membership blocks retries, unsupported production inputs are rejected and private source fields are absent from lists',async()=>{
  const profiles=(await http('/profiles')).body;assert.doesNotMatch(JSON.stringify(profiles),/"cnpj"|"agency"|"accountDigit"|"reservedRange"/);
  await db.query('UPDATE erp_access.membership SET active=false WHERE user_id=$1',[users.financeiro]);await assert.rejects(()=>http('/remittances',firstBody),state('42501'));await db.query('UPDATE erp_access.membership SET active=true WHERE user_id=$1',[users.financeiro]);
  await assert.rejects(()=>http('/remittances',{...firstBody,purpose:'production'}),error=>error.status===400);
  await assert.rejects(()=>http('/returns',{profile_id:itau.id,command_id:randomUUID(),file_base64:'%%%'}),error=>error.status===400);
  await assert.rejects(()=>http(`/files/remittance/${firstResult.body.id}?path=other`),error=>error.status===404);
});
test('restrictive Storage policy blocks broad browser policies, including inserts',async()=>{
  for(const role of ['anon','authenticated']){
    await db.exec(`SET ROLE ${role}`);
    try{assert.equal(await scalar("SELECT count(*)::int value FROM storage.objects WHERE bucket_id='brufap-cnab'"),0);
      await assert.rejects(()=>db.exec("INSERT INTO storage.objects VALUES('brufap-cnab','forbidden','{}')"),state('42501'));
    }finally{await db.exec('RESET ROLE');}
  }
});
test('bucket limits and MIME must match, and revocation during download blocks delivery',async()=>{
  await db.exec("UPDATE storage.buckets SET file_size_limit=9999999 WHERE id='brufap-cnab'");
  await assert.rejects(()=>http(`/files/remittance/${firstResult.body.id}`),state('40001'));
  await db.exec("UPDATE storage.buckets SET file_size_limit=4020000,allowed_mime_types=ARRAY['text/plain'] WHERE id='brufap-cnab'");
  await assert.rejects(()=>http(`/files/remittance/${firstResult.body.id}`),state('40001'));
  await db.exec("UPDATE storage.buckets SET allowed_mime_types=ARRAY['application/octet-stream'] WHERE id='brufap-cnab'");
  await assert.rejects(()=>http(`/files/remittance/${firstResult.body.id}`,null,{getFile:async input=>{
    const result=await getFile(input);await db.query('UPDATE erp_access.membership SET active=false WHERE user_id=$1',[users.financeiro]);return result;
  }}),state('42501'));
  await db.query('UPDATE erp_access.membership SET active=true WHERE user_id=$1',[users.financeiro]);
});
test('changing a financial account kind before finalize rejects the reserved remittance',async()=>{
  const profile=await currentProfile(itau.id),body=generation(profile,await newTitle());
  await assert.rejects(()=>http('/remittances',body,{storeFile:async input=>{await storeFile(input);await db.query("UPDATE erp_finance.account SET kind='cash' WHERE id=$1",[itau.account_id]);}}),state('40001'));
  await assert.rejects(async()=>http('/remittances',generation(await currentProfile(itau.id),await newTitle())),state('40001'));
  await db.query("UPDATE erp_finance.account SET kind='bank' WHERE id=$1",[itau.account_id]);
});
test('real Storage adapter refuses redirects, never overwrites and limits a stalled response body',async()=>{
  const input={bucket:'brufap-cnab',path:`profiles/${itau.id}/returns/${'a'.repeat(64)}.ret`};
  const config={baseUrl:'https://abcdefghijklmnopqrst.supabase.co',key:'synthetic-service-key',timeoutMs:20};
  const redirect=createCnabStorage({...config,fetchImpl:async(_url,options)=>{assert.equal(options.redirect,'manual');return new Response(null,{status:302,headers:{Location:'https://untrusted.test'}});}});
  await assert.rejects(()=>redirect.getFile(input),error=>error.status===502);
  const stalled=createCnabStorage({...config,fetchImpl:async()=>new Response(new ReadableStream({start(){}}))});
  await assert.rejects(()=>stalled.getFile(input),error=>error.status===504);
  const duplicate=createCnabStorage({...config,fetchImpl:async(_url,options)=>{assert.equal(options.headers['x-upsert'],'false');return new Response('{}',{status:409});}});
  await duplicate.storeFile({...input,bytes:new Uint8Array([1]),upsert:false});
});
test('server preview validates bank layout and payer without allocating rows, counters or audit',async()=>{
  const profile=await currentProfile(itau.id),body=generation(profile,await newTitle());
  const counts=()=>scalar("SELECT jsonb_build_array((SELECT count(*) FROM erp_cnab.remittance),(SELECT count(*) FROM erp_cnab.billing_title),(SELECT count(*) FROM erp_cnab.audit)) value");
  const before=await counts(),preview=await http('/remittances/preview',body);assert.equal(preview.body.preview,true);assert.equal(preview.body.total_cents,'12345');assert.equal(preview.body.sequence,profile.next_sequence);assert.equal((await currentProfile(itau.id)).next_sequence,profile.next_sequence);assert.deepEqual(await counts(),before);assert.doesNotMatch(JSON.stringify(preview.body),/cnpj|payer|agency|ourNumber/);
  await db.query("UPDATE erp_catalog.contact SET postal_code='0' WHERE record_id=$1",[contact.id]);
  await assert.rejects(()=>http('/remittances/preview',body),error=>error.status===400);assert.deepEqual(await counts(),before);
  await db.query("UPDATE erp_catalog.contact SET postal_code='13400000' WHERE record_id=$1",[contact.id]);
});
test('paginated file list projects only safe metadata, and a lost browser command can resume by reservation ID',async()=>{
  const profile=await currentProfile(itau.id),body=generation(profile,await newTitle());
  await assert.rejects(()=>http('/remittances',body,{storeFile:async()=>{throw new Error('synthetic crash');}}),/synthetic crash/);
  const reservation=await scalar('SELECT remittance_id value FROM erp_cnab.billing_title WHERE title_id=$1',[body.titles[0].title_id]);
  const first=(await http('/remittances?limit=1')).body;assert.equal(first.items.length,1);assert.equal(first.has_more,true);assert.doesNotMatch(JSON.stringify(first),/snapshot|cnpj|object_path|payer/);
  const second=(await http(`/remittances?limit=1&after=${first.next_cursor}`)).body;assert.notEqual(first.items[0].id,second.items[0].id);
  const counter=(await currentProfile(itau.id)).next_sequence;const resumed=await http(`/remittances/${reservation}/resume`,{});assert.equal(resumed.body.state,'ready');assert.equal((await currentProfile(itau.id)).next_sequence,counter);
  const otherUser=await http(`/remittances/${reservation}/resume`,{},{userId:users.admin});assert.equal(otherUser.body.file_hash,resumed.body.file_hash);assert.equal((await currentProfile(itau.id)).next_sequence,counter);
  await assert.rejects(()=>http(`/remittances/${reservation}/resume`,{},{userId:users.consulta}),state('42501'));
});
test('administrative approval is CAS/idempotent, and revocation before finalize blocks generation',async()=>{
  let profile=await currentProfile(itau.id);const data={contract_verified:false,policy_verified:false,reference:'SYNTHETIC_REVIEW'};
  const body={expected_version:profile.version,command_id:randomUUID(),data};
  await assert.rejects(()=>http(`/profiles/${profile.id}/approval`,body),state('42501'));
  const approved=await http(`/profiles/${profile.id}/approval`,body,{userId:users.admin});assert.equal(approved.body.profile.contract_verified,false);
  assert.equal((await http(`/profiles/${profile.id}/approval`,body,{userId:users.admin})).body.replayed,true);
  await assert.rejects(()=>http(`/profiles/${profile.id}/approval`,{...body,command_id:randomUUID()},{userId:users.admin}),state('40001'));
  const allow=async()=>{profile=await currentProfile(itau.id);await http(`/profiles/${profile.id}/approval`,{expected_version:profile.version,command_id:randomUUID(),data:{...data,contract_verified:true,policy_verified:true}},{userId:users.admin});};await allow();
  profile=await currentProfile(itau.id);await assert.rejects(async()=>http('/remittances',generation(profile,await newTitle()),{storeFile:async input=>{await storeFile(input);const current=await currentProfile(itau.id);await http(`/profiles/${current.id}/approval`,{expected_version:current.version,command_id:randomUUID(),data},{userId:users.admin});}}),state('40001'));
  await allow();
});
