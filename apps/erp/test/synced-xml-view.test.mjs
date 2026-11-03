import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mountComponent,AccessError} from './helpers/component-recovery-harness.mjs';
const id=number=>`10000000-0000-4000-8000-${String(number).padStart(12,'0')}`;
const bytes=new TextEncoder().encode('<synthetic>FICTICIO SEM DADOS REAIS</synthetic>'),hash=createHash('sha256').update(bytes).digest('hex');
const row=number=>({id:id(number),source_id:String(10000+number),entity:'nfe',key:'3'.repeat(20)+'55'+'0'.repeat(22),model:'55',environment:'1',kind:'invoice',revision:1,source_status:'6',collected_at:'2026-10-16T12:00:00Z',xml_hash:hash,size_bytes:bytes.length,
 protocol:'123456789012345',protocol_present:true,signature_present:true,event_type:null,event_sequence:null,issues:[],validation:'structural_only',signature_verified:false,xsd_validated:false,authorization_verified:false});
const page=(items,hasMore=false)=>({items,limit:25,has_more:hasMore,next_cursor:hasMore?items.at(-1).id:null,data_mode:'fiscal_archive_readonly'});
const pending=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{resolve,promise};};
const mount=controller=>mountComponent('SyncedXmlHistory.tsx',{controller},{expandChildren:['NativeListLayout']});
test('read-only list applies filters explicitly, pages by UUID and never calls the backup or fiscal draft API',async()=>{
 const calls=[],controller={async syncedXml(path,options){calls.push({path,...options});return new URL(path,'https://synthetic.invalid').searchParams.has('after')?page([row(26)]):page(Array.from({length:25},(_,i)=>row(i+1)),true);},async syncedXmlDownload(){assert.fail('no implicit download');}};
 const view=await mount(controller);
 try{
  assert.match(view.text(),/XMLs sincronizados/);assert.match(view.text(),/Situação na coleta do Origin: 6/);assert.match(view.text(),/25 arquivo/);
  await view.click('Próxima');assert.ok(calls.at(-1).path.includes(`after=${id(25)}`));assert.match(view.text(),/página 2/);
  await view.click('Anterior');assert.ok(!calls.at(-1).path.includes('after='));
  const before=calls.length;await view.change('synced-xml-query','333');assert.equal(calls.length,before);
  await view.change('synced-xml-history',true);await view.submit();assert.match(calls.at(-1).path,/q=333/);assert.match(calls.at(-1).path,/include_history=true/);assert.match(view.text(),/revisões antigas preservadas/);
  assert.ok(calls.every(call=>call.path.startsWith('/v1/xmls-sincronizados?')));assert.match(view.text(),/assinatura, XSD e autorização na SEFAZ não foram validados/i);
 }finally{view.unmount();}
});
test('an older list response is ignored after a new filter and the failed current list can be retried',async()=>{
 const old=pending();let reads=0;const calls=[];const controller={async syncedXml(path,options){calls.push({path,...options});reads++;if(reads===1)return old.promise;if(reads===2)throw new AccessError(503);return page([]);}};
 const view=await mount(controller);
 try{
  await view.change('synced-xml-query','not-found');await view.submit();assert.equal(calls[0].signal.aborted,true);
  old.resolve(page([row(1)]));await view.flush();assert.doesNotMatch(view.text(),/10001|Situação na coleta do Origin/);assert.match(view.text(),/Não foi possível conferir os XMLs/);
  await view.click('Tentar novamente');assert.equal(reads,3);assert.match(view.text(),/Nenhum XML encontrado/);
 }finally{view.unmount();}
});
test('UI creates no download before matching byte count and hash, then uses a safe attachment filename',async()=>{
 const originalDocument=globalThis.document,originalCreate=URL.createObjectURL,originalRevoke=URL.revokeObjectURL;let objectUrls=0,clicks=0,filename='';
 URL.createObjectURL=()=>{objectUrls++;return'blob:synthetic';};URL.revokeObjectURL=()=>{};
 globalThis.document={createElement:()=>({href:'',set download(value){filename=value;},click(){clicks++;},remove(){}}),body:{appendChild(){}}};
 let valid=false;const controller={async syncedXml(){return page([row(1)]);},async syncedXmlDownload(){return new Blob([valid?bytes:new Uint8Array(bytes.length)]);}};
 const view=await mount(controller);
 try{
  await view.click('Baixar XML');assert.equal(objectUrls,0);assert.equal(clicks,0);assert.match(view.text(),/Não foi possível conferir e baixar/);
  valid=true;await view.click('Baixar XML');assert.equal(objectUrls,1);assert.equal(clicks,1);assert.equal(filename,`origin-55-${hash.slice(0,12)}.xml`);
 }finally{view.unmount();globalThis.document=originalDocument;URL.createObjectURL=originalCreate;URL.revokeObjectURL=originalRevoke;}
});
test('leaving during a download aborts it and a late Blob never creates a browser download',async()=>{
 const late=pending();let signal;const controller={async syncedXml(){return page([row(1)]);},async syncedXmlDownload(path,value){signal=value;return late.promise;}};
 const view=await mount(controller);const originalCreate=URL.createObjectURL;let created=false;URL.createObjectURL=()=>{created=true;return'blob:forbidden';};
 try{await view.click('Baixar XML');view.unmount();assert.equal(signal.aborted,true);late.resolve(new Blob([bytes]));await new Promise(done=>setTimeout(done,10));assert.equal(created,false);}
 finally{URL.createObjectURL=originalCreate;}
});
