import test from 'node:test';import assert from 'node:assert/strict';
import {CNAB_ENCODINGS as E,CNAB_V2_FLAGS as F,captureV2,v2Profiles,v2Page,v2Preview,v2Ack,v2Command,v2ApprovalBody} from '../src/lib/cnab-operational-v2-model.ts';
import {clone,entry,body,preview,page,file,remittanceResult,zeroTitle,title} from './helpers/cnab-operational-v2-fixtures.mjs';
import {todaySP} from '../src/lib/real-finance-model.ts';
test('067 model preserves explicit encoding, title-zero pending and exact independent calculation',()=>{
 assert.equal(v2Profiles({...F,items:[entry]})[0].approval.allowed_encoding_profiles.length,2);
 const b={...body,titles:[...body.titles,{title_id:zeroTitle.id,expected_version:1,document_number:'ZERO'}]},p=preview(b);
 assert.equal(v2Preview(p,b).can_reserve,false);assert.equal(p.items[0].encoding_terms.dailyInterestCents,'1');assert.equal(p.pending[0].title_id,zeroTitle.id);
 const reviewed={...b,zero_daily_title_ids:[zeroTitle.id]};assert.equal(v2Preview(preview(reviewed),reviewed).can_reserve,true);
 const no={...body,encoding_profile:E[0]};assert.equal(v2Preview(preview(no),no).items[0].encoding_terms,undefined);
 for(const change of [v=>v.items[0].encoding_terms.dailyInterestCents='2',v=>v.items[0].encoding_terms.interestDateField='2099-12-31',v=>v.items[0].encoding_terms.penaltyPercentHundredths='201',v=>v.can_reserve=true,v=>v.pending=[],v=>v.financialMutationPerformed=true,v=>v.extra='private',v=>v.encoding_profile=E[0],v=>v.total_cents='2671']){const value=clone(p);change(value);assert.throws(()=>v2Preview(value,b));}
 assert.throws(()=>v2Preview(p,{...b,zero_daily_title_ids:[title.id]}));assert.throws(()=>v2Preview(preview(no),{...no,zero_daily_title_ids:[zeroTitle.id]}));
});
test('067 approval requires chosen formats and independent acknowledgments; no simple collection consent fabricated',()=>{
 for(const args of [['',[],false,false],['yes',[],false,false],['yes',[E[1]],true,false]])assert.throws(()=>v2ApprovalBody(entry,args[0],args[1],todaySP(),'REVIEW',args[2],args[3],true,todaySP()));
 assert.throws(()=>v2ApprovalBody({...entry,profile:{...entry.profile,policy_verified:false}},'yes',[E[0]],todaySP(),'REVIEW',false,false,true,todaySP()));
 const b=v2ApprovalBody({...entry,profile:{...entry.profile,policy_verified:false}},'yes',[E[1]],todaySP(),'REVIEW',true,true,true,todaySP());assert.equal(b.compatibility_confirmed,true);assert.equal(b.simpleCollectionPolicyVerified,undefined);
 assert.throws(()=>v2ApprovalBody(entry,'yes',[E[1]],todaySP(),'😀😀',true,true,true,todaySP()));
 const off=v2ApprovalBody(entry,'no',[E[1]],todaySP(),'REVIEW',true,true,true,todaySP());assert.deepEqual(off.allowed_encoding_profiles,[]);assert.equal(off.compatibility_confirmed,false);
});
test('067 receipt is historical while current file may already be ready; hashes/intent cannot diverge',()=>{
 const intent={kind:'generate',profileId:entry.profile.id,body},r=remittanceResult(),a=v2Ack(r.ack,intent),read=v2Command(r.command,intent,a);assert.equal(read.receipt.state,'reserved');assert.equal(read.current.state,'ready');
 for(const change of [v=>v.current.file_hash='f'.repeat(64),v=>v.current.encoding_profile=E[0],v=>v.command_id=file.id,v=>v.receipt.approval_version++,v=>v.current.created_at='2026-02-30T12:00:00Z']){const raw=clone(r.command);change(raw);assert.throws(()=>v2Command(raw,intent,a));}
 assert.throws(()=>v2Ack({...r.ack,command_id:file.id},intent));
});
test('067 exact capture rejects getters without invoking them, and old captures stay null',()=>{
 let calls=0;const raw={get state(){calls++;return'ready';}};assert.throws(()=>captureV2(raw));assert.throws(()=>v2Command({...F,read_only:true,command_id:body.command_id,kind:'remittance',receipt:raw,current:{}},{kind:'generate',profileId:entry.profile.id,body}));assert.equal(calls,0);
 const p=v2Page(page([{...file,encoding_profile:null}]));assert.equal(p.items[0].encoding_profile,null);
 for(const raw of [page([{...file,encoding_profile:undefined}]),page([{...file,byte_size:24925}]),page([{...file,filename:'OTHER.REM'}]),{...page(),has_more:true,next_cursor:file.id}])assert.throws(()=>v2Page(raw));
});
