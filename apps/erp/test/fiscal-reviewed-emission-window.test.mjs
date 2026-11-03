import './helpers/synthetic-october-clock.mjs';
import test from 'node:test';import assert from 'node:assert/strict';
import {mountComponent,AccessError} from './helpers/component-recovery-harness.mjs';
import {setup,preflight,candidate} from './helpers/fiscal-reviewed-authorization-fixtures.mjs';
import {projectPreflightPublic} from '../../../packages/fiscal-authorization/src/preflight-dto.mjs';
import {reviewedAuthorizationRun} from '../src/lib/fiscal-reviewed-authorization-model.ts';
const send='Enviar para autorização de homologação',check='Conferir antes do envio',query='Consultar resultado do envio',id='e0800000-0000-4000-8000-000000000001';
const mount=s=>mountComponent('FiscalReviewedAuthorization.tsx',{controller:s.controller,candidate:s.candidate});
const accept=async v=>{const c=v.find(n=>n.type==='input'&&n.props.type==='checkbox');assert.equal(c.disabled,false);c.props.onChange({target:{checked:true}});await v.flush();};
test('preflight temporal projection rejects missing or forged deadline, calendar, status and margin',()=>{
 const c=candidate('65'),v=preflight(c,{enabled:true}),q={candidate_id:c.candidate_id,signed_hash:c.artifact.sha256};assert.deepEqual(projectPreflightPublic(v,q),v);
 for(const patch of [x=>delete x.emission_window,x=>x.emission_window=null,x=>x.emission_window.send_before=x.emission_window.expires_at,x=>x.emission_window.safety_margin_seconds=0,x=>x.emission_window.max_age_seconds=600,x=>x.emission_window.issued_at='2026-02-30T12:00:00.000Z',x=>x.emission_window.status='expired',x=>x.candidate.model='55']){const raw=structuredClone(v);patch(raw);assert.throws(()=>projectPreflightPublic(raw,q));}
 const p55=preflight(candidate('55'),{enabled:true});assert.equal(p55.emission_window,null);assert.doesNotThrow(()=>reviewedAuthorizationRun(p55,candidate('55'),true,id));
});
test('65 expired, future and short windows show explicit blockers and never submit',async()=>{
 for(const delta of [-301000,301000,-275000]){const s=setup({model:'65',before(c,s){if(c.kind==='preflight')return preflight(s.candidate,{enabled:true,issuedAt:new Date(Date.now()+delta).toISOString()});}}),v=await mount(s);try{await v.click(check);assert.equal(v.button(send).disabled,true);assert.match(v.text(),/data de emissão|prazo deste XML/i);assert.match(v.text(),/30 segundos/);assert.equal(v.nodes().some(n=>n.type==='input'&&n.props.type==='checkbox'),false);v.button(send).props.onClick();await v.flush();assert.equal(s.calls.some(c=>c.kind==='run'),false);}finally{v.unmount();}}
});
test('65 expiry is recalculated synchronously by an old click handler and cannot reuse accepted selection',async()=>{
 const original=Date.now;let now=original();Date.now=()=>now;const s=setup({model:'65',before(c,s){if(c.kind==='preflight')return preflight(s.candidate,{enabled:true,issuedAt:new Date(now-269000).toISOString()});}}),v=await mount(s);
 try{await v.click(check);await accept(v);const button=v.button(send);now+=1000;button.props.onClick();await v.flush();assert.equal(s.calls.some(c=>c.kind==='run'),false);assert.equal(v.button(send).disabled,true);assert.match(v.text(),/prazo deste XML.*terminando/i);assert.equal(v.find(n=>n.type==='input'&&n.props.type==='checkbox').props.checked,false);}finally{Date.now=original;v.unmount();}
});
test('65 timer clears consent at the send boundary without a second request',async t=>{
 const original=Date.now;let now=original();Date.now=()=>now;const callbacks=[],realTimer=globalThis.setTimeout,realClear=globalThis.clearTimeout;t.mock.method(globalThis,'setTimeout',(fn,ms,...args)=>{if(ms<100)return realTimer(fn,ms,...args);const token={unref(){}};callbacks.push({fn,ms,token});return token;});t.mock.method(globalThis,'clearTimeout',token=>{if(!callbacks.some(c=>c.token===token))realClear(token);});
 const s=setup({model:'65',before(c,s){if(c.kind==='preflight')return preflight(s.candidate,{enabled:true,issuedAt:new Date(now-260000).toISOString()});}}),v=await mount(s);
 try{await v.click(check);await accept(v);const timer=callbacks.find(c=>c.ms>9000&&c.ms<=10000);assert.ok(timer);now+=10000;timer.fn();await v.flush();assert.equal(v.button(send).disabled,true);assert.equal(v.find(n=>n.type==='input'&&n.props.type==='checkbox').props.checked,false);assert.deepEqual(s.calls.map(c=>c.kind),['preflight']);}finally{Date.now=original;v.unmount();}
});
test('65 pending ACK survives expiry and can only query its UUID; temporal409 does not fabricate another run',async()=>{
 for(const definitive of [false,true]){const original=Date.now;let now=original();Date.now=()=>now;const s=setup({model:'65',before(c,s){if(c.kind==='preflight')return preflight(s.candidate,{enabled:true,issuedAt:new Date(now-60000).toISOString()});if(c.kind==='run')throw Object.assign(new AccessError(definitive?409:503),{code:definitive?'AUTHORIZATION_NFCE_EMISSION_WINDOW_TOO_SHORT':'AUTHORIZATION_UPSTREAM_UNAVAILABLE',recovery_required:!definitive});}}),v=await mount(s);
  try{await v.click(check);await accept(v);await v.click(send);const body=s.calls.find(c=>c.kind==='run').body;now+=400000;if(definitive){assert.match(v.text(),/prazo deste XML/);assert.equal(v.button(check).disabled,false);}else{assert.equal(v.button(check).disabled,true);await v.click(query);assert.ok(s.calls.find(c=>c.kind==='command').path.endsWith(body.command_id));}assert.equal(s.calls.filter(c=>c.kind==='run').length,1);}finally{Date.now=original;v.unmount();}
 }
});
test('65 backend observation and monotonic elapsed time prevent a slow or rolled-back local clock from extending validity',async t=>{
 const original=Date.now,server=original(),c=candidate('65'),observed=preflight(c,{enabled:true,issuedAt:new Date(server-60000).toISOString()});let monotonic=100;Date.now=()=>server-3600000;t.mock.method(performance,'now',()=>monotonic);
 const s=setup({model:'65',before(call){if(call.kind==='preflight')return observed;}}),v=await mount(s);
 try{await v.click(check);await accept(v);const stale=v.button(send);assert.equal(stale.disabled,false);monotonic+=210001;stale.props.onClick();await v.flush();assert.equal(s.calls.filter(c=>c.kind==='run').length,0);assert.equal(v.button(send).disabled,true);assert.match(v.text(),/prazo deste XML/);}finally{Date.now=original;v.unmount();}
});
