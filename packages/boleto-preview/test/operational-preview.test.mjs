import test from 'node:test';
import assert from 'node:assert/strict';
import {createItau109PrintPreview,createItau109OperationalPrintPreviewV2 as render} from '../src/index.mjs';
import {createItau109OperationalBarcodePreviewV2 as barcode,createBoletoDigits} from '../../boleto-core/src/index.mjs';
import {operationalFixture,billingTitleId} from './operational-fixture.mjs';
import {fixture} from './fixtures.mjs';

test('observed capture prints exact fields while retaining nominal digits and false capabilities',async()=>{
 const input=operationalFixture(),before=structuredClone(input),v=await render(input),legacy=await render(operationalFixture({observed:false}));
 assert.equal(v.renderProfile,'itau109-print-preview-v2');assert.equal(v.encoding.profile,'itau109-origin-observed-v1');
 assert.equal(v.encoding.terms.dailyInterestCents,'4');assert.match(v.html,/Juro\/dia: R\$ 0,04/);assert.match(v.html,/campo de mora: 30\/10\/2026/);assert.match(v.html,/Multa: 2,00% · campo de data: 31\/10\/2026/);
 assert.doesNotMatch(v.html,/Encargos não calculados/);assert.deepEqual(v.binding,legacy.binding);
 for(const k of ['bankRegistered','bankAcceptanceVerified','homologationVerified','canPay','canIssue','canTransmit','financialMutationPerformed','bankTransmissionPerformed'])assert.equal(v[k],false);
 assert.equal(v.binding.amountCents,'12345');assert.match(v.html,/NÃO PAGAR/);assert.deepEqual(input,before);assert.equal(input.snapshot.profile.simpleCollectionPolicyVerified,false);
});

test('legacy offline entrypoint still refuses absent simple policy',async()=>{
 const old=fixture();old.boleto.profile.simpleCollectionPolicyVerified=false;
 assert.throws(()=>createBoletoDigits(old.boleto),/BOLETO_POLICY_UNCONFIRMED/);
 await assert.rejects(createItau109PrintPreview(old),/BOLETO_POLICY_UNCONFIRMED/);
 const v=await render(operationalFixture({observed:false}));assert.equal(v.encoding.terms,null);assert.match(v.html,/Encargos não calculados/);
});

test('zero requires explicit captured decision and prints unknown bank effect',async()=>{
 await assert.rejects(render(operationalFixture({amount:'1499'})),/BOLETO_PREVIEW_OPERATIONAL_CAPTURE_INVALID/);
 const v=await render(operationalFixture({amount:'1499',zeroConfirmed:true}));
 assert.equal(v.encoding.terms.dailyInterestCents,'0');assert.match(v.html,/Juro diário zerado por arredondamento; efeito bancário não confirmado/);assert.equal(v.binding.amountCents,'1499');
});

test('wrong title, account digit, consent and altered terms cannot render',async()=>{
 for(const mutate of [
  v=>v.billingTitleId='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  v=>v.snapshot.profile.accountDigit='9',
  v=>v.snapshot.encoding_authorization.compatibility_confirmed=false,
  v=>v.snapshot.encoding_authorization.permanent_instructions_acknowledged=false,
  v=>v.snapshot.encoding_profile='unknown',
  v=>v.snapshot.titles[0].encodingTerms={...v.snapshot.titles[0].encodingTerms,dailyInterestCents:'5'},
  v=>v.snapshot.titles[0].encodingTerms={...v.snapshot.titles[0].encodingTerms,penaltyDateField:'2026-11-01'},
 ]){const v=operationalFixture();mutate(v);await assert.rejects(render(v));}
});

test('barcode amount boundary and captured caller mutation are checked independently',async()=>{
 await assert.rejects(render(operationalFixture({amount:'10000000000'})));
 const v=operationalFixture(),expected=await render(v),pending=render(v);
 v.snapshot.titles[0].amountCents='1';v.snapshot.profile.account='99999';v.beneficiaryAddress.address='CHANGED';
 assert.deepEqual(await pending,expected);assert.equal(barcode({snapshot:operationalFixture().snapshot,billingTitleId}).barcode,expected.binding.barcode);
});

test('accessors do not execute and the render result owns frozen encoding metadata',async()=>{
 const v=operationalFixture();let calls=0;Object.defineProperty(v.snapshot.titles[0],'encodingTerms',{enumerable:true,get(){calls++;throw Error('PRIVATE');}});
 await assert.rejects(render(v));assert.equal(calls,0);
 const result=await render(operationalFixture());assert.ok(Object.isFrozen(result.encoding));assert.ok(Object.isFrozen(result.encoding.terms));
 assert.equal(result.sizeBytes,new TextEncoder().encode(result.html).length);
});
