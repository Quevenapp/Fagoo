import test from 'node:test';
import assert from 'node:assert/strict';
import {archiveKey,inspectArchivedXml,decodeArchivedDocuments,XML_ARCHIVE_LIMITS} from '../../../packages/fiscal-xml/src/archive.mjs';
import {invoice,event,keyFor,encoded} from './xml-fixtures.mjs';
const inspect=(xml,model='55')=>inspectArchivedXml(new TextEncoder().encode(xml),{key:keyFor(model),entity:model==='55'?'nfe':'nfce'});
const decode=(data,options={})=>decodeArchivedDocuments(data,{key:keyFor('55'),entity:'nfe',...options});
test('archive accepts production55 and65 contingency with CDATA while asserting only structure',async()=>{
 for(const model of['55','65']){const xml=invoice(model),meta=inspect(xml,model);assert.equal(meta.model,model);assert.equal(meta.environment,'1');assert.equal(meta.protocol_present,true);assert.equal(meta.signature_present,true);assert.deepEqual(meta.issues,[]);
  const docs=await decode([encoded(xml)],{key:keyFor(model),entity:model==='55'?'nfe':'nfce'});assert.equal(docs.length,1);assert.equal(new TextDecoder().decode(docs[0].bytes),xml);assert.match(docs[0].hash,/^[a-f0-9]{64}$/);assert.ok(!('authorized'in meta));}
 assert.equal(inspect(event()).kind,'event');assert.equal(inspect(event()).event_type,'110111');
});
test('archive binds exact key, model, invoice fields, protocol and event identity',()=>{
 const xml=invoice();for(const bad of[xml.replace('<mod>55','<mod>65'),xml.replace('<serie>1','<serie>2'),xml.replace('<CNPJ>11222333000181','<CNPJ>11222333000182'),xml.replace('<chNFe>'+keyFor('55'),'<chNFe>'+keyFor('65')),xml.replace('<cNF>12345678','<cNF>12345679'),xml.replace('2026-10-16','2025-10-16')])assert.throws(()=>inspect(bad),/XML_(KEY|PROTOCOL)_MISMATCH/);
 assert.throws(()=>archiveKey(keyFor('55'),'nfce'),/XML_KEY_INVALID/);assert.throws(()=>archiveKey('0'.repeat(44),'nfe'),/XML_KEY_INVALID/);
 assert.throws(()=>inspect(event().replace('ID110111','ID110110')),/XML_EVENT_INVALID/);
 assert.throws(()=>inspect(xml.replace('</nfeProc>',xml.match(/<NFe>.*<\/NFe>/)[0]+'</nfeProc>')),/XML_STRUCTURE_AMBIGUOUS|XML_KEY_MISMATCH/);
});
test('DTD, external entities, malformed XML, encoding tricks and deep trees fail before any storage',()=>{
 for(const xml of['<!DOCTYPE x [<!ENTITY e SYSTEM "file:///secret">]>'+invoice(),invoice().replace('SYNTHETIC ARCHIVE FIXTURE','&unknown;'),invoice().replace('</NFe>',''),'<wrapper>'+invoice()+'</wrapper>',invoice().replace('<infAdic>','<infAdic>'+'<x>'.repeat(70)).replace('</infAdic>','</x>'.repeat(70)+'</infAdic>')])assert.throws(()=>inspect(xml),/^Error: XML_/);
 assert.throws(()=>inspectArchivedXml(new Uint8Array([255,254,0,0]),{key:keyFor('55'),entity:'nfe'}),/XML_ENCODING_INVALID/);
});
test('base64, gzip, compressed/inflated limits and deadline are enforced for the entire set',async()=>{
 for(const data of[[],Array.from({length:11},()=>encoded(invoice())),[{nome:'x',conteudo:'!!!!'}],[{nome:'x',conteudo:Buffer.from('not gzip').toString('base64')}],[{nome:'x',conteudo:'A'.repeat(Math.ceil(XML_ARCHIVE_LIMITS.compressed/3)*4+4)}]])await assert.rejects(decode(data),/^Error: XML_/);
 await assert.rejects(decode([encoded(' '.repeat(1000000))]),/XML_INFLATED_LIMIT/);
 await assert.rejects(decode([encoded(invoice())],{deadline:1,now:()=>2}),/XML_TIME_LIMIT/);
 const controller=new AbortController();controller.abort();await assert.rejects(decode([encoded(invoice())],{signal:controller.signal}),/XML_ABORTED/);
 await assert.rejects(decode([encoded(invoice()),encoded('malformed')]),/XML_MALFORMED|XML_STRUCTURE_AMBIGUOUS/);
 const result=await decode([encoded(invoice()),encoded(invoice()),encoded(event())]);assert.equal(result.length,2);assert.ok(result[0].hash<result[1].hash);
});
