import test from 'node:test';import assert from 'node:assert/strict';
import {mountComponent,AccessError} from './helpers/component-recovery-harness.mjs';
import {signedFixture} from './helpers/fiscal-signed-ui-fixture.mjs';
import {UNSIGNED_FLAGS} from '../src/lib/fiscal-unsigned-model.ts';
import {history} from './helpers/fiscal-reviewed-authorization-fixtures.mjs';
import {original,context,revalidated} from './helpers/fiscal-revalidation-fixtures.mjs';
const expand=['FiscalSignedCandidate','FiscalReviewedAuthorization','FiscalStoredResponseRevalidation'];
function fixture(model,{pending=false}={}){
 const s=signedFixture({model,state:'stored'}),f=s.f,calls=[],busy=[],r=original(s.candidate),result=revalidated(r);
 const controller={...s.controller,subscribe:()=>()=>{},fiscalCompletion:async()=>f.completion,fiscalNumbering:async()=>f.reserveEnvelope,
 fiscalUnsigned:async(path)=>{calls.push(path);assert.ok(path.endsWith('/history'));return{...UNSIGNED_FLAGS,read_only:true,reservation_id:f.reservation.id,items:[f.job],limit:25,has_more:false,next_cursor:null};},
 fiscalReviewedAuthorization:async(path,o={})=>{calls.push(path);if(path.endsWith('/history'))return history(s.candidate,[r]);if(path.includes('/revalidation-context/'))return context(r,pending?null:result);if(path.endsWith('/revalidations'))throw new AccessError(503);throw Error('UNEXPECTED_OPERATION');}};
 return{s,f,calls,busy,controller};
}
test('079 existing receipt can close through generation/signature ancestors and release their navigation guard',async()=>{
 for(const model of['55','65']){const s=fixture(model),v=await mountComponent('FiscalUnsignedPreview.tsx',{controller:s.controller,value:s.f.draft,onBusy:x=>s.busy.push(x)},{expandChildren:expand});
 try{assert.equal(s.busy.at(-1),false);await v.click('Consultar histórico da autorização revisada');await v.click('Conferir resposta armazenada da tentativa 2');assert.match(v.text(),/Resultado da revalidação/);assert.equal(s.busy.at(-1),false);assert.equal(v.button('Recarregar conferência').disabled,false);await v.updateProps({blocked:true});assert.equal(v.button('Fechar conferência da resposta').disabled,false);await v.click('Fechar conferência da resposta');assert.doesNotMatch(v.text(),/Resultado da revalidação/);assert.equal(s.busy.at(-1),false);await v.updateProps({blocked:false});assert.equal(v.button('Recarregar conferência').disabled,false);assert.equal(v.button('Atualizar certificado e assinaturas').disabled,false);assert.equal(s.calls.filter(x=>x.endsWith('/revalidations')).length,0);}finally{v.unmount();}}
});

test('079 pending POST and accepted local consent guard ancestors; stale close never discards the uncertain UUID',async()=>{
 const s=fixture('55',{pending:true}),v=await mountComponent('FiscalUnsignedPreview.tsx',{controller:s.controller,value:s.f.draft,onBusy:x=>s.busy.push(x)},{expandChildren:expand});
 try{await v.click('Consultar histórico da autorização revisada');await v.click('Conferir resposta armazenada da tentativa 2');const oldClose=v.button('Fechar conferência da resposta');v.find(n=>n.props['aria-label']==='Confirmo a revalidação da resposta armazenada').props.onChange({target:{checked:true}});await v.flush();assert.equal(s.busy.at(-1),true);assert.equal(v.button('Recarregar conferência').disabled,true);await v.click('Revalidar resposta armazenada');oldClose.props.onClick();await v.flush();assert.match(v.text(),/Comando de revalidação:/);assert.equal(s.busy.at(-1),true);assert.equal(s.calls.filter(x=>x.endsWith('/revalidations')).length,1);assert.equal(v.nodes().some(n=>n.type==='button'&&n.props.children==='Fechar conferência da resposta'),false);}
 finally{v.unmount();}
});
test('079 a refused parent dismissal leaves the child usable; retirement follows only accepted local dismissal',async()=>{
 const s=fixture('55');let accepts=false,calls=0;const r=original(s.s.candidate),v=await mountComponent('FiscalStoredResponseRevalidation.tsx',{controller:s.controller,candidate:s.s.candidate,original:r,onDismiss:()=>{calls++;return accepts;}});
 try{await v.click('Fechar conferência da resposta');assert.equal(calls,1);await v.click('Fechar conferência da resposta');assert.equal(calls,2);accepts=true;const old=v.button('Fechar conferência da resposta');await v.click('Fechar conferência da resposta');assert.equal(calls,3);old.props.onClick();await v.flush();assert.equal(calls,3);}
 finally{v.unmount();}
});
