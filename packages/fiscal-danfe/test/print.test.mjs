import test from 'node:test';
import assert from 'node:assert/strict';
import jsQR from 'jsqr';
import {extractCandidatePreview,renderCandidateHtml,inspectDeclaredProtocol} from '../src/index.mjs';
import {code128C,qrCode} from '../src/codes.mjs';
import {decimalPt,localDate} from '../src/format.mjs';
import {candidateFixture,changed,maximalHeader} from './fixtures.mjs';
const f55=await candidateFixture({model:'55',csosn:'500'}),f65=await candidateFixture({model:'65'});
const read=f=>extractCandidatePreview(f.bytes,f.context);
test('actual synthetic signed 55/65 produce only branded immutable homologation previews',()=>{
 for(const f of[f55,f65]){assert.equal(f.signed.signatureVerified,true);const data=read(f),result=renderCandidateHtml(data);assert.equal(data.source.sha256,f.signed.xmlDigest);assert.equal(result.source_sha256,f.context.sha256);assert.equal(result.authorized,false);assert.equal(data.signature_verified,false);assert.equal(data.xsd_validated,false);assert.equal(result.can_transmit,false);assert.equal(data.declared_protocol,null);assert.ok(Object.isFrozen(data.items[0]));assert.throws(()=>{data.totals.vNF='0.00';});assert.throws(()=>renderCandidateHtml(structuredClone(data)),/PRINT_UNTRUSTED_PROJECTION/);assert.match(result.html,/NÃO AUTORIZADA/);assert.match(result.html,/Não há protocolo de autorização/);assert.doesNotMatch(result.html,/<script\b|<iframe\b|<img\b|X509Certificate|SignatureValue|candidate_id/);}
});
test('HTML escapes XML text, renders no raw certificates and has no resource loaders or javascript',()=>{
 const html=renderCandidateHtml(read(f55)).html;assert.match(html,/&lt;script&gt;não executar&lt;\/script&gt;/);assert.match(html,/A &amp; B/);assert.match(html,/default-src 'none'/);assert.doesNotMatch(html,/<(?:script|link|img|iframe|object|embed)\b|\son\w+=|\shref=|\bsrc=|url\(/i);
 assert.equal(renderCandidateHtml(read(f55)).sha256,renderCandidateHtml(read(f55)).sha256);
});
test('exact decimals including 10-place prices survive printing; formatting does not recompute values',async()=>{
 const f=await candidateFixture({model:'55',quantity:'1.234500',unit_price:'12.1234567891'}),data=read(f),html=renderCandidateHtml(data).html;
 assert.equal(data.items[0].unit_price,'12.1234567891');assert.equal(decimalPt(data.items[0].unit_price),'12,1234567891');assert.match(html,/12,1234567891/);assert.equal(data.items[0].product_amount,'14.97');assert.match(html,/14,97/);
 assert.equal(decimalPt('9999999999.9999999999'),'9.999.999.999,9999999999');assert.equal(decimalPt(null),'-');assert.equal(localDate('2026-10-16T01:30:00Z'),'15/10/2026, 22:30:00');
 const altered=changed(f,x=>x.replace('<vNF>14.97</vNF>','<vNF>14.98</vNF>'));assert.equal(read(altered).totals.vNF,'14.98'); // Projection is not a new arithmetic/XSD verifier.
 const departure=changed(f,x=>x.replace('</dhEmi>','</dhEmi><dhSaiEnt>2026-10-17T01:30:00Z</dhSaiEnt>'));
 assert.match(renderCandidateHtml(read(departure)).html,/SAÍDA \/ ENTRADA - SÃO PAULO/);assert.match(renderCandidateHtml(read(departure)).html,/16\/10\/2026, 22:30:00/);
});
test('QR is the exact XML SP online v3 payload, M UTF-8 and independently decodable without network',()=>{
 const data=read(f65),out=qrCode(data.qr);assert.equal(out.error_correction,'M');assert.equal(out.encoding,'UTF-8');const scale=6,edge=out.size+out.quiet*2,width=edge*scale,pixels=new Uint8ClampedArray(width*width*4);pixels.fill(255);
 for(let y=0;y<out.size;y++)for(let x=0;x<out.size;x++)if(out.matrix[y][x])for(let yy=0;yy<scale;yy++)for(let xx=0;xx<scale;xx++){const i=(((y+out.quiet)*scale+yy)*width+(x+out.quiet)*scale+xx)*4;pixels[i]=pixels[i+1]=pixels[i+2]=0;}
 const decoded=jsQR(pixels,width,width);assert.ok(decoded);assert.equal(decoded.data,data.qr);assert.ok(36*out.size/edge>=22);assert.ok(36*out.quiet/edge>=3.6);assert.doesNotMatch(out.svg,/href|src|script/i);
 for(const transform of[x=>x.replace('homologacao.nfce.fazenda.sp.gov.br/qrcode','evil.invalid/qrcode'),x=>x.replace('|3|2','|2|2'),x=>x.replace('|3|2','|3|1')])assert.throws(()=>read(changed(f65,transform)),/PRINT_QR_PROFILE_UNSUPPORTED/);
});
test('CODE128C has 22 data symbols, weighted checksum, stop and 10-module quiet zones',()=>{
 const data=read(f55),out=code128C(data.key);assert.equal(out.modules,297);assert.equal(out.symbols.length,25);assert.equal(out.symbols[0],105);assert.equal(out.symbols.at(-1),106);assert.equal(out.symbols.slice(1,-2).map(n=>String(n).padStart(2,'0')).join(''),data.key);
 assert.equal(out.checksum,out.symbols.slice(0,-2).reduce((sum,v,i)=>sum+v*Math.max(i,1),0)%103);assert.match(out.svg,/M10 0/);assert.match(out.svg,/width="76mm" height="9.22mm"/);assert.throws(()=>code128C('<script>'),/PRINT_BARCODE_INVALID/);
});
test('250 items and long text are paginated without truncation, with key and page identity repeated',async()=>{
 const f=await candidateFixture({count:250}),data=read(f),r=renderCandidateHtml(data);assert.ok(r.page_count>2&&r.page_count<=100);assert.equal((r.html.match(/class="page"/g)||[]).length,r.page_count);assert.equal((r.html.match(/PRÉVIA DE HOMOLOGAÇÃO/g)||[]).length,r.page_count);assert.equal((r.html.match(/NÃO AUTORIZADA/g)||[]).length,r.page_count);assert.equal((r.html.match(/class="detail"/g)||[]).length,250);assert.ok(r.html.includes('Folha '+r.page_count+'/'+r.page_count));assert.doesNotMatch(r.html,/text-overflow|ellipsis|overflow:hidden/);
});
test('accepted XML header limits cannot escape a declared print page: oversized layout is rejected explicitly',async()=>{
 const f=await candidateFixture({transformUnsigned:maximalHeader}),data=read(f);
 assert.equal(data.issuer.name.length,120);assert.equal(data.issuer.address.street.length,120);assert.equal(data.recipient.address.complement.length,120);assert.equal(data.payments.length,25);
 assert.throws(()=>renderCandidateHtml(data),/PRINT_HEADER_TOO_LARGE/);
});
test('wrong artifact/context and active or unsupported XML content fail closed before layout',()=>{
 assert.throws(()=>extractCandidatePreview(f55.bytes,{...f55.context,sha256:'0'.repeat(64)}),/PRINT_ARTIFACT_MISMATCH/);
 assert.throws(()=>extractCandidatePreview(f55.bytes,{...f55.context,environment:'1'}));
 assert.throws(()=>extractCandidatePreview(f55.bytes,{...f55.context,authorized:true}));
 let getter=false;const bad={...f55.context};Object.defineProperty(bad,'model',{get(){getter=true;return '55';}});assert.throws(()=>extractCandidatePreview(f55.bytes,bad));assert.equal(getter,false);
 for(const transform of[x=>'<!DOCTYPE NFe [<!ENTITY x SYSTEM "file:///etc/passwd">]>'+x,x=>x.replace('<total>','<total><IBSCBSTot/>'),x=>x.replace('<modFrete>9</modFrete>','<modFrete>9</modFrete><transporta/>'),x=>x.replace('<mod>55</mod>','<mod>55</mod><mod>55</mod>'),x=>x.replace('</cNF>','</cNF><cNF>12345678</cNF>'),x=>x.replace('2026-10-16T09:00:00-03:00','2026-02-30T09:00:00-03:00')])assert.throws(()=>read(changed(f55,transform)));
});
test('shared backing buffers are rejected before parsing or history inspection',()=>{
 const bytes=new Uint8Array(new SharedArrayBuffer(f55.bytes.length));bytes.set(f55.bytes);
 assert.throws(()=>extractCandidatePreview(bytes,f55.context),/PRINT_SIZE_LIMIT/);
 assert.throws(()=>inspectDeclaredProtocol(bytes,{key:read(f55).key,entity:'nfe'}),/PRINT_SIZE_LIMIT/);
});
test('a protocol declared in an archived nfeProc never creates authorization or a printable historic projection',()=>{
 const key=read(f55).key,xml=new TextDecoder().decode(f55.bytes),historical=new TextEncoder().encode(`<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">${xml}<protNFe versao="4.00"><infProt><tpAmb>2</tpAmb><chNFe>${key}</chNFe><nProt>13526000000000001</nProt><cStat>100</cStat></infProt></protNFe></nfeProc>`);
 const result=inspectDeclaredProtocol(historical,{key,entity:'nfe'});assert.equal(result.protocol_present,true);assert.equal(result.protocol,'13526000000000001');assert.equal(result.protocol_evidence,'declared_only');assert.equal(result.authorization_verified,false);assert.equal(result.render_authorized,false);assert.throws(()=>renderCandidateHtml(result),/PRINT_UNTRUSTED_PROJECTION/);
 const noProtocol=inspectDeclaredProtocol(f55.bytes,{key,entity:'nfe'});assert.equal(noProtocol.protocol_present,false);assert.equal(noProtocol.authorization_verified,false);
});
