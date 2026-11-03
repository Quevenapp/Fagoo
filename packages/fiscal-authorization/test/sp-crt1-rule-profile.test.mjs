import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {prepareAuthorization,authorizationRequestBytes} from '../src/index.mjs';
import {inspectSpCrt1Candidate,createSpCrt1ReviewReader,evaluateSpCrt1Rules,assertSpCrt1RuleReport,SpCrt1RuleError,MAX_RULE_REVIEW_BYTES,RULE_PROFILE_FLAGS,SP_CRT1_RULE_MANIFEST,SP_CRT1_RULE_MANIFEST_HASH} from '../src/sp-crt1-rule-profile.mjs';
import {credentials,HOLDER,NOW} from '../../fiscal-xml/test/fixtures.mjs';
import {createSigner,disposeSigner,createSignedHomologationCandidate} from '../../fiscal-xml/src/index.mjs';
import {businessFixture} from '../../fiscal-core/test/business-fixtures.mjs';
import {buildBusinessXml} from '../../fiscal-xml/src/business-builder.mjs';
const hash=v=>createHash('sha256').update(v).digest('hex'),bytes=v=>new TextEncoder().encode(v);
const canonical=v=>JSON.stringify(v===null||typeof v!=='object'?v:Array.isArray(v)?v.map(x=>JSON.parse(canonical(x))):Object.fromEntries(Object.keys(v).sort().map(k=>[k,JSON.parse(canonical(v[k]))])));
const candidateId='a0000000-0000-4000-8000-000000000001',otherId='a0000000-0000-4000-8000-000000000002';
let credential,signer;
before(async()=>{credential=await credentials();signer=createSigner({...credential,expectedHolderCnpj:HOLDER,purpose:'offline-homologation',now:NOW});});
after(()=>disposeSigner(signer));
function fixture({model='55',csosn='102',count=1,edit=x=>x}={}){
 const xml=edit(buildBusinessXml(businessFixture({model,csosn,count})).unsignedXml);
 const signed=createSignedHomologationCandidate({xml,signer,expectedIssuerCnpj:HOLDER,expectedModel:model,expectedUnsignedHash:hash(xml),expectedCertificateFingerprint:hash(credential.certificateDer),now:NOW});
 const request=prepareAuthorization({signedBytes:bytes(signed.signedXml),expectedSignedHash:signed.xmlDigest,expectedModel:model,expectedIssuerCnpj:HOLDER,expectedCertificate:credential.certificate,expectedHolderCnpj:HOLDER,expectedCertificateFingerprint:hash(credential.certificateDer),now:NOW,batchId:'1'});
 return{request,signed,xml,candidate:inspectSpCrt1Candidate({candidateId,request})};
}
function review(query,patch=x=>x){
 const r={id:otherId,version:1,candidate_id:query.candidateId,signed_hash:query.signedHash,facts_hash:query.factsHash,profile:query.profile,profile_hash:query.profileHash,reviewed_by:'b0000000-0000-4000-8000-000000000001',reviewed_at:'2026-10-16T11:00:00Z',valid_until:'2026-10-25T23:59:59Z',document:{operation:'internal_normal_sale',recipient_regime:'noncontributor',acquisition_purpose:'final_consumption',payment:'matches_signed_document',excluded_groups:'not_applicable'},items:query.items.map(x=>({position:x.position,item_hash:x.itemHash,classification:'reviewed_physical_goods',benefit:'not_applicable',pis_cofins:'normal_unified_simples',gtin:'reviewed_absent',st:'not_applicable',fcp:'not_applicable',credit:null}))};
 patch(r);return{...r,review_hash:hash(canonical(r))};
}
const capture=(candidate,patch)=>createSpCrt1ReviewReader({readReview:async q=>bytes(JSON.stringify(review(q,patch)))})({candidate,now:NOW});
const evaluate=(candidate,reviewEvidence=null,now=NOW)=>evaluateSpCrt1Rules({candidate,reviewEvidence,now});
const codes=(result,key)=>result[key].map(v=>v.code);
const error=code=>e=>e instanceof SpCrt1RuleError&&e.code===code&&e.message===code;
const has=(r,key,code)=>assert.ok(codes(r,key).includes(code),key+' missing '+code+': '+JSON.stringify(r));
function disabled(r){for(const k of Object.keys(RULE_PROFILE_FLAGS))assert.equal(r[k],false,k);}

test('55/65 exact signed bytes bind independent local reviewed subset with every operational flag false',async()=>{
 for(const model of ['55','65']){const f=fixture({model}),before=hash(authorizationRequestBytes(f.request)),ev=await capture(f.candidate),r=evaluate(f.candidate,ev);
  assert.equal(r.status,'reviewed_subset');assert.equal(r.signedHash,f.signed.xmlDigest);assert.equal(hash(authorizationRequestBytes(f.request)),before);disabled(r);assert.equal(assertSpCrt1RuleReport(r,f.candidate),r);
  assert.ok(Object.isFrozen(r)&&Object.isFrozen(r.temporalPolicy));assert.equal(r.review.version,1);assert.equal(r.coverage,'listed_rules_only_not_full_tax_validation');
  for(const forbidden of ['signedXml','accessKey','issuerCnpj','certificate','execution','lease','endpoint'])assert.equal(forbidden in r,false);
  assert.ok(!JSON.stringify(r).includes(HOLDER));assert.equal(f.request.canTransmit,false);
 }
});
test('attestations reject browser booleans, clones/proxies/getters and report binding to other bytes',async()=>{
 const f=fixture(),other=fixture({edit:x=>x.replace('DOCUMENTO SINTETICO SEM VALOR FISCAL','OUTRO DOCUMENTO FICTICIO')}),ev=await capture(f.candidate),r=evaluate(f.candidate,ev);
 for(const request of [{...f.request},new Proxy(f.request,{})])assert.throws(()=>inspectSpCrt1Candidate({candidateId,request}),error('RULE_REQUEST_UNATTESTED'));
 for(const candidate of [{...f.candidate},new Proxy(f.candidate,{})])assert.throws(()=>evaluate(candidate),error('RULE_CANDIDATE_UNATTESTED'));
 for(const reviewEvidence of [{...ev},true,new Proxy(ev,{})])assert.throws(()=>evaluate(f.candidate,reviewEvidence),error('RULE_REVIEW_UNATTESTED'));
 assert.throws(()=>evaluate(other.candidate,ev),error('RULE_REVIEW_UNATTESTED'));assert.throws(()=>assertSpCrt1RuleReport(r,other.candidate),error('RULE_REPORT_UNATTESTED'));assert.throws(()=>assertSpCrt1RuleReport({...r},f.candidate),error('RULE_REPORT_UNATTESTED'));
 let reads=0;const input={request:f.request};Object.defineProperty(input,'candidateId',{enumerable:true,get(){reads++;return candidateId;}});assert.throws(()=>inspectSpCrt1Candidate(input),error('RULE_INPUT_INVALID'));assert.equal(reads,0);
});
test('missing/expired review is classification pending, never an alleged SEFAZ rejection or automatic zero tax',async()=>{
 const {candidate}=fixture(),missing=evaluate(candidate);assert.equal(missing.status,'pending_classification');has(missing,'pendingClassification','BACKEND_CLASSIFICATION_REVIEW_MISSING');assert.deepEqual(missing.invalidCombinations,[]);disabled(missing);
 const ev=await capture(candidate,r=>r.valid_until='2026-10-16T13:00:00Z'),expired=evaluate(candidate,ev,new Date('2026-10-16T13:00:00Z'));has(expired,'pendingClassification','BACKEND_REVIEW_EXPIRED');assert.equal(expired.review,null);
 assert.equal(await createSpCrt1ReviewReader({readReview:async()=>null})({candidate,now:NOW}),null);
});
test('NFCE deterministic CFOP/CSOSN and 101 limits differ from conservative NFe pairing policy',()=>{
 for(const [csosn,cfop] of [['102','5405'],['500','5102']]){
  const edit=x=>x.replace(/<CFOP>\d+<\/CFOP>/,`<CFOP>${cfop}</CFOP>`);
  has(evaluate(fixture({model:'65',csosn,edit}).candidate),'invalidCombinations','NFCE_CFOP_CSOSN_MISMATCH');
  const nfe=evaluate(fixture({model:'55',csosn,edit}).candidate);has(nfe,'unsupportedScope','NFE_CFOP_CSOSN_OUTSIDE_INITIAL_SCOPE');assert.ok(!codes(nfe,'invalidCombinations').includes('NFCE_CFOP_CSOSN_MISMATCH'));
 }
 // Build supported model65/102 first, then sign the deliberately incompatible group.
 has(evaluate(fixture({model:'65',edit:x=>x.replaceAll('ICMSSN102','ICMSSN101').replace('<CSOSN>102</CSOSN>','<CSOSN>101</CSOSN><pCredSN>4.00</pCredSN><vCredICMSSN>0.50</vCredICMSSN>')}).candidate),'invalidCombinations','NFCE_CSOSN101_NOT_ALLOWED');
 has(evaluate(fixture({csosn:'101'}).candidate),'invalidCombinations','NFE_CSOSN101_NONCONTRIBUTOR');
});
test('CSOSN500 CEST/retained-group rules are model-specific; optional own substituted ICMS is not fabricated',async()=>{
 const nfe=fixture({csosn:'500'}),nfce=fixture({model:'65',csosn:'500'});
 has(evaluate(nfe.candidate),'invalidCombinations','NFE_CSOSN500_CEST_REQUIRED');assert.ok(!codes(evaluate(nfce.candidate),'invalidCombinations').includes('NFE_CSOSN500_CEST_REQUIRED'));
 const omit=fixture({csosn:'500',edit:x=>x.replace('<indFinal>1','<indFinal>0').replace('</NCM>','</NCM><CEST>0800100</CEST>')});has(evaluate(omit.candidate),'invalidCombinations','NFE_NONFINAL_RETENTION_REQUIRED');
 const complete=fixture({csosn:'500',edit:x=>x.replace('<indFinal>1','<indFinal>0').replace('</NCM>','</NCM><CEST>0800100</CEST>').replace('</CSOSN>','</CSOSN><vBCSTRet>12.50</vBCSTRet><pST>18.00</pST><vICMSSTRet>2.25</vICMSSTRet>')});
 const ev=await capture(complete.candidate,r=>r.items[0].st='documented_prior_retention');assert.deepEqual(evaluate(complete.candidate,ev).invalidCombinations,[]);
 const broken=fixture({csosn:'500',edit:x=>x.replace('</CSOSN>','</CSOSN><vICMSSTRet>2.25</vICMSSTRet>')});has(evaluate(broken.candidate),'invalidCombinations','RETENTION_GROUP_INCOMPLETE');
 has(evaluate(nfce.candidate,await capture(nfce.candidate)),'pendingClassification','ST_RETENTION_BASIS_PENDING');
});
test('FCP retention is explicit, complete, positive when present, and four rate decimals are retained',async()=>{
 const add=rate=>x=>x.replace('</CSOSN>',`</CSOSN><vBCFCPSTRet>12.50</vBCFCPSTRet><pFCPSTRet>${rate}</pFCPSTRet><vFCPSTRet>0.25</vFCPSTRet>`);
 has(evaluate(fixture({model:'65',csosn:'500',edit:add('0.00')}).candidate),'invalidCombinations','FCP_RETENTION_RATE_ZERO_OR_INVALID');
 const good=fixture({model:'65',csosn:'500',edit:add('2.0000')}),ev=await capture(good.candidate,r=>{r.items[0].st='documented_prior_retention';r.items[0].fcp='documented_prior_retention';});assert.deepEqual(evaluate(good.candidate,ev).invalidCombinations,[]);
 has(evaluate(good.candidate,await capture(good.candidate,r=>r.items[0].st='documented_prior_retention')),'pendingClassification','FCP_APPLICABILITY_PENDING');
 has(evaluate(fixture({model:'65',csosn:'500',edit:x=>x.replace('</CSOSN>','</CSOSN><vFCPSTRet>0.25</vFCPSTRet>')}).candidate),'invalidCombinations','FCP_RETENTION_GROUP_INCOMPLETE');
});
test('SP exempt recipient exception does not blanket reject a retained-ST case or infer effective tax',()=>{
 const edit=x=>x.replace('<indIEDest>9','<indIEDest>2');has(evaluate(fixture({edit}).candidate),'invalidCombinations','SP_EXEMPT_IE_WITHOUT_EXCEPTION');
 const st=fixture({csosn:'500',edit:x=>edit(x).replace('</CSOSN>','</CSOSN><vBCSTRet>12.50</vBCSTRet><pST>18.00</pST><vICMSSTRet>2.25</vICMSSTRet>')});assert.ok(!codes(evaluate(st.candidate),'invalidCombinations').includes('SP_EXEMPT_IE_WITHOUT_EXCEPTION'));
 assert.ok(!JSON.stringify(evaluate(st.candidate)).includes('EFFECTIVE_REQUIRED'));
});
test('GTIN exact check digit and pair are deterministic; CCG/prefix/classification are never guessed',async()=>{
 const valid='7891234567895';const good=fixture({edit:x=>x.replaceAll('SEM GTIN',valid)});
 const r=evaluate(good.candidate,await capture(good.candidate,x=>x.items[0].gtin='reviewed_identifiers'));assert.deepEqual(r.invalidCombinations,[]);has(r,'pendingClassification','GS1_PREFIX_TABLE_NOT_PINNED');
 has(evaluate(fixture({edit:x=>x.replaceAll('SEM GTIN','7891234567896')}).candidate),'invalidCombinations','GTIN_CHECK_DIGIT_INVALID');
 has(evaluate(fixture({edit:x=>x.replace('<cEAN>SEM GTIN','<cEAN>'+valid)}).candidate),'invalidCombinations','GTIN_PAIR_MISMATCH');
});
test('benefit and PIS/COFINS49 require reviewed classification; no Simples-wide exemption or automatic tax',async()=>{
 const f=fixture();for(const [key,value,code,where] of [['benefit','unreviewed','BENEFIT_APPLICABILITY_PENDING','pendingClassification'],['benefit','applies','BENEFIT_REQUIRES_UNSUPPORTED_FIELD','unsupportedScope'],['pis_cofins','unreviewed','PIS_COFINS_CLASSIFICATION_PENDING','pendingClassification'],['pis_cofins','other','PIS_COFINS_REGIME_OUTSIDE_PROFILE','unsupportedScope']])has(evaluate(f.candidate,await capture(f.candidate,r=>r.items[0][key]=value)),where,code);
 for(const value of ['SEM CBENEF','SP000000'])has(evaluate(fixture({edit:x=>x.replace('</NCM>',`</NCM><cBenef>${value}</cBenef>`)}).candidate),'unsupportedScope',value==='SEM CBENEF'?'SEM_CBENEF_NOT_SUPPORTED':'BENEFIT_FIELD_OUTSIDE_PROFILE');
 has(evaluate(fixture({edit:x=>x.replace('<CST>49','<CST>99')}).candidate),'unsupportedScope','PIS_COFINS_BRANCH_OUTSIDE_PROFILE');
});
const statement='PERMITE O APROVEITAMENTO DO CRÉDITO DE ICMS NO VALOR DE R$ 0,50; CORRESPONDENTE À ALÍQUOTA DE 4,00%, NOS TERMOS DO ART. 23 DA LEI COMPLEMENTAR Nº 123, DE 2006';
const creditReview=r=>{r.document.recipient_regime='regular_icms';r.document.acquisition_purpose='resale';r.items[0].credit={eligibility:'reviewed_lc123_art23',base:'12.50',rate:'4.00',amount:'0.50',period:'2026-09',source_hash:'c'.repeat(64),statement};};
const creditEdit=x=>x.replace('<indFinal>1','<indFinal>0').replace('<indIEDest>9</indIEDest>','<indIEDest>1</indIEDest><IE>123456789012</IE>').replace('</infCpl>',`; ${statement}</infCpl>`);
test('101 binds eligibility, prior period, exact base/rate/value and disclosure without manufacturing credit',async()=>{
 const f=fixture({csosn:'101',edit:creditEdit});assert.equal(evaluate(f.candidate,await capture(f.candidate,creditReview)).status,'reviewed_subset');
 has(evaluate(f.candidate,await capture(f.candidate)),'pendingClassification','SN_CREDIT_ELIGIBILITY_PENDING');
 has(evaluate(f.candidate,await capture(f.candidate,r=>{creditReview(r);r.items[0].credit.base='13.50';})),'invalidCombinations','SN_CREDIT_REVIEW_VALUES_MISMATCH');
 has(evaluate(f.candidate,await capture(f.candidate,r=>{creditReview(r);r.items[0].credit.period='2026-10';})),'unsupportedScope','SN_CREDIT_PERIOD_OUTSIDE_INITIAL_SCOPE');
 const missing=fixture({csosn:'101',edit:x=>creditEdit(x).replace(statement,'TEXTO FICTICIO SEM CREDITO DECLARADO')});has(evaluate(missing.candidate,await capture(missing.candidate,creditReview)),'pendingClassification','SN_CREDIT_DISCLOSURE_PENDING');
});
test('payment comparison preserves exact cents and distinguishes NFe scope from NFCE required sum',()=>{
 const edit=x=>x.replace('<vPag>12.50','<vPag>12.49');has(evaluate(fixture({model:'65',edit}).candidate),'invalidCombinations','NFCE_PAYMENT_TOTAL_TOO_LOW');has(evaluate(fixture({model:'55',edit}).candidate),'unsupportedScope','PAYMENT_RECONCILIATION_OUTSIDE_INITIAL_SCOPE');
 has(evaluate(fixture({edit:x=>x.replace('<tPag>01','<tPag>03')}).candidate),'unsupportedScope','PAYMENT_METHOD_OUTSIDE_PROFILE');
 has(evaluate(fixture({edit:x=>x.replace('<vPag>12.50','<vPag>12.501')}).candidate),'invalidCombinations','PAYMENT_VALUES_INVALID');
});
test('26 October is an explicit local conservative boundary, not a tax deadline or blanket RTC demand',async()=>{
 const f=fixture(),ev=await capture(f.candidate),r=evaluate(f.candidate,ev,new Date('2026-10-26T03:00:00Z'));has(r,'unsupportedScope','PROFILE_REVIEW_DATE_OUTSIDE_WINDOW');assert.equal(r.temporalPolicy.officialTaxDeadline,false);assert.equal(r.unsupportedScope.find(x=>x.code==='PROFILE_REVIEW_DATE_OUTSIDE_WINDOW').kind,'brufap_temporal_policy');
 assert.ok(!JSON.stringify(r).includes('RTC_REQUIRED'));assert.ok(!JSON.stringify(r).includes('CSRT_REQUIRED'));disabled(r);assert.equal(SP_CRT1_RULE_MANIFEST_HASH,hash(JSON.stringify(SP_CRT1_RULE_MANIFEST)));
});
test('250 items remain bounded and reviewed per exact position/hash without accepting reordered evidence',async()=>{
 const f=fixture({count:250}),ev=await capture(f.candidate);assert.equal(f.candidate.itemCount,250);assert.equal(evaluate(f.candidate,ev).status,'reviewed_subset');
 await assert.rejects(capture(f.candidate,r=>r.items.reverse()),error('RULE_REVIEW_BINDING_MISMATCH'));
});
test('review read is mandatory, single call, bounded and immutable before the first await',async()=>{
 const f=fixture(),other=fixture({model:'65'});let calls=0,seen,opts;
 const read=createSpCrt1ReviewReader({readReview:async(q,o)=>{calls++;seen=q;opts=o;return bytes(JSON.stringify(review(q)));}}),input={candidate:f.candidate,now:new Date(NOW),deadline:Date.now()+1000};
 const promise=read(input);input.candidate=other.candidate;input.now.setFullYear(2030);input.deadline=0;const handle=await promise;
 assert.equal(calls,1);assert.equal(seen.signedHash,f.candidate.signedHash);assert.equal(handle.signedHash,f.candidate.signedHash);assert.equal(opts.maxBytes,MAX_RULE_REVIEW_BYTES);assert.ok(Object.isFrozen(seen.items[0]));assert.equal(opts.signal.aborted,true);
 assert.throws(()=>createSpCrt1ReviewReader({}),error('RULE_INPUT_INVALID'));await assert.rejects(read({candidate:{...f.candidate},now:NOW}),error('RULE_CANDIDATE_UNATTESTED'));assert.equal(calls,1);
});
test('review tampering in bindings/version/hash, invalid calendar or extra authority cannot enter evaluation',async()=>{
 const {candidate}=fixture();for(const patch of [r=>r.candidate_id=otherId,r=>r.signed_hash='f'.repeat(64),r=>r.facts_hash='f'.repeat(64),r=>r.items[0].item_hash='f'.repeat(64)])await assert.rejects(capture(candidate,patch),error('RULE_REVIEW_BINDING_MISMATCH'));
 for(const patch of [r=>r.version=0,r=>r.reviewed_at='2026-02-30T10:00:00Z',r=>r.valid_until='2026-10-25T10:00:00+14:01',r=>r.items[0].classification=true])await assert.rejects(capture(candidate,patch),error('RULE_REVIEW_INVALID'));
 const tampered=createSpCrt1ReviewReader({readReview:async q=>{const r=review(q);r.document.operation='outside_scope';return bytes(JSON.stringify(r));}});await assert.rejects(tampered({candidate,now:NOW}),error('RULE_REVIEW_HASH_MISMATCH'));
 await assert.rejects(capture(candidate,r=>r.taxRulesValidated=true),error('RULE_INPUT_INVALID'));
 const deep=createSpCrt1ReviewReader({readReview:async q=>{const r=review(q);let x=r.document;for(let i=0;i<30;i++)x=x.child={};return bytes(JSON.stringify(r));}});await assert.rejects(deep({candidate,now:NOW}),error('RULE_DATA_LIMIT'));
});
test('reader rejects shared/oversized/non-byte/malformed data and sanitizes port errors',async()=>{
 const {candidate}=fixture();for(const value of [new Uint8Array(new SharedArrayBuffer(3)),new Uint8Array(MAX_RULE_REVIEW_BYTES+1),{},'secret',new Uint8Array()])await assert.rejects(createSpCrt1ReviewReader({readReview:async()=>value})({candidate,now:NOW}),error('RULE_REVIEW_BYTES_INVALID'));
 await assert.rejects(createSpCrt1ReviewReader({readReview:async()=>bytes('{')})({candidate,now:NOW}),error('RULE_REVIEW_INVALID'));
 await assert.rejects(createSpCrt1ReviewReader({readReview:async()=>{throw new Error('PRIVATE BACKEND DETAIL');}})({candidate,now:NOW}),error('RULE_REVIEW_UNAVAILABLE'));
});
test('abort/deadline prevent new read and discard late result without replay or leaked handle',async()=>{
 const {candidate}=fixture();let calls=0,resolve,signal;
 const read=createSpCrt1ReviewReader({readReview:(q,o)=>{calls++;signal=o.signal;return new Promise(r=>{resolve=()=>r(bytes(JSON.stringify(review(q))));});}});
 const ac=new AbortController();ac.abort();await assert.rejects(read({candidate,now:NOW,signal:ac.signal}),error('RULE_REVIEW_ABORTED'));await assert.rejects(read({candidate,now:NOW,deadline:Date.now()-1}),error('RULE_REVIEW_TIMEOUT'));assert.equal(calls,0);
 const next=new AbortController(),pending=read({candidate,now:NOW,signal:next.signal});await Promise.resolve();next.abort();await assert.rejects(pending,error('RULE_REVIEW_ABORTED'));resolve();assert.equal(calls,1);assert.equal(signal.aborted,true);
 const timeout=read({candidate,now:NOW,deadline:Date.now()+15});await assert.rejects(timeout,error('RULE_REVIEW_TIMEOUT'));resolve();assert.equal(calls,2);
});
test('emission date is checked against the reviewed policy window and evaluation clock',()=>{
 for(const date of ['2026-10-15T09:00:00-03:00','2026-10-17T09:00:00-03:00','2026-10-26T09:00:00-03:00']){
  const f=fixture({edit:x=>x.replace('2026-10-16T09:00:00-03:00',date)}),r=evaluate(f.candidate);has(r,'unsupportedScope','EMISSION_DATE_OUTSIDE_REVIEW_WINDOW');assert.equal(r.unsupportedScope.find(x=>x.code==='EMISSION_DATE_OUTSIDE_REVIEW_WINDOW').kind,'brufap_temporal_policy');
 }
});
test('report attestation never executes a forged candidate getter',()=>{
 const f=fixture(),r=evaluate(f.candidate);let calls=0;const forged={get candidateId(){calls++;return f.candidate.candidateId;}};assert.throws(()=>assertSpCrt1RuleReport(r,forged),error('RULE_CANDIDATE_UNATTESTED'));assert.equal(calls,0);
});
test('parent tax attributes and foreign/prefixed groups cannot be silently classified',()=>{
 for(const parent of ['ICMS','PIS','COFINS','imposto','ICMSSN102','PISOutr','COFINSOutr'])assert.throws(()=>fixture({edit:x=>x.replace(`<${parent}>`,`<${parent} unreviewed="yes">`)}),error('RULE_XML_STRUCTURE_INVALID'));
 // The upstream signed-document verifier may reject a namespace/prefix even before this extractor.
 for(const edit of [x=>x.replace('<ICMSSN102>','<ICMSSN102 xmlns="urn:foreign">'),x=>x.replaceAll('ICMSSN102','n:ICMSSN102').replace('<n:ICMSSN102>','<n:ICMSSN102 xmlns:n="http://www.portalfiscal.inf.br/nfe">')])assert.throws(()=>fixture({edit}),e=>typeof e.code==='string');
});
test('deadline is rechecked after bounded JSON parsing, review hashing and validation',async()=>{
 const {candidate}=fixture();const original=Date.now,base=original();let armed=false,count=0;
 const read=createSpCrt1ReviewReader({readReview:async q=>{const value=bytes(JSON.stringify(review(q)));armed=true;return value;}});
 try{Date.now=()=>armed&&++count>=2?base+2000:base;await assert.rejects(read({candidate,now:NOW,deadline:base+1000}),error('RULE_REVIEW_TIMEOUT'));assert.equal(count,2);}finally{Date.now=original;}
});
