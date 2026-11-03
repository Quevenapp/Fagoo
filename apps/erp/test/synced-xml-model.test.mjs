import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {syncedXmlParams,syncedXmlPage,syncedXmlFilename,verifySyncedXmlBlob} from '../src/lib/synced-xml-model.ts';
const id='10000000-0000-4000-8000-000000000001',bytes=new TextEncoder().encode('<synthetic>FICTICIO</synthetic>'),hash=createHash('sha256').update(bytes).digest('hex');
const filters={q:'',model:'',kind:'',include_history:false};
const row={id,source_id:'10001',entity:'nfe',key:'3'.repeat(20)+'55'+'0'.repeat(22),model:'55',environment:'1',kind:'invoice',revision:1,source_status:'6',collected_at:'2026-10-16T12:00:00Z',xml_hash:hash,size_bytes:bytes.length,
 protocol:'123456789012345',protocol_present:true,signature_present:true,event_type:null,event_sequence:null,issues:[],validation:'structural_only',signature_verified:false,xsd_validated:false,authorization_verified:false};
const page={items:[row],limit:25,has_more:false,next_cursor:null,data_mode:'fiscal_archive_readonly'};
test('filter/model projection is bounded, explicit and never exposes storage metadata',()=>{
 assert.equal(syncedXmlParams({...filters,model:'55',kind:'invoice',include_history:true,q:' 35 '}).toString(),'limit=25&include_history=true&q=35&model=55&kind=invoice');
 assert.deepEqual(syncedXmlPage({...page,items:[{...row,object_key:'PRIVATE',payload:'PRIVATE'}]},filters),page);
 for(const changed of [{q:'x'.repeat(65)},{q:'\n'},{model:'57'},{kind:'anything'},{include_history:'true'}])assert.throws(()=>syncedXmlParams({...filters,...changed}));
 assert.equal(syncedXmlFilename(row),`origin-55-${hash.slice(0,12)}.xml`);
});
test('mismatched filters, verification claims, duplicate IDs and paging inconsistencies are refused',()=>{
 for(const changed of [{authorization_verified:true},{signature_verified:true},{xsd_validated:true},{validation:'authorized'},{size_bytes:8388609},{event_type:'110111'},{key:'bad'},{entity:'nfce'},{protocol_present:false}])assert.throws(()=>syncedXmlPage({...page,items:[{...row,...changed}]},filters));
 assert.throws(()=>syncedXmlPage(page,{...filters,model:'65'}));assert.throws(()=>syncedXmlPage(page,filters,id));
 assert.throws(()=>syncedXmlPage({...page,items:[row,row]},filters));assert.throws(()=>syncedXmlPage({...page,next_cursor:id},filters));assert.throws(()=>syncedXmlPage({...page,has_more:true,next_cursor:id},filters));
});
test('browser download requires matching complete bytes and stops after cancellation',async()=>{
 const blob=new Blob([bytes],{type:'application/octet-stream'});assert.equal(await verifySyncedXmlBlob(blob,row),blob);
 for(const invalid of [new Blob([bytes.slice(1)]),new Blob([new Uint8Array(bytes.length)])])await assert.rejects(()=>verifySyncedXmlBlob(invalid,row));
 const request=new AbortController();request.abort();await assert.rejects(()=>verifySyncedXmlBlob(blob,row,request.signal),error=>error.name==='AbortError');
});
