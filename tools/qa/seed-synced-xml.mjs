/** Embedded QA only. Synthetic fiscal-shaped XML; no network or production credentials. */
import {createHash} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {buildAccessKey} from '../../packages/fiscal-core/src/identity.mjs';
import {inspectArchivedXml} from '../../packages/fiscal-xml/src/archive.mjs';
import {invoice,event,identity,keyFor} from '../../workers/origin-sync/test/xml-fixtures.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const uuid=(group,index)=>`d2700000-0000-4000-${group}-${String(index).padStart(12,'0')}`;
function syntheticXml(model,number,kind='invoice',suffix='',missingSignature=false){
  const key=buildAccessKey({...identity(model),environment:'2',number:String(number)});
  let xml=(kind==='invoice'?invoice(model,` QA FICTICIA ${number}${suffix}`):event(model))
    .replaceAll(keyFor(model),key).replaceAll('<tpAmb>1</tpAmb>','<tpAmb>2</tpAmb>');
  if(kind==='invoice')xml=xml.replace('<nNF>1</nNF>',`<nNF>${number}</nNF>`).replace(/<cDV>\d<\/cDV>/,`<cDV>${key[43]}</cDV>`);
  if(missingSignature)xml=xml.replace(/<Signature xmlns="http:\/\/www\.w3\.org\/2000\/09\/xmldsig#"\/>/,'');
  return{key,bytes:new TextEncoder().encode(xml)};
}

/** Call after migration027 and after constructing the harness Storage Map.
 * The map shape is path -> {bytes:Uint8Array,mime:string}; it is populated only
 * after the SQL transaction commits. A second call is refused without changes.
 */
export async function seedSyncedXml(db,storageObjects){
  if(!(db instanceof PGlite)||!(storageObjects instanceof Map))throw new TypeError('Synthetic seed requires embedded PGlite and a local Storage Map');
  const staged=new Map();let itemIndex=0,revisionCount=0;
  await db.exec('begin');
  try{
    if((await db.query('select exists(select 1 from origin_fiscal.source where id=$1) present',[uuid('8000',1)])).rows[0].present)throw new Error('Synthetic XML seed already exists');
    for(let number=1;number<=26;number++){
      const model=number%2?'55':'65',entity=model==='55'?'nfe':'nfce',source=uuid('8000',number),sourceKey=syntheticXml(model,number).key;
      await db.query("insert into origin_fiscal.source(id,entity,source_id,access_key,state)values($1,$2,$3,$4,'stored')",[source,entity,String(9700000000+number),sourceKey]);
      const revisions=number===1?[1,2]:[1];
      for(const revisionNumber of revisions){
        const revision=uuid('8100',++revisionCount),historical=number===1&&revisionNumber===1;
        const documents=[syntheticXml(model,number,'invoice',historical?' REVISAO ANTERIOR':' REVISAO ATUAL',number===3)];
        if(number===1&&revisionNumber===2)documents.push(syntheticXml(model,number,'event'));
        const manifest=hash(documents.map(doc=>hash(doc.bytes)).sort().join(':'));
        await db.query('insert into origin_fiscal.revision(id,source,revision,manifest_hash,source_status,collected_at)values($1,$2,$3,$4,$5,$6::timestamptz)',
          [revision,source,revisionNumber,manifest,number===1&&revisionNumber===2?'2':'5',historical?'2026-10-15T12:00:00Z':'2026-10-16T12:00:00Z']);
        for(const document of documents){
          const sha=hash(document.bytes),metadata=inspectArchivedXml(document.bytes,{key:sourceKey,entity}),objectKey=`objects/${sha}.xml`;
          await db.query('insert into origin_fiscal.object(hash,size,metadata)values($1,$2,$3::jsonb)',[sha,document.bytes.length,JSON.stringify(metadata)]);
          await db.query('insert into origin_fiscal.item(id,revision,object_hash)values($1,$2,$3)',[uuid('8200',++itemIndex),revision,sha]);
          await db.query("insert into storage.objects(bucket_id,name,metadata)values('origin-fiscal-xml',$1,$2::jsonb)",[objectKey,JSON.stringify({size:document.bytes.length,mimetype:'application/xml'})]);
          const path=`/storage/v1/object/authenticated/origin-fiscal-xml/${objectKey}`;
          if(storageObjects.has(path))throw new Error('Synthetic Storage fixture already exists');
          staged.set(path,{bytes:document.bytes,mime:'application/xml'});
        }
        if(!historical)await db.query('update origin_fiscal.source set current_revision=$1,next_revision=$2,last_success_at=$3::timestamptz where id=$4',[revision,revisionNumber+1,'2026-10-16T12:00:00Z',source]);
      }
    }
    await db.exec('commit');
  }catch(error){await db.exec('rollback');throw error;}
  for(const [path,value]of staged)storageObjects.set(path,value);
  return{synthetic:true,sources:26,current_items:27,all_items:itemIndex,revisions:revisionCount,objects:staged.size,models:['55','65']};
}
