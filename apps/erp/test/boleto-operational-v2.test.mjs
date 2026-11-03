import test from 'node:test';import assert from 'node:assert/strict';
import {boletoOperationalV2Fixture} from '../../../workers/erp-api/test/helpers/boleto-preview-fixture.mjs';
import {boletoItems,boletoPreview} from '../src/lib/boleto-preview-model.ts';
test('067 UI validates stored observed/no-charge/zero print profiles and rejects forged financial terms',async()=>{
 for(const opts of [{},{observed:false},{amount:'1',zeroConfirmed:true}]){
  const f=await boletoOperationalV2Fixture(opts),items=boletoItems(f.items,f.file,'operational'),r=await boletoPreview(f.response,items,items.items[0]);
  assert.ok(Object.isFrozen(r.encoding));assert.equal(r.canPay,false);assert.equal(r.encoding.profile,f.context.snapshot.encoding_profile);
  const changes=[x=>x.encoding.profile='bad',x=>x.encoding.policyHash='bad',x=>x.encoding.approvalVersion=2,x=>x.source_purpose='homologation',x=>delete x.encoding];
  if(opts.observed!==false)changes.push(x=>x.encoding.compatibilityConfirmed=false,x=>x.encoding.permanentInstructionsAcknowledged=false,x=>x.encoding.terms.dailyInterestCents='999',x=>x.encoding.terms.interestDateField='2026-01-01',x=>x.encoding.terms.penaltyDateField=x.encoding.terms.interestDateField,x=>x.encoding.terms.penaltyPercentHundredths='300',x=>x.encoding.terms.zeroDailyInterestConfirmed=!x.encoding.terms.zeroDailyInterestConfirmed);
  else changes.push(x=>x.encoding.compatibilityConfirmed=true,x=>x.encoding.terms={});
  for(const change of changes){const x=structuredClone(f.response);change(x);await assert.rejects(()=>boletoPreview(x,items,items.items[0]));}
  let invoked=false;const bad=structuredClone(f.response);Object.defineProperty(bad.encoding,'profile',{enumerable:true,get(){invoked=true;return r.encoding.profile;}});await assert.rejects(()=>boletoPreview(bad,items,items.items[0]));assert.equal(invoked,false);
 }
});
