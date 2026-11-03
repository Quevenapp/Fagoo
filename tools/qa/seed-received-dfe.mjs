/** In-memory QA only. Synthetic parser→SQL fixtures; no SEFAZ or external HTTP. */
import {randomUUID,createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {buildAccessKey} from '../../packages/fiscal-core/src/identity.mjs';
import {parseDistributionResponse} from '../../packages/fiscal-xml/src/distribution.mjs';
import {dfePage,dfeSettings} from '../../apps/erp/src/lib/received-dfe-model.ts';
import {parseDfeDistributionRoute,executeDfeDistributionRoute} from '../../workers/erp-api/src/dfe-distribution.mjs';

export async function seedReceivedDfe({db,uid,objects}){
 const scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0].value;
 const rpc=async(name,args)=>{const pairs=Object.entries(args);return scalar(`select public.${name}(${pairs.map(([key],i)=>`${key}=>$${i+1}`).join(',')})value`,pairs.map(([,v])=>v&&typeof v==='object'?JSON.stringify(v):v));};
 const identity=(await scalar("select public.erp_company_get($1,'identity')value",[uid])).record;
 if(!identity)throw new Error('QA_DFE_IDENTITY_REQUIRED');
 const bucket='brufap-received-dfe',NS='http://www.portalfiscal.inf.br/nfe';
 await db.query('insert into storage.buckets values($1,$1,false,8388608,$2::text[])',[bucket,['application/octet-stream']]);
 const current=async(environment)=>(await rpc('erp_dfe_settings',{p_user_id:uid,p_environment:environment})).current;
 const configure=async(environment,patch={})=>rpc('erp_dfe_configure',{p_user_id:uid,p_command_id:randomUUID(),p_environment:environment,p_expected_version:(await current(environment))?.version??0,p_expected_identity_version:identity.version,p_coordinator:'external',p_checkpoint:null,p_checkpoint_confirmed:false,p_other_consumers_reviewed:false,p_collection_requested:false,p_reason:'Coordenação inteiramente fictícia para QA local; nenhum serviço consultado',...patch});
 // Production-like scenario: another consumer, unknown cursor and no completed coordination.
 await configure('1');
 // Historical synthetic batch in homologation only. Runtime RPCs are not public HTTP routes.
 const configured=await configure('2',{p_coordinator:'brufap',p_checkpoint:'000000000000000',p_checkpoint_confirmed:true,p_other_consumers_reviewed:true,p_collection_requested:true});
 const reserved=await rpc('erp_dfe_reserve',{p_user_id:uid,p_command_id:randomUUID(),p_channel_id:configured.current.id,p_expected_version:configured.current.version});
 const lease={p_user_id:uid,p_attempt_id:reserved.attempt_id,p_lease_id:reserved.lease_id};
 await rpc('erp_dfe_dispatch',lease);
 const key=buildAccessKey({cUF:'35',cnpj:'12345678000195',model:'55',environment:'2',series:'1',number:'1',issuedAt:'2026-10-16T10:00:00-03:00',cNF:'12345678',tpEmis:'1'});
 const samples=[
  ['resNFe_v1.01.xsd',`<resNFe xmlns="${NS}" versao="1.01"><chNFe>${key}</chNFe></resNFe>`],
  ['procNFe_v4.00.xsd',`<nfeProc xmlns="${NS}" versao="4.00"><NFe><infNFe Id="NFe${key}" versao="4.00"><ide><tpAmb>2</tpAmb></ide><dest><CNPJ>${identity.data.cnpj}</CNPJ></dest></infNFe></NFe><protNFe><infProt><tpAmb>2</tpAmb><chNFe>${key}</chNFe></infProt></protNFe></nfeProc>`],
  ['resEvento_v1.01.xsd',`<resEvento xmlns="${NS}" versao="1.01"><chNFe>${key}</chNFe></resEvento>`],
  ['procEventoNFe_v1.00.xsd',`<procEventoNFe xmlns="${NS}" versao="1.00"><evento><infEvento><tpAmb>2</tpAmb><chNFe>${key}</chNFe></infEvento></evento><retEvento><infEvento><tpAmb>2</tpAmb><chNFe>${key}</chNFe></infEvento></retEvento></procEventoNFe>`],
  ['future_v9.00.xsd','<synthetic xmlns="urn:brufap:qa">UNRECOGNIZED FICTITIOUS SAMPLE</synthetic>'],
 ];
 const items=Array.from({length:28},(_,i)=>{const [schema,xml]=samples[i<5?i:0];return `<docZip NSU="${String(i+1).padStart(15,'0')}" schema="${schema}">${gzipSync(xml).toString('base64')}</docZip>`;});
 const bytes=Buffer.from(`<retDistDFeInt xmlns="${NS}" versao="1.01"><tpAmb>2</tpAmb><verAplic>QA</verAplic><cStat>138</cStat><xMotivo>FICTICIO SEM CONSULTA</xMotivo><dhResp>2026-10-16T10:01:00-03:00</dhResp><ultNSU>000000000000028</ultNSU><maxNSU>000000000000028</maxNSU><loteDistDFeInt>${items.join('')}</loteDistDFeInt></retDistDFeInt>`);
 const parsed=await parseDistributionResponse(bytes,{request:reserved.request});
 const store=async(raw)=>{const digest=createHash('sha256').update(raw).digest('hex'),name=`objects/${digest}.xml`;await db.query('insert into storage.objects(bucket_id,name,metadata)values($1,$2,$3::jsonb)on conflict do nothing',[bucket,name,JSON.stringify({size:raw.length,mimetype:'application/octet-stream'})]);objects.set(`/storage/v1/object/authenticated/${bucket}/${name}`,{bytes:raw,mime:'application/octet-stream'});};
 await store(bytes);for(const doc of parsed.documents)await store(Buffer.from(doc.xml));
 await rpc('erp_dfe_finalize',{...lease,p_manifest:{request_hash:parsed.requestHash,response_hash:parsed.responseHash,response_size:bytes.length,status:parsed.status,last_nsu:parsed.lastNsu,max_nsu:parsed.maxNsu,documents:parsed.documents.map(d=>({nsu:d.nsu,schema:d.schema,kind:d.kind,access_key:d.accessKey,recipient_match:d.recipientMatch,quarantined:d.quarantined,hash:d.sha256,size:d.sizeBytes,compressed_hash:d.compressedSha256})),issues:parsed.issues}});
 await configure('2',{p_checkpoint:'000000000000028'});
 const request=async(path)=>executeDfeDistributionRoute(await parseDfeDistributionRoute(new Request('https://synthetic.invalid/v1/notas-recebidas'+path)),{userId:uid,rpc});
 for(const environment of ['1','2']){const c=dfeSettings((await request(`/settings?environment=${environment}`)).body,environment);if(c.collection_requested||c.other_consumers_reviewed||c.checkpoint_confirmed||c.has_active_attempt)throw new Error('QA_DFE_COLLECTION_NOT_DISABLED');if(environment==='1'&&c.checkpoint!==null)throw new Error('QA_DFE_CURSOR_INFERRED');}
 const channel=(await current('2')).id,page=dfePage((await request(`/documents?channel_id=${channel}`)).body,channel),next=dfePage((await request(`/documents?channel_id=${channel}&after=${page.next_cursor}`)).body,channel,'',page.next_cursor);
 if(page.items.length!==25||next.items.length!==3||new Set([...page.items,...next.items].map(d=>d.kind)).size!==5)throw new Error('QA_DFE_PAGINATION_OR_KIND_INVALID');
 return{channel,documents:28};
}
