import test from'node:test';import assert from'node:assert/strict';
import{createAccessController,AccessError}from'../src/lib/real-access.ts';
const uid='a0000000-0000-4000-8000-000000000115',command='b0000000-0000-4000-8000-000000000115',session={access_token:'synthetic-token',user:{id:uid}},me={user_id:uid,role:'admin',resources:[],data_mode:'staging_readonly'};
const auth={getSession:async()=>({data:{session},error:null}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}}),signOut:async()=>({error:null})};
const tick=()=>new Promise(resolve=>setTimeout(resolve,0)),isStatus=status=>e=>e instanceof AccessError&&e.status===status;

test('115 client sends only known pages, exact save bodies and command reads',async()=>{
 const calls=[];const controller=createAccessController(auth,'https://api.example.test',async(url,options)=>{if(url.endsWith('/me'))return Response.json(me);calls.push({url,options});return Response.json({ok:true});});const stop=controller.start();await tick();
 try{
  const body={command_id:command,changes:[{key:'empresa.decimais_quantidade',expected_version:0,value:4}]};
  await controller.preferences('/v1/preferencias/empresa-geral');await controller.preferences('/v1/preferencias/empresa-geral',{method:'POST',body});await controller.preferences(`/v1/preferencias/comandos/${command}`);
  assert.deepEqual(calls.map(c=>[c.url.replace('https://api.example.test',''),c.options.method]),[['/v1/preferencias/empresa-geral','GET'],['/v1/preferencias/empresa-geral','POST'],[`/v1/preferencias/comandos/${command}`,'GET']]);
  assert.deepEqual(JSON.parse(calls[1].options.body),body);
  for(const[path,options]of[['/v1/preferencias/certificado-digital',{}],['/v1/preferencias/inexistente',{}],['/v1/preferencias/empresa-geral?x=1',{}],['/v1/preferencias',{}],['/v1/preferencias/comandos/x',{}],
   ['/v1/preferencias/empresa-geral',{method:'POST',body:{...body,actor:uid}}],['/v1/preferencias/empresa-geral',{method:'POST',body:{command_id:command,changes:[{key:'vendas.gerar_nfe',expected_version:0,value:true}]}}],
   ['/v1/preferencias/empresa-geral',{method:'PATCH',body}],[`/v1/preferencias/comandos/${command}`,{method:'POST',body}],['/v1/preferencias/../empresa',{}]])
   await assert.rejects(()=>controller.preferences(path,options),isStatus(400),path);
  assert.equal(calls.length,3);
 }finally{stop();}
});
test('115 the save body is captured before an awaited credential check and a late answer after logout is discarded',async()=>{
 let finish,signal,sent;const controller=createAccessController(auth,'https://api.example.test',async(url,options)=>{if(url.endsWith('/me'))return Response.json(me);signal=options.signal;sent=JSON.parse(options.body);return new Promise(resolve=>{finish=resolve;});});const stop=controller.start();await tick();
 try{const body={command_id:command,changes:[{key:'sistema.tema_escuro',expected_version:0,value:true}]};const pending=controller.preferences('/v1/preferencias/sistema-interface',{method:'POST',body});
  body.changes[0].value=false;await tick();assert.equal(sent.changes[0].value,true);await controller.logout();assert.equal(signal.aborted,true);finish(Response.json({late:true}));await assert.rejects(pending,e=>e.name==='AbortError');}
 finally{stop();}
});
