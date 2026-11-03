import test from 'node:test';
import assert from 'node:assert/strict';
import {gzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {buildAccessKey,cnpjCheckDigits} from '../../fiscal-core/src/identity.mjs';
import {buildDistributionRequest,parseDistributionResponse,inspectDistributionCoordination,planDistributionContinuation,DISTRIBUTION_LIMITS} from '../src/distribution.mjs';

const NS='http://www.portalfiscal.inf.br/nfe',SOAP='http://schemas.xmlsoap.org/soap/envelope/',SERVICE=NS+'/wsdl/NFeDistribuicaoDFe';
const cnpj='12345678000195',other='11222333000181',request={environment:'2',authorUf:'35',interestedCnpj:cnpj,lastNsu:'000000000000000'};
const key=buildAccessKey({cUF:'35',cnpj:other,model:'55',environment:'2',series:'1',number:'1',issuedAt:'2026-10-16T10:00:00-03:00',cNF:'12345678',tpEmis:'1'});
const coord={coordinator:'brufap',checkpointConfirmed:true,lastNsu:request.lastNsu,otherConsumersReviewed:true};
const summary=(k=key)=>`<resNFe xmlns="${NS}" versao="1.01"><chNFe>${k}</chNFe><CNPJ>${other}</CNPJ><xNome>EMPRESA FICTICIA</xNome><IE>ISENTO</IE><dhEmi>2026-10-16T10:00:00-03:00</dhEmi><tpNF>1</tpNF><vNF>25.70</vNF><digVal>AAAAAAAAAAAAAAAAAAAAAAAAAAA=</digVal><dhRecbto>2026-10-16T10:01:00-03:00</dhRecbto><nProt>135260000000001</nProt><cSitNFe>1</cSitNFe></resNFe>`;
const invoice=(recipient=cnpj,k=key)=>`<nfeProc xmlns="${NS}" versao="4.00"><NFe><infNFe Id="NFe${k}" versao="4.00"><ide><tpAmb>2</tpAmb></ide><dest><CNPJ>${recipient}</CNPJ></dest></infNFe></NFe><protNFe><infProt><tpAmb>2</tpAmb><chNFe>${k}</chNFe></infProt></protNFe></nfeProc>`;
const zip=(xml=summary(),nsu='000000000000001',schema='resNFe_v1.01.xsd')=>`<docZip${nsu===null?'':` NSU="${nsu}"`} schema="${schema}">${gzipSync(xml).toString('base64')}</docZip>`;
const reply=({status='138',last='000000000000001',max=last,docs=zip(),environment='2'}={})=>`<retDistDFeInt xmlns="${NS}" versao="1.01"><tpAmb>${environment}</tpAmb><verAplic>TESTE</verAplic><cStat>${status}</cStat><xMotivo>RESPOSTA SINTETICA</xMotivo><dhResp>2026-10-16T10:01:00-03:00</dhResp>${last===null?'':`<ultNSU>${last}</ultNSU>`}${max===null?'':`<maxNSU>${max}</maxNSU>`}${docs===null?'':`<loteDistDFeInt>${docs}</loteDistDFeInt>`}</retDistDFeInt>`;
const envelope=body=>`<s:Envelope xmlns:s="${SOAP}"><s:Body><nfeDistDFeInteresseResponse xmlns="${SERVICE}"><nfeDistDFeInteresseResult>${body}</nfeDistDFeInteresseResult></nfeDistDFeInteresseResponse></s:Body></s:Envelope>`;
const parse=(xml=reply(),options={})=>parseDistributionResponse(Buffer.from(xml),{request,...options});
const fail=code=>error=>error.code===code;
const plan=(response,coordination=coord)=>planDistributionContinuation({response,coordination,receivedAt:'2026-10-16T10:02:00-03:00'});

test('request is exact distNSU55 offline, including explicit production and alphanumeric CNPJ without transmission',()=>{
 const frozen=Object.freeze({...request}),r=buildDistributionRequest(frozen);assert.equal(r.request.lastNsu,'000000000000000');assert.match(r.xml,/versao="1.01"/);assert.match(r.xml,/<CNPJ>12345678000195<\/CNPJ>/);assert.equal(r.canQuery,false);assert.equal(r.canManifest,false);assert.equal(r.request.model,'55');
 const base='12ABC34501DE',alpha=base+cnpjCheckDigits(base);assert.match(buildDistributionRequest({...request,environment:'1',interestedCnpj:alpha}).xml,new RegExp(alpha));
 for(const patch of[{lastNsu:0},{lastNsu:'0'},{lastNsu:'1000000000000000'},{interestedCnpj:'00000000000000'},{authorUf:'91'},{environment:'3'},{lastNsu:'000000000000001<evil/>'},{url:'https://evil.invalid'},{model:'65'}])assert.throws(()=>buildDistributionRequest({...request,...patch}));
});
test('137 and exhausted138 wait one hour using trusted receipt time, not remote clock',async()=>{
 const empty=await parse(reply({status:'137',last:request.lastNsu,max:request.lastNsu,docs:null}));assert.equal(plan(empty).action,'wait');assert.equal(plan(empty).notBefore,'2026-10-16T14:02:00.000Z');
 const r=await parse();assert.equal(r.documents[0].kind,'invoice_summary');assert.equal(r.documents[0].recipientMatch,null);assert.equal(r.documents[0].xml,summary());assert.equal(r.signatureVerified,false);assert.equal(r.sefazAuthorized,false);
 const next=plan(r);assert.equal(next.action,'commit_batch_then_wait');assert.equal(next.candidateCheckpoint,'000000000000001');assert.equal(next.requiresAtomicPersistence,true);assert.equal(next.canQuery,false);
});
test('656 never moves checkpoint even if server reports another lastNSU; other codes stay in review',async()=>{
 const r=await parse(reply({status:'656',last:'000000000001234',max:'000000000001234',docs:null}));const next=plan(r);assert.equal(next.action,'wait_and_review');assert.equal(next.candidateCheckpoint,null);assert.equal(next.reportedCheckpoint,'000000000001234');assert.equal(next.requiresOperatorReview,true);assert.equal(next.notBefore,'2026-10-16T14:02:00.000Z');
 for(const status of['108','109','589','999'])assert.equal(plan(await parse(reply({status,last:null,max:null,docs:null}))).action,'review_required');
});
test('coordination and explicit checkpoint are mandatory, without silently starting at zero',async()=>{
 const missing={coordinator:'unconfirmed',checkpointConfirmed:false,lastNsu:null,otherConsumersReviewed:false};assert.equal(inspectDistributionCoordination(missing).ready,false);
 assert.equal(plan(await parse(),missing).action,'coordination_required');assert.equal(plan(await parse(),{...coord,coordinator:'external'}).candidateCheckpoint,null);
 assert.equal(plan(await parse(),{...coord,lastNsu:'000000000000099'}).action,'review_required');assert.throws(()=>inspectDistributionCoordination({...coord,lastNsu:0}));
});
test('SOAP exact context, namespaces, environment and duplicate response nodes are enforced',async()=>{
 assert.equal((await parse(envelope(reply()))).documents.length,1);
 for(const xml of[envelope(reply()).replace('nfeDistDFeInteresseResult>','nfeDistDFeInteresseResult><extra/>'),envelope(reply()).replace(SOAP,'https://evil.invalid/'),envelope(reply()+reply()),reply().replace('<tpAmb>2','<tpAmb>1'),reply().replace('<cStat>138</cStat>','<cStat>138</cStat><cStat>138</cStat>'),reply().replace('<verAplic>','text<verAplic>')])await assert.rejects(()=>parse(xml));
 await assert.rejects(()=>parse(reply({status:'137'})),fail('DFE_STATUS_DOCUMENTS_MISMATCH'));
});
test('full XML is distinct from summary; another recipient is not classified as a received invoice',async()=>{
 const r=await parse(reply({docs:zip(invoice(),undefined,'procNFe_v4.00.xsd')}));assert.equal(r.documents[0].kind,'invoice');assert.equal(r.documents[0].recipientMatch,true);assert.equal(r.xsdValidated,false);
 const otherRecipient=await parse(reply({docs:zip(invoice(other),undefined,'procNFe_v4.00.xsd')}));assert.equal(otherRecipient.documents[0].recipientMatch,false);assert.deepEqual(otherRecipient.documents[0].issues,['OTHER_INTEREST_NOT_RECEIVED_INVOICE']);
 await assert.rejects(()=>parse(reply({docs:zip(invoice().replace('<tpAmb>2','<tpAmb>1'),undefined,'procNFe_v4.00.xsd')})),fail('DFE_DOCUMENT_CONTEXT_MISMATCH'));
});
test('document type/version/access-key binding rejects NFCe65 and mismatched schema or protocol',async()=>{
 const key65=buildAccessKey({cUF:'35',cnpj:other,model:'65',environment:'2',series:'1',number:'1',issuedAt:'2026-10-16T10:00:00-03:00',cNF:'12345678',tpEmis:'1'});
 await assert.rejects(()=>parse(reply({docs:zip(summary(key65))})),fail('DFE_DOCUMENT_ACCESS_KEY_INVALID'));
 await assert.rejects(()=>parse(reply({docs:zip(summary(),undefined,'procNFe_v4.00.xsd')})),fail('DFE_DOCUMENT_SCHEMA_MISMATCH'));
 await assert.rejects(()=>parse(reply({docs:zip(invoice().replace(`<chNFe>${key}`,`<chNFe>${'0'.repeat(44)}`),undefined,'procNFe_v4.00.xsd')})),fail('DFE_DOCUMENT_CONTEXT_MISMATCH'));
});
test('unknown schemas are bounded private quarantine, never fetched as URLs or interpreted as invoices',async()=>{
 const r=await parse(reply({docs:zip('<future xmlns="urn:future"/>',undefined,'future_v2.00.xsd')}));assert.equal(r.documents[0].kind,'unsupported');assert.equal(r.documents[0].quarantined,true);assert.equal(r.documents[0].accessKey,null);assert.deepEqual(plan(r).issues,['QUARANTINE_MUST_BE_DURABLE_BEFORE_CHECKPOINT']);
 for(const schema of['https://evil.invalid/file.xsd','../file.xsd','file%2exsd','file.xsd?x'])await assert.rejects(()=>parse(reply({docs:zip(summary(),undefined,schema)})),fail('DFE_SCHEMA_NAME_INVALID'));
});
test('NSUs remain exact strings at15 digits and at most50 documents are accepted',async()=>{
 const first=999999999999900n,req={...request,lastNsu:String(first)},documents=Array.from({length:50},(_,i)=>zip(summary(),String(first+BigInt(i)+1n))).join('');
 const r=await parse(reply({last:String(first+50n),max:String(first+51n),docs:documents}),{request:req});assert.equal(r.documents.length,50);assert.equal(planDistributionContinuation({response:r,coordination:{...coord,lastNsu:req.lastNsu},receivedAt:'2026-10-16T10:02:00-03:00'}).action,'commit_batch_then_continue');
 await assert.rejects(()=>parse(reply({last:'000000000000051',docs:Array.from({length:51},(_,i)=>zip(summary(),String(i+1).padStart(15,'0'))).join('')})),fail('DFE_DOCUMENT_COUNT_INVALID'));
});
test('gaps, missingNSU and a changed empty cursor require explicit review, not silent checkpoint changes',async()=>{
 for(const r of[await parse(reply({docs:zip(summary(),null)})),await parse(reply({last:'000000000000002',docs:zip(summary(),'000000000000002')})),await parse(reply({status:'137',last:'000000000000001',docs:null}))])assert.equal(plan(r).action,'review_required');
 for(const docs of[zip()+zip(),zip(summary(),'000000000000002')+zip(summary(),'000000000000001')])await assert.rejects(()=>parse(reply({last:'000000000000002',docs})),fail('DFE_DOCUMENT_NSU_ORDER_INVALID'));
});
test('strict UTF8, DTD, entities, PI, comments and nested XML limits fail without reflecting input',async()=>{
 for(const xml of['<!DOCTYPE x [<!ENTITY x SYSTEM "file:///secret">]>'+reply(),reply().replace('<cStat>','<!--secret--><cStat>'),reply().replace('<cStat>','<?secret value?><cStat>')])await assert.rejects(()=>parse(xml),e=>e.code.startsWith('DFE_')&&!e.message.includes('secret'));
 await assert.rejects(()=>parseDistributionResponse(new Uint8Array([0xc0,0x80]),{request}),fail('DFE_UTF8_INVALID'));
 await assert.rejects(()=>parse(reply({docs:zip('<x>'.repeat(90)+'</x>'.repeat(90),undefined,'future.xsd')})),fail('DFE_XML_TREE_LIMIT'));
});
test('base64/gzip corruption, bombs and timeouts are bounded with all-or-nothing output',async()=>{
 await assert.rejects(()=>parse(reply().replace(/>H4s[^<]+</,'>not-base64<')),fail('DFE_BASE64_INVALID'));
 const broken=gzipSync(summary());broken[broken.length-5]^=1;await assert.rejects(()=>parse(reply({docs:`<docZip NSU="000000000000001" schema="resNFe_v1.01.xsd">${broken.toString('base64')}</docZip>`})),fail('DFE_GZIP_INVALID'));
 await assert.rejects(()=>parse(reply({docs:zip('x'.repeat(DISTRIBUTION_LIMITS.documentBytes+1),undefined,'future.xsd')})),fail('DFE_GZIP_OUTPUT_LIMIT'));
 await assert.rejects(()=>parse(reply(),{deadline:Date.now()-1}),fail('DFE_TIMEOUT'));
 const controller=new AbortController();controller.abort();await assert.rejects(()=>parse(reply(),{signal:controller.signal}),fail('DFE_ABORTED'));
});
test('batch output limit applies across individually acceptable compressed documents',async()=>{
 const xml='<future>'+(' '.repeat(7*1024*1024))+'</future>',docs=Array.from({length:5},(_,i)=>zip(xml,String(i+1).padStart(15,'0'),'future.xsd')).join('');
 await assert.rejects(()=>parse(reply({docs,last:'000000000000005'}),{deadline:Date.now()+30000}),fail('DFE_BATCH_OUTPUT_LIMIT'));
});
test('events preserve their own type and require correlated key/environment without manifesting anything',async()=>{
 const xml=`<procEventoNFe xmlns="${NS}" versao="1.00"><evento><infEvento><tpAmb>2</tpAmb><chNFe>${key}</chNFe></infEvento></evento><retEvento><infEvento><tpAmb>2</tpAmb><chNFe>${key}</chNFe></infEvento></retEvento></procEventoNFe>`;
 const r=await parse(reply({docs:zip(xml,undefined,'procEventoNFe_v1.00.xsd')}));assert.equal(r.documents[0].kind,'event');assert.equal(r.canManifest,false);assert.equal(r.financialMutationPerformed,false);assert.equal(r.stockMutationPerformed,false);
});
test('caller mutation during asynchronous inflation cannot change the captured response digest',async()=>{
 const original=Buffer.from(reply()),expected=createHash('sha256').update(original).digest('hex');
 const pending=parseDistributionResponse(original,{request});original.fill(32);const r=await pending;
 assert.equal(r.responseHash,expected);assert.equal(r.documents[0].xml,summary());
});
test('checkpoint planning accepts only the immutable parser result, never a forged or serialized envelope',async()=>{
 const r=await parse(reply({docs:zip(invoice(other),undefined,'procNFe_v4.00.xsd')}));
 for(const forged of[{...r},JSON.parse(JSON.stringify(r)),{...r,documents:[],issues:[],lastNsu:'000000000000099',maxNsu:'000000000000099'},new Proxy(r,{})])assert.throws(()=>plan(forged),fail('DFE_PLAN_UNTRUSTED'));
 assert.throws(()=>{r.documents[0].issues.length=0;},TypeError);
 assert.throws(()=>{r.request.lastNsu='000000000000099';},TypeError);
 assert.throws(()=>{r.documents[0].xml='<other/>';},TypeError);
 assert.equal(plan(r).candidateCheckpoint,'000000000000001');
 // A durable envelope must be re-parsed from the original bytes, not re-branded from JSON.
 assert.equal(plan(await parse()).action,'commit_batch_then_wait');
});
