import test from 'node:test';import assert from 'node:assert/strict';
import {mountComponent,AccessError} from './helpers/component-recovery-harness.mjs';
import {authorizationQaCandidate,authorizationQaPreview,authorizationQaResult,authorizationQaHistory,AUTHORIZATION_QA_ACTOR} from '../src/qa/authorization-fixture.ts';
const clone=structuredClone,gate=()=>{let resolve;return{promise:new Promise(r=>resolve=r),resolve:v=>resolve(v)};};
function setup({model='55',before=()=>{}}={}){
 const s={candidate:authorizationQaCandidate(model),actor:AUTHORIZATION_QA_ACTOR,role:'fiscal',phase:'ready',calls:[],rows:null},listeners=new Set();
 s.rows=authorizationQaHistory(s.candidate);s.notify=()=>listeners.forEach(fn=>fn());s.controller={getSnapshot:()=>({phase:s.phase,membership:{user_id:s.actor,role:s.role}}),subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},async fiscalAuthorization(path,options={}){const kind=path.endsWith('/preview')?'preview':path.endsWith('/history')?'history':'command',call={kind,path,...options};s.calls.push(call);const value=await before(call,s);if(value!==undefined)return value;return clone(kind==='preview'?authorizationQaPreview(s.candidate):kind==='history'?s.rows:authorizationQaResult(s.candidate,true));},a1(){throw Error('A1_MUST_NOT_BE_USED');}};return s;
}
const mount=(s,props={})=>mountComponent('FiscalAuthorization.tsx',{controller:s.controller,candidate:s.candidate,...props});
test('064 mounts without requests or A1 and only previews on click, for models55/65',async()=>{
 for(const model of ['55','65']){const s=setup({model}),v=await mount(s);try{assert.equal(s.calls.length,0);assert.match(v.text(),/envio para autorização ainda está indisponível/);assert.equal(v.nodes().filter(n=>n.type==='input').length,0);assert.equal(v.nodes().filter(n=>n.type==='button').length,2);
 await v.click('Conferir preparação para autorização');assert.equal(s.calls.length,1);assert.equal(s.calls[0].kind,'preview');assert.deepEqual(s.calls[0].body,{candidate_id:s.candidate.candidate_id,signed_hash:s.candidate.artifact.sha256});assert.match(v.text(),/Nenhum pedido de autorização foi enviado/);assert.match(v.text(),/perfil de regras fiscais ainda não foi revisado/);
 }finally{v.unmount();}}
});
test('history remains useful with current A1 unavailable; only explicitly owned pending command gets a lookup action',async()=>{
 const s=setup(),v=await mount(s);try{await v.click('Consultar histórico de autorização');assert.match(v.text(),/Origem sintética de teste/);assert.match(v.text(),/Autorização declarada em resposta sintética/);assert.equal(v.nodes().filter(n=>n.type==='button'&&String(n.props.children).includes('Consultar comando')).length,1);
 await v.click('Consultar comando da tentativa 2');assert.equal(s.calls.at(-1).kind,'command');assert.match(v.text(),/Última consulta do comando/);assert.match(v.text(),/não repete nem recupera um envio/);assert.equal(s.calls.some(c=>/\/run$|\/recover$/.test(c.path)),false);
 }finally{v.unmount();}
});
test('503/404/403 and binding mismatch preserve historical capture without automatic retries or new command',async()=>{
 for(const status of [503,404,403,'binding']){let failed=true;const s=setup({before(c,s){if(c.kind==='command'&&failed){failed=false;if(status==='binding'){const value=authorizationQaResult(s.candidate,true);value.receipt.signed_hash='d'.repeat(64);return value;}throw new AccessError(status);}}}),v=await mount(s);try{await v.click('Consultar histórico de autorização');await v.click('Consultar comando da tentativa 2');assert.match(v.text(),/Resultado do envio ainda incerto/);assert.equal(s.calls.filter(c=>c.kind==='command').length,1);await v.click('Consultar comando da tentativa 2');assert.equal(s.calls.filter(c=>c.kind==='command').length,2);assert.equal(new Set(s.calls.filter(c=>c.kind==='command').map(c=>c.path)).size,1);assert.match(v.text(),/Última consulta do comando/);}finally{v.unmount();}}
});
test('in-flight reads publish busy synchronously and block stale handlers; parent blocked does not suppress completion cleanup',async()=>{
 const wait=gate(),entered=gate(),busy=[],s=setup({before(c){if(c.kind==='preview'){entered.resolve();return wait.promise;}}}),v=await mount(s,{onBusy:x=>busy.push(x)});try{const old=v.button('Consultar histórico de autorização');v.button('Conferir preparação para autorização').props.onClick();assert.equal(busy.at(-1),true);await entered.promise;old.props.onClick();await v.flush();assert.equal(s.calls.length,1);await v.updateProps({blocked:true});wait.resolve(authorizationQaPreview(s.candidate));await v.flush();assert.equal(busy.at(-1),false);assert.match(v.text(),/conferência local/);}finally{v.unmount();}
});
test('logout, actor change, role loss, candidate change and unmount discard late reads and stale callbacks',async()=>{
 for(const change of ['logout','actor','role','candidate','unmount']){const wait=gate(),entered=gate(),s=setup({before(c){if(c.kind==='preview'){entered.resolve();return wait.promise;}}}),v=await mount(s);try{const old=v.button('Consultar histórico de autorização');v.button('Conferir preparação para autorização').props.onClick();await entered.promise;
 if(change==='unmount')v.unmount();else if(change==='candidate'){await v.updateProps({candidate:authorizationQaCandidate('65')});}else{s[change==='role'?'role':change==='actor'?'actor':'phase']=change==='role'?'consulta':change==='actor'?'e0000000-0000-4000-8000-000000000009':'signed_out';s.notify();await v.flush();}
 wait.resolve(authorizationQaPreview(s.candidate));if(change==='unmount')await new Promise(r=>setImmediate(r));else await v.flush();assert.equal(s.calls[0].signal.aborted,true);if(change!=='unmount'){old.props.onClick();await v.flush();assert.equal(s.calls.length,1);assert.equal(v.text().includes('Conferência local concluída'),false);}
 }finally{v.unmount();}}
});
test('same actor session notifications keep in-flight read and do not schedule replay',async()=>{
 const wait=gate(),entered=gate(),s=setup({before(c){if(c.kind==='preview'){entered.resolve();return wait.promise;}}}),v=await mount(s);try{v.button('Conferir preparação para autorização').props.onClick();await entered.promise;s.notify();await v.flush();assert.equal(s.calls[0].signal.aborted,false);wait.resolve(authorizationQaPreview(s.candidate));await v.flush();assert.match(v.text(),/Conferência local concluída/);assert.equal(s.calls.length,1);}finally{v.unmount();}
});
