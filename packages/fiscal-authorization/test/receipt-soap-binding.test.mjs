import {TEST_PYTHON} from './test-runtime.mjs';
import assert from 'node:assert/strict';
import {test,before,after} from 'node:test';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {receiptFixture,receiptResponse,hash} from './receipt-fixtures.mjs';
import {receiptRequestBytes,receiptValidationContext} from '../src/receipt-core.mjs';
import {createReceiptValidator} from '../src/receipt-validator.mjs';
import {RECEIPT_SOAP_MANIFESTS,RECEIPT_SOAP_MANIFEST_HASHES,RECEIPT_SOAP_FLAGS,MAX_RECEIPT_SOAP_BYTES,
 reviewedReceiptBinding,verifyReviewedReceiptWsdl,prepareReviewedReceiptSoap,encodeReviewedReceiptSoap,extractReviewedReceiptSoap,ReceiptSoapBindingError} from '../src/receipt-soap-binding.mjs';
const SOAP='http://www.w3.org/2003/05/soap-envelope',SERVICE='http://www.portalfiscal.inf.br/nfe/wsdl/NFeRetAutorizacao4';
const bytes=v=>Buffer.from(v),text=v=>Buffer.from(v).toString(),envelope=p=>`<Envelope xmlns="${SOAP}"><Body><nfeResultMsg xmlns="${SERVICE}">${text(p)}</nfeResultMsg></Body></Envelope>`;
const error=code=>e=>e instanceof ReceiptSoapBindingError&&e.code===code&&e.message===code;
const rejected=e=>e instanceof ReceiptSoapBindingError&&e.message===e.code;
const disabled=v=>{for(const[k,x]of Object.entries(RECEIPT_SOAP_FLAGS))assert.equal(v[k],x,k);};
let f;before(async()=>{f=await receiptFixture();});after(()=>f?.close());
async function prepared(model='55'){const original=f.create(model),query=await original.query();return{original,query,soap:prepareReviewedReceiptSoap({request:query})};}
const response=(q,options)=>receiptResponse({...q,...receiptValidationContext(q)},options);

test('pins55/65 and exact endpoints/actions are separated and remain inactive',()=>{
 const hashes={55:'bb288d8bb187dbd909d163a1bcd26ab3bb6a16d960776771b57ab1584999a429',65:'a838070b990d2aee1148826f7c3569c70d797a261622345ebcec5837add470f9'};
 for(const model of ['55','65']){const b=reviewedReceiptBinding(model);assert.equal(b.source.sha256,hashes[model]);assert.equal(b.source.sizeBytes,model==='55'?3069:3072);assert.equal(b.endpoint,model==='55'?'https://homologacao.nfe.fazenda.sp.gov.br/ws/nferetautorizacao4.asmx':'https://homologacao.nfce.fazenda.sp.gov.br/ws/NFeRetAutorizacao4.asmx');assert.equal(b.outputPart,'nfeRetAutorizacaoLoteResult');assert.equal(b.outputElement,'nfeResultMsg');assert.equal(b.soapAction,SERVICE+'/nfeRetAutorizacaoLote');assert.equal(b.manifestHash,hash(JSON.stringify(RECEIPT_SOAP_MANIFESTS[model])));assert.equal(b.manifestHash,RECEIPT_SOAP_MANIFEST_HASHES[model]);for(const x of[b,b.source,b.wsdl,b.limitations])assert.equal(Object.isFrozen(x),true);disabled(b);}
 for(const model of ['55 ',55,'__proto__','authorization',null])assert.throws(()=>reviewedReceiptBinding(model),error('SOAP_RECEIPT_MODEL_UNSUPPORTED'));
});
test('consReciNFe bytes, original source identity and payload/envelope hashes survive copied-byte mutation',async()=>{
 for(const model of ['55','65']){const x=await prepared(model),b=encodeReviewedReceiptSoap(x.soap),p=receiptRequestBytes(x.query);assert.ok(text(b).includes(text(p)));assert.equal(x.soap.operation,'receipt');assert.equal(x.soap.authorizationCommandId,x.query.commandId);assert.equal(x.soap.sourceEvidenceHash,x.query.sourceEvidenceHash);assert.equal(x.soap.payloadHash,hash(p));assert.equal(x.soap.envelopeHash,hash(b));assert.notEqual(x.soap.payloadHash,x.soap.envelopeHash);assert.equal(x.soap.envelopeSizeBytes,b.length);assert.equal(x.soap.headers['Content-Type'],`application/soap+xml; charset=utf-8; action="${SERVICE}/nfeRetAutorizacaoLote"`);assert.deepEqual(Object.keys(x.soap.headers),['Content-Type']);assert.ok(!text(b).includes('nfeAutorizacaoLote'));disabled(x.soap);b.fill(0);p.fill(0);assert.equal(hash(encodeReviewedReceiptSoap(x.soap)),x.soap.envelopeHash);}
});
test('105,106,217 and104/100/150/rejection preserve the original103 and never authorize a retry',async()=>{
 for(const model of ['55','65']){const x=await prepared(model),initial=JSON.stringify(x.original.record);for(const [options,classification]of [[{batch:'105'},'receipt_pending'],[{batch:'106'},'review_required'],[{batch:'217'},'review_required'],[{status:'100'},'authorization_declared'],[{status:'150'},'authorization_declared'],[{status:'539'},'review_required'],[{status:'302'},'rejected']]){const c=extractReviewedReceiptSoap({request:x.soap,envelopeBytes:bytes(envelope(response(x.query,options)))});assert.equal(c.response.classification,classification);assert.equal(c.response.sourceState,'receipt_pending');assert.equal(c.response.origin,'synthetic');assert.equal(c.payloadHash,c.response.responseHash);disabled(c);}assert.equal(JSON.stringify(x.original.record),initial);}
});
test('opaque handles are checked before getters and free XML/URL/receipt overrides are refused',async()=>{
 const x=await prepared();let touched=0;const fake={get model(){touched++;throw Error('PRIVATE');}};
 for(const request of[fake,{...x.query},new Proxy(x.query,{get(){touched++;throw Error();}})])assert.throws(()=>prepareReviewedReceiptSoap({request}),error('SOAP_RECEIPT_SOURCE_UNATTESTED'));
 for(const request of[fake,{...x.soap}])assert.throws(()=>extractReviewedReceiptSoap({request,envelopeBytes:bytes('PRIVATE')}),error('SOAP_RECEIPT_REQUEST_UNATTESTED'));
 for(const field of ['xml','receiptNumber','endpoint','soapAction'])assert.throws(()=>prepareReviewedReceiptSoap({request:x.query,[field]:'PRIVATE'}),error('SOAP_RECEIPT_INPUT_INVALID'));
 assert.throws(()=>prepareReviewedReceiptSoap({get request(){touched++;return x.query;}}),error('SOAP_RECEIPT_INPUT_INVALID'));assert.equal(touched,0);
});
test('QNames accept prefixes/empty SOAP header but reject wrappers, headers and response ambiguity',async()=>{
 const x=await prepared(),payload=text(response(x.query)),valid=`<s:Envelope xmlns:s="${SOAP}"><s:Header/><s:Body><r:nfeResultMsg xmlns:r="${SERVICE}">${payload}</r:nfeResultMsg></s:Body></s:Envelope>`;
 assert.equal(extractReviewedReceiptSoap({request:x.soap,envelopeBytes:bytes(valid)}).response.cStat,'104');
 const bad=[valid.replace('<s:Header/>','<s:Header><x xmlns="urn:private"/></s:Header>'),valid.replaceAll(SOAP,'http://schemas.xmlsoap.org/soap/envelope/'),valid.replaceAll('nfeResultMsg','nfeRetAutorizacaoLoteResult'),valid.replaceAll('nfeResultMsg','nfeRetAutorizacaoLoteResponse'),valid.replaceAll(SERVICE,SERVICE.replace('RetAutorizacao','Autorizacao')),valid.replace(payload,payload+payload),valid.replace('<s:Body>','<s:Body/> <s:Body>'),valid.replace('<s:Body>','<s:Body private="1">'),valid.replace(payload,payload.replace('retConsReciNFe','retEnviNFe')),valid.replace('<s:Body>','<s:Body>private text')];
 for(const xml of bad)assert.throws(()=>extractReviewedReceiptSoap({request:x.soap,envelopeBytes:bytes(xml)}),rejected);
 const fault=`<Envelope xmlns="${SOAP}"><Body><Fault><Reason><Text>PRIVATE</Text></Reason></Fault></Body></Envelope>`;assert.throws(()=>extractReviewedReceiptSoap({request:x.soap,envelopeBytes:bytes(fault)}),error('SOAP_RECEIPT_FAULT'));
});
test('a55 protocol cannot resolve65; receipt, environment, digest and one-note batch remain contextual',async()=>{
 const a=await prepared('55'),b=await prepared('65'),payload=text(response(a.query));
 assert.throws(()=>extractReviewedReceiptSoap({request:b.soap,envelopeBytes:bytes(envelope(bytes(payload)))}),error('SOAP_RECEIPT_PAYLOAD_INVALID'));
 const ctx=receiptValidationContext(a.query),prot=payload.match(/<protNFe[\s\S]+<\/protNFe>/)[0];
 for(const changed of[payload.replace(a.query.receiptNumber,'350000000000002'),payload.replace('<tpAmb>2','<tpAmb>1'),payload.replace(ctx.referenceDigest,'AAAAAAAAAAAAAAAAAAAAAAAAAAA='),payload.replace(ctx.accessKey,'9'.repeat(44)),payload.replace('</retConsReciNFe>',prot+'</retConsReciNFe>')])assert.throws(()=>extractReviewedReceiptSoap({request:a.soap,envelopeBytes:bytes(envelope(bytes(changed)))}),error('SOAP_RECEIPT_PAYLOAD_INVALID'));
});
test('raw byte limits include SOAP; shared buffers/UTF8/DOCTYPE are refused without leaking body',async()=>{
 const x=await prepared(),raw=bytes(envelope(response(x.query))),store=Buffer.alloc(raw.length+10);store.set(raw,5);assert.equal(extractReviewedReceiptSoap({request:x.soap,envelopeBytes:store.subarray(5,-5)}).envelopeHash,hash(raw));
 for(const b of[Buffer.alloc(0),Buffer.alloc(MAX_RECEIPT_SOAP_BYTES+1),new Uint8Array(new SharedArrayBuffer(100)),new DataView(new ArrayBuffer(10)),'PRIVATE'])assert.throws(()=>extractReviewedReceiptSoap({request:x.soap,envelopeBytes:b}),error('SOAP_RECEIPT_BYTES_INVALID'));
 assert.throws(()=>extractReviewedReceiptSoap({request:x.soap,envelopeBytes:bytes([0xc0,0x80])}),error('SOAP_RECEIPT_ENCODING_INVALID'));
 assert.throws(()=>extractReviewedReceiptSoap({request:x.soap,envelopeBytes:bytes('<!DOCTYPE x SYSTEM "https://never.invalid">'+text(raw))}),error('SOAP_RECEIPT_XML_INVALID'));
 const padded=bytes(text(raw).replace('<Body>','<Body>'+' '.repeat(MAX_RECEIPT_SOAP_BYTES-raw.length)));assert.equal(padded.length,MAX_RECEIPT_SOAP_BYTES);assert.equal(extractReviewedReceiptSoap({request:x.soap,envelopeBytes:padded}).response.cStat,'104');
 let reads=0;Object.defineProperty(raw,'byteLength',{get(){reads++;throw Error();}});Object.defineProperty(raw,Symbol.iterator,{value(){reads++;throw Error();}});assert.equal(extractReviewedReceiptSoap({request:x.soap,envelopeBytes:raw}).envelopeHash,hash(raw));assert.equal(reads,0);
});
test('binding extraction does not replace real XSD validation55/65',async()=>{
 const validate=createReceiptValidator({pythonPath:TEST_PYTHON,validatorPath:fileURLToPath(new URL('../receipt-validator.py',import.meta.url))});
 for(const model of['55','65']){const x=await prepared(model);assert.equal((await validate({request:x.query,kind:'request',xmlBytes:receiptRequestBytes(x.query)})).ok,true);for(const wrongOrder of[false,true]){let p=text(response(x.query));if(wrongOrder)p=p.replace('<tpAmb>2</tpAmb><verAplic>SINTETICO</verAplic>','<verAplic>SINTETICO</verAplic><tpAmb>2</tpAmb>');const extracted=extractReviewedReceiptSoap({request:x.soap,envelopeBytes:bytes(envelope(bytes(p)))});assert.equal(extracted.xsdValidated,false);const r=await validate({request:x.query,kind:'response',xmlBytes:bytes(extracted.payloadXml)});assert.equal(r.ok,!wrongOrder);if(wrongOrder)assert.equal(r.code,'RECEIPT_XSD_INVALID');}}
});
test('observed public WSDL bytes match their own model and reject swapped/modified pins',{skip:process.env.BRUFAP_TEST_LOCAL_RECEIPT_WSDL!=='1'},()=>{
 for(const model of['55','65']){const raw=readFileSync(new URL(`../../../private/fiscal/wsdl/model-${model}-receipt-20261016.xml`,import.meta.url)),b=verifyReviewedReceiptWsdl({model,wsdlBytes:raw});assert.equal(b.source.sha256,hash(raw));assert.ok(text(raw).includes(b.soapAction));assert.ok(text(raw).includes(b.endpoint));const changed=Buffer.from(raw);changed[changed.length-1]^=1;assert.throws(()=>verifyReviewedReceiptWsdl({model,wsdlBytes:changed}),error('SOAP_RECEIPT_WSDL_MISMATCH'));assert.throws(()=>verifyReviewedReceiptWsdl({model:model==='55'?'65':'55',wsdlBytes:raw}),error('SOAP_RECEIPT_WSDL_MISMATCH'));}
});
