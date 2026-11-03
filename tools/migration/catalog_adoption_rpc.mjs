/** Closed RPC port for a single already-pinned adoption batch. No defaults, environment or logs. */
export function createCatalogAdoptionRpc({fetchImpl,projectUrl,secret,plan,mode,now=Date.now}){
 const need=(v,c)=>{if(!v)throw new Error(c);};
 need(typeof fetchImpl==='function'&&/^https:\/\/[a-z0-9]{20}\.supabase\.co$/.test(projectUrl)&&typeof secret==='string'&&secret.length>20&&['prepare','apply-reviewed','recover-readonly'].includes(mode),'CATALOG_RPC_CONFIGURATION');
 const p=structuredClone(plan),b=p.batches?.[0];need(p.batches?.length===1&&['contacts','products'].includes(b?.entity),'CATALOG_RPC_CONFIGURATION');
 const actor=p.actor,items=JSON.stringify(b.items),proposals=new Set(b.evidence.map(e=>e.proposal_id)),start=now();let key=secret,calls=0,applies=0;
 const same=(a,c)=>JSON.stringify(a)===JSON.stringify(c);
 return{
  stats:()=>({calls,applies}),dispose(){key=null;},
  async rpc(name,input,options={}){
   const args=structuredClone(input),signal=options.signal,deadline=Math.min(options.deadline??start+600000,start+600000,now()+20000);
   need(key!==null&&++calls<=110&&now()<deadline,'CATALOG_RPC_DEADLINE');
   if(name==='erp_origin_proposal_import_preview_v2')need(mode!=='recover-readonly'&&Object.keys(args).length===1&&proposals.has(args.p_source_id),'CATALOG_RPC_SCOPE');
   else if(name==='erp_catalog_import_preview')need(Object.keys(args).length===2&&args.p_entity===b.entity&&JSON.stringify(args.p_items)===items,'CATALOG_RPC_SCOPE');
   else if(name==='erp_catalog_import_apply'){
    need(mode==='apply-reviewed'&&applies===0&&same(args,{p_user_id:actor,p_entity:b.entity,p_items:b.items,p_command_id:b.command_id,p_preview_hash:b.preview_hash}),'CATALOG_RPC_SCOPE');
    applies++;
   }else throw new Error('CATALOG_RPC_SCOPE');
   const url=projectUrl+'/rest/v1/rpc/'+name,abort=new AbortController();let rejectStop,reader,response;
   const stopped=new Promise((_,reject)=>{rejectStop=reject;});stopped.catch(()=>{});
   const stop=()=>{abort.abort();rejectStop(new Error('CATALOG_RPC_UNCONFIRMED'));},timer=setTimeout(stop,Math.max(1,deadline-now()));
   signal?.addEventListener('abort',stop,{once:true});if(signal?.aborted)stop();
   const check=()=>need(!abort.signal.aborted&&now()<deadline,'CATALOG_RPC_UNCONFIRMED');
   try{
    response=await Promise.race([Promise.resolve().then(()=>{check();return fetchImpl(url,{method:'POST',redirect:'manual',headers:{apikey:key,Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify({...args,p_user_id:actor}),signal:abort.signal});}),stopped]);check();
    need(response?.ok&&!response.redirected&&response.url===url&&response.body&&/^application\/json(?:;|$)/i.test(response.headers.get('content-type')??'')&&Number(response.headers.get('content-length')??0)<=2097152,'CATALOG_RPC_UNAVAILABLE');
    reader=response.body.getReader();const decoder=new TextDecoder('utf8',{fatal:true});let bytes=0,text='';
    for(;;){const r=await Promise.race([reader.read(),stopped]);check();if(r.done)break;need(r.value instanceof Uint8Array&&r.value.byteLength>0,'CATALOG_RPC_RESPONSE_INVALID');bytes+=r.value.byteLength;need(bytes<=2097152,'CATALOG_RPC_RESPONSE_LIMIT');text+=decoder.decode(r.value,{stream:true});}
    const value=JSON.parse(text+decoder.decode());check();return value;
   }catch(e){throw new Error(['CATALOG_RPC_UNCONFIRMED','CATALOG_RPC_UNAVAILABLE','CATALOG_RPC_RESPONSE_LIMIT','CATALOG_RPC_RESPONSE_INVALID'].includes(e?.message)?e.message:'CATALOG_RPC_UNCONFIRMED');}
   finally{
    clearTimeout(timer);signal?.removeEventListener('abort',stop);abort.abort();
    // Cancellation cannot extend the operation's deadline, even for a faulty driver.
    try{const cancelled=reader?reader.cancel():response?.body?.cancel();Promise.resolve(cancelled).catch(()=>{});}catch{}
    try{reader?.releaseLock();}catch{}
   }
  }
 };
}
