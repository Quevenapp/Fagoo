import test from 'node:test';import assert from 'node:assert/strict';
import {createAccessController,AccessError} from '../src/lib/real-access.ts';
const uid='a0000000-0000-4000-8000-000000000001',command='b0000000-0000-4000-8000-000000000002',session={access_token:'synthetic-token',user:{id:uid}},me={user_id:uid,role:'admin',resources:[],data_mode:'staging_readonly'};
const auth={getSession:async()=>({data:{session},error:null}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}}),signOut:async()=>({error:null})};
const tick=()=>new Promise(resolve=>setTimeout(resolve,0)),isStatus=status=>e=>e instanceof AccessError&&e.status===status;

test('home client sends period reads and shortcut saves only in the allow-listed shapes',async()=>{
 const calls=[];const controller=createAccessController(auth,'https://api.example.test',async(url,options)=>{if(url.endsWith('/me'))return Response.json(me);calls.push({url,options});return Response.json({ok:true});});const stop=controller.start();await tick();
 try{
  await controller.home('/v1/inicio?periodo=30d');await controller.home('/v1/inicio?periodo=customizado&de=2026-01-01&ate=2026-12-31');await controller.home('/v1/inicio/atalhos');
  await controller.home('/v1/inicio/atalhos',{method:'POST',body:{command_id:command,expected_version:2,shortcuts:['/estoque-empresa']}});
  assert.deepEqual(calls.map(call=>[call.url.replace('https://api.example.test',''),call.options.method]),[['/v1/inicio?periodo=30d','GET'],['/v1/inicio?periodo=customizado&de=2026-01-01&ate=2026-12-31','GET'],['/v1/inicio/atalhos','GET'],['/v1/inicio/atalhos','POST']]);
  assert.deepEqual(JSON.parse(calls[3].options.body),{command_id:command,expected_version:2,shortcuts:['/estoque-empresa']});assert.equal(calls[3].options.headers['Content-Type'],'application/json');
  for(const [path,options] of [['/v1/inicio?periodo=1d',{}],['/v1/inicio?periodo=7D',{}],['/v1/inicio?periodo=customizado&de=2026-01-01&ate=2027-01-02',{}],['/v1/inicio/atalhos',{method:'POST',body:{command_id:command,expected_version:2,shortcuts:['/importar-cadastros']}}],
   ['/v1/inicio/atalhos',{method:'POST',body:{command_id:command,expected_version:2,shortcuts:[],actor:uid}}],['/v1/inicio/atalhos',{method:'PATCH',body:{command_id:command,expected_version:2,shortcuts:[]}}],['/v1/inicio/atalhos/../inicio',{}]])
   await assert.rejects(()=>controller.home(path,options),isStatus(400));
  assert.equal(calls.length,4);
 }finally{stop();}
});
test('a shortcut save in flight is aborted by logout and its late response is discarded',async()=>{
 let finish,signal;const controller=createAccessController(auth,'https://api.example.test',async(url,options)=>{if(url.endsWith('/me'))return Response.json(me);signal=options.signal;return new Promise(resolve=>{finish=resolve;});});const stop=controller.start();await tick();
 try{const pending=controller.home('/v1/inicio/atalhos',{method:'POST',body:{command_id:command,expected_version:0,shortcuts:[]}});await tick();await controller.logout();assert.equal(signal.aborted,true);finish(Response.json({late:true}));await assert.rejects(pending,e=>e.name==='AbortError');}
 finally{stop();}
});
