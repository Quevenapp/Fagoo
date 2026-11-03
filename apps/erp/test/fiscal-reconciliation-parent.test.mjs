import test from 'node:test';
import assert from 'node:assert/strict';
import {mountComponent,AccessError} from './helpers/component-recovery-harness.mjs';
import {signedFixture} from './helpers/fiscal-signed-ui-fixture.mjs';
import {company} from './helpers/a1-fixtures.mjs';
import {FLAGS} from '../../../packages/fiscal-reconciliation-runtime/src/dto.mjs';
import {payload,result} from '../../../packages/fiscal-reconciliation-runtime/test/fixtures.mjs';
const gate=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
const clone=structuredClone;
function fixture(){
 const s=signedFixture({state:'stored'}),c=s.candidate,p={...payload(),candidate_id:c.candidate_id,signed_hash:c.artifact.sha256},r=result('dispatched',p,true);
 Object.assign(r.receipt,{candidate_version:c.candidate_version,unsigned_job_id:c.unsigned_job_id,model:c.model,signed_hash:c.artifact.sha256,signed_size:c.artifact.size_bytes,basis_hash:c.basis_hash,completion_version:c.completion_version,completion_hash:c.completion_hash,signing_a1_version:c.a1_version});r.current.candidate.latest_candidate_id=c.candidate_id;
 s.protocolCalls=[];s.row=r;s.controller.subscribe=()=>()=>{};s.controller.company=async()=>clone(company);s.controller.fiscalReconciliation=async(path,o={})=>{
  const call={path,body:clone(o.body),signal:o.signal};s.protocolCalls.push(call);await s.before?.(call);
  if(path.endsWith('/history'))return {...FLAGS,read_only:true,candidate_id:c.candidate_id,items:[clone(s.row)],limit:25,has_more:false,next_cursor:null};
  if(path.endsWith('/recover')){const stored=result('stored',p,false);stored.receipt=clone(s.row.receipt);stored.current.candidate.latest_candidate_id=c.candidate_id;s.row=stored;await s.afterRecover?.();return clone(stored);}
  if(path.includes('/commands/')){if(s.failGet){s.failGet=false;throw new AccessError(503);}return {...clone(s.row),read_only:true,recovered:false};}
  throw new Error('Unexpected mutation');
 };return s;
}
const mount=(s,options={},props={})=>mountComponent('FiscalSignedCandidate.tsx',{controller:s.controller,job:s.f.job,model:'55',...props},{expandChildren:['FiscalReconciliation'],...options});
const parentLabels=['Atualizar certificado e assinaturas','Consultar andamento da assinatura','Atualizar histórico de assinaturas'];
test('real signed parent and 062 child aggregate loading and recovery without enaorigin run or blocking child cleanup',async()=>{
 const s=fixture(),busy=[],dirty=[],v=await mount(s,{}, {onBusy:x=>busy.push(x),onDraft:x=>dirty.push(x)});try{
  assert.equal(busy.includes(true),true);assert.equal(busy.at(-1),false);assert.match(v.text(),/Novas consultas estão indisponíveis/);assert.equal(v.button('Consultar situação desta chave em homologação').disabled,true);
  const old=parentLabels.map(x=>v.button(x));await v.click('Consultar tentativa 1');const wait=gate(),entered=gate();s.afterRecover=()=>{entered.resolve();return wait.promise;};s.failGet=true;
  v.button('Recuperar resposta já guardada').props.onClick();await entered.promise;await v.flush();assert.equal(busy.at(-1),true);for(const label of parentLabels)assert.equal(v.button(label).disabled,true,label);
  const calls=s.calls.length;for(const b of old)b.props.onClick();await v.flush();assert.equal(s.calls.length,calls);wait.resolve();await v.flush();assert.equal(busy.at(-1),true);assert.equal(v.button('Conferir mesma tentativa').disabled,false);
  await v.click('Conferir mesma tentativa');assert.equal(busy.at(-1),false);assert.equal(dirty.at(-1),false);for(const label of parentLabels)assert.equal(v.button(label).disabled,false,label);assert.equal(s.protocolCalls.filter(c=>c.path.endsWith('/recover')).length,1);assert.equal(s.protocolCalls.filter(c=>c.path.endsWith('/run')).length,0);assert.equal(s.counts.run,undefined);
 }finally{v.unmount();assert.equal(busy.at(-1),false);assert.equal(dirty.at(-1),false);}
});
test('parent synchronous child-dirty callbacks fence stale signing/reload/history handlers and keep its child unblocked by itself',async()=>{
 const s=fixture(),events=[],child=[];
 const modules={'./FiscalReconciliation':`export default function FiscalReconciliation(props){r.child.push(props);return r.jsx('section',{children:[r.jsx('button',{children:'Marcar confirmação do filho',onClick:()=>props.onDraft(true)}),r.jsx('button',{children:'Limpar confirmação do filho',onClick:()=>props.onDraft(false)})]});}`};
 const v=await mount(s,{modules,ports:{child}}, {onDraft:x=>events.push(x)});try{
  const old=parentLabels.map(x=>v.button(x));await v.click('Marcar confirmação do filho');assert.equal(events.at(-1),true);for(const label of parentLabels)assert.equal(v.button(label).disabled,true,label);
  assert.equal(child.at(-1).blocked,false);const count=s.calls.length;for(const b of old)b.props.onClick();await v.flush();assert.equal(s.calls.length,count);await v.click('Limpar confirmação do filho');assert.equal(events.at(-1),false);for(const label of parentLabels)assert.equal(v.button(label).disabled,false,label);
 }finally{v.unmount();}
});
