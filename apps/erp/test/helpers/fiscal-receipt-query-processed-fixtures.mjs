import {processedReceiptQueryFixtures} from '../../../../packages/fiscal-danfe-runtime/test/processed-receipt-query-fixture.mjs';
import {processedSource,disposeProcessedSource} from '../../../../packages/fiscal-danfe-runtime/src/processed-source.mjs';
import {renderProcessedHtml} from '../../../../packages/fiscal-danfe/src/processed-render.mjs';
import {FLAGS,downloadFilename,publicProcessedResult} from '../../../../packages/fiscal-danfe-runtime/src/processed-dto.mjs';
import {receiptQueryProcessedReference} from '../../src/lib/fiscal-receipt-query-processed-model.ts';
import {receiptQueryFixture} from './fiscal-receipt-query-fixtures.mjs';
export async function receiptQueryProcessedUiFixtures(){
 const f=await processedReceiptQueryFixtures();return{close:()=>f.close(),async create(model='55',kind='authorization',status='100'){
  const x=await f.create(model,kind,status),h=await x.read(),owned=processedSource(h),source=owned.metadata;
  try{const p=renderProcessedHtml(h),binding={sourceKind:'receipt_query',commandId:x.input.commandId};
   const xml=await publicProcessedResult({...FLAGS,action:'xml',source,xml_base64:Buffer.from(owned.processedBytes).toString('base64'),filename:downloadFilename(source)},{...binding,action:'xml'});
   const print=await publicProcessedResult({...FLAGS,action:'print',source,html:p.html,html_sha256:p.sha256,html_size_bytes:Buffer.byteLength(p.html),page_count:p.page_count,profile:p.profile},{...binding,action:'print'});
   const result=structuredClone(x.result);result.read_only=true;result.replayed=true;
   const s=receiptQueryFixture({model,kind,initial:[result],ready:false});s.actor=x.input.actor;s.source=result.source;const{source_binding_hash,...reference}=s.source;s.reference=reference;
   const files=[];s.controller.fiscalProcessedDocument=async(path,options)=>{files.push({path,options});return path.endsWith('/xml')?xml:print;};
   return{s,result,reference:receiptQueryProcessedReference(result),files,xml,print};
  }finally{owned.signedBytes.fill(0);owned.processedBytes.fill(0);disposeProcessedSource(h);}
 }};
}
