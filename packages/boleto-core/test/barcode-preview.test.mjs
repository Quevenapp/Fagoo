import test from 'node:test';
import assert from 'node:assert/strict';
import {createBoletoDigits,createItau109BarcodePreview} from '../src/index.mjs';

const input=()=>({purpose:'offline-validation',profile:{bank:'341',wallet:'109',layout:'itau-cnab400-2017-01',agency:'1234',account:'12345',accountDigit:'1',cnpj:'12345678000195',accountId:'synthetic-account',companyName:'EMPRESA FICTICIA',contractVerified:true,agreementReference:'SYNTHETIC CONTRACT ONLY',simpleCollectionPolicyVerified:true},allocation:{ourNumber:'00000001',confirmed:true,reference:'SYNTHETIC ALLOCATION ONLY'},title:{amountCents:'12345',dueOn:'2025-02-22',referenceOn:'2025-02-22'}});
// Independent ReportLab I2of5(checksum=0,ratio=3,bearers=0,quiet=0) reference,
// evaluated2026-10-16 for the synthetic44-digit candidate below. No extra digit.
const GOLDEN='11113131131113311311133113311131131111333311111133331111113333111111333311311311113331311311133311311113111331331111113333111111333311111133331113113131131311313113133311113113113111331333111131131133113131111313311111333311311';
test('ITF symbol matches an independent encoder including interleaved spaces and start/stop',()=>{
 const p=createItau109BarcodePreview(input());
 assert.equal(p.barcode,'34199100000000123451090000000101234123451000');
 const bars=[...p.svg.matchAll(/<rect x="(\d+)" y="0" width="([13])" height="13"\/>/g)].map(m=>({x:Number(m[1]),width:Number(m[2])}));
 const widths=[];for(let i=0;i<bars.length;i++){widths.push(bars[i].width);if(i+1<bars.length)widths.push(bars[i+1].x-bars[i].x-bars[i].width);}
 assert.equal(widths.join(''),GOLDEN);assert.equal(bars.length,114);assert.equal(widths.reduce((a,b)=>a+b),405);
 assert.equal(p.symbolModules,405);assert.equal(bars.at(-1).x+bars.at(-1).width,405);
});
test('fixed physical dimensions and quiet zones keep the warning outside the bars',()=>{
 const p=createItau109BarcodePreview(input());
 assert.match(p.svg,/width="113mm" height="24mm" viewBox="0 0 113 24"/);
 assert.match(p.svg,/translate\(5 8\) scale\(0\.254320987654321 1\)/);
 assert.match(p.svg,/PRÉVIA TÉCNICA - NÃO PAGAR/);
 assert.equal(p.barcodeWidthMm,103);assert.equal(p.barcodeHeightMm,13);assert.equal(p.quietZoneMm,5);
 assert.doesNotMatch(p.svg,/<script|<image|<foreignObject|https?:\/\/(?!www\.w3\.org)|href=|style=/);
});
test('the graphic does not change numeric output or confer registration, emission or payment authority',()=>{
 const value=input(),before=structuredClone(value),digits=createBoletoDigits(value),p=createItau109BarcodePreview(value);
 for(const[k,v]of Object.entries(digits))assert.deepEqual(p[k],v);
 for(const k of ['canIssue','canTransmit','bankRegistered','bankAcceptanceVerified','numberAllocationVerified','fullBoletoRendered','printedLayoutValidatedByBank'])assert.equal(p[k],false);
 assert.ok(Object.isFrozen(p));assert.deepEqual(value,before);
});
test('caller text never enters SVG and malformed, unknown or unconfirmed input remains blocked',()=>{
 const v=input();v.profile.agreementReference='<script>alert(1)</script>';
 assert.doesNotMatch(createItau109BarcodePreview(v).svg,/alert\(1\)|SYNTHETIC CONTRACT/);
 for(const change of [x=>x.svg='injected',x=>x.profile.contractVerified=false,x=>x.profile.wallet='110',x=>x.profile.accountDigit='9',x=>x.title.amountCents='1.00']){
  const x=input();change(x);assert.throws(()=>createItau109BarcodePreview(x));
 }
});
