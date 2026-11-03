import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {processedFixtures} from '../../fiscal-danfe-runtime/test/processed-fixtures.mjs';
import {createProcessedSource,processedSource,disposeProcessedSource} from '../../fiscal-danfe-runtime/src/processed-source.mjs';
import {publicProcessedResult,FLAGS} from '../../fiscal-danfe-runtime/src/processed-dto.mjs';
import {extractProcessedDocument,assertProcessedDocument} from '../src/processed-extract.mjs';
import {renderProcessedHtml} from '../src/processed-render.mjs';
import {extractCandidatePreview} from '../src/extract.mjs';
import {renderCandidateHtml} from '../src/render.mjs';
import {candidateFixture,boundedLongHeader,maximalHeader} from './fixtures.mjs';
const digest=v=>createHash('sha256').update(v).digest('hex');
let fixtures;test.before(async()=>{fixtures=await processedFixtures();});test.after(()=>fixtures?.close());
const source=x=>createProcessedSource(x.ports)(x.input);

test('069/079 ×55/65 ×100/150 render only attested homologation protocol and pass the public DTO',async()=>{
 for(const kind of ['authorization','revalidation'])for(const model of ['55','65'])for(const status of ['100','150']){
  const x=fixtures.create(model,kind,{status}),h=await source(x);
  try{
   const projection=extractProcessedDocument(h),out=renderProcessedHtml(h),p=projection.source.protocol;
   assert.deepEqual(Object.keys(out),['html','sha256','page_count','profile']);assert.equal(out.sha256,digest(out.html));
   assert.equal(out.profile,model==='55'?'processed-danfe55-moc7-v1':'processed-danfe65-manual6-v1');
   assert.match(out.html,/HOMOLOGAÇÃO - SEM VALOR FISCAL/);assert.match(out.html,/Protocolo de autorização - homologação/i);
   assert.ok(out.html.includes(p.number));assert.match(out.html,/16\/10\/2026, 09:01:00/);assert.match(out.html,new RegExp(`cStat ${status}`));
   assert.doesNotMatch(out.html,/NÃO AUTORIZADA|Não há protocolo|produção autorizada/i);
   assert.doesNotMatch(out.html,/<script\b|<iframe\b|X509Certificate|SignatureValue|https?:\/\/[^<]*\.(?:xml|json)/);
   const dto=await publicProcessedResult({...FLAGS,action:'print',source:projection.source,html:out.html,html_sha256:out.sha256,html_size_bytes:Buffer.byteLength(out.html),profile:out.profile,page_count:out.page_count},{sourceKind:kind,commandId:x.input.commandId,action:'print'});
   assert.equal(dto.production_authorized,false);assert.equal(dto.can_transmit,false);assert.equal(dto.tax_rules_validated,false);
   assert.equal(x.calls.read.length,5);assert.equal(x.calls.command.length,2); // Rendering does not fetch, mutate or authorize.
  }finally{disposeProcessedSource(h);}
 }
});

test('fake handles, clones, getters and legacy candidate previews cannot assert processed authorization',async()=>{
 let accessed=0;const fake={get profile(){accessed++;throw Error('PRIVATE');}};
 for(const value of [fake,null,{},Object.freeze({profile:'processed-document-source-v1'})])assert.throws(()=>renderProcessedHtml(value));
 assert.equal(accessed,0);
 const candidate=await candidateFixture(),preview=extractCandidatePreview(candidate.bytes,candidate.context);assert.throws(()=>renderProcessedHtml(preview));
 const x=fixtures.create(),h=await source(x),projection=extractProcessedDocument(h);
 try{assert.throws(()=>renderProcessedHtml(structuredClone(h)));assert.throws(()=>assertProcessedDocument(structuredClone(projection)),/PRINT_UNTRUSTED_PROJECTION/);assert.throws(()=>renderCandidateHtml(projection),/PRINT_UNTRUSTED_PROJECTION/);assert.ok(Object.isFrozen(projection.source.protocol));}
 finally{disposeProcessedSource(h);}
 assert.throws(()=>renderProcessedHtml(h));
});

test('extracting and rendering keep source bytes unchanged and ignore caller-owned copies',async()=>{
 const x=fixtures.create('65','revalidation'),before=[...x.files].map(([key,bytes])=>[key,digest(bytes)]),h=await source(x);
 try{
  const copy=processedSource(h),expected=renderProcessedHtml(h);copy.signedBytes.fill(0);copy.processedBytes.fill(0);
  assert.deepEqual(renderProcessedHtml(h),expected);assert.deepEqual([...x.files].map(([key,bytes])=>[key,digest(bytes)]),before);
  const again=processedSource(h);assert.equal(digest(again.signedBytes),again.metadata.signed_hash);assert.equal(digest(again.processedBytes),again.metadata.processed_hash);again.signedBytes.fill(0);again.processedBytes.fill(0);
 }finally{disposeProcessedSource(h);}
});

test('real signed fixture preserves exact decimals, escapes commercial text and has no active content',async()=>{
 const candidate=await candidateFixture({quantity:'1.234500',unit_price:'12.1234567891'}),x=fixtures.create('55','revalidation',{signedCandidate:candidate}),h=await source(x);
 try{
  const {html}=renderProcessedHtml(h);assert.match(html,/12,1234567891/);assert.match(html,/14,97/);assert.match(html,/A &amp; B &lt;script&gt;não executar&lt;\/script&gt;/);
  assert.doesNotMatch(html,/<(?:script|link|img|iframe|object|embed)\b|\son\w+=|\shref=|\bsrc=|url\(/i);
  assert.match(html,/default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'/);
 }finally{disposeProcessedSource(h);}
});

test('processed protocol participates in page geometry for 250 items and long headers without truncation',async()=>{
 for(const options of [{count:250},{transformUnsigned:boundedLongHeader}]){
  const candidate=await candidateFixture(options),x=fixtures.create('55','authorization',{signedCandidate:candidate}),h=await source(x);
  try{
   const out=renderProcessedHtml(h),count=options.count??1;assert.equal((out.html.match(/class="detail"/g)??[]).length,count);
   assert.equal((out.html.match(/class="page"/g)??[]).length,out.page_count);
   assert.equal((out.html.match(/cStat 100/g)??[]).length,out.page_count);assert.ok(out.html.includes(`Folha ${out.page_count}/${out.page_count}`));
   assert.doesNotMatch(out.html,/text-overflow|ellipsis|overflow:hidden/);assert.ok(out.page_count>=1&&out.page_count<=100);
  }finally{disposeProcessedSource(h);}
 }
 const candidate=await candidateFixture({transformUnsigned:maximalHeader}),h=await source(fixtures.create('55','authorization',{signedCandidate:candidate}));
 try{assert.throws(()=>renderProcessedHtml(h),/PRINT_HEADER_TOO_LARGE/);}finally{disposeProcessedSource(h);}
});

test('wrong processed bytes or terminal evidence fail before a printable handle exists',async()=>{
 for(const edit of [x=>x.record.artifact.evidence.protocol_cstat='301',x=>x.record.artifact.processed_hash='0'.repeat(64),x=>x.files.set([...x.files.keys()].find(k=>k.includes('/processed/')),Buffer.from('<nfeProc/>'))]){
  const x=fixtures.create();edit(x);await assert.rejects(source(x));
 }
});
