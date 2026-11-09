import test from 'node:test';
import assert from 'node:assert/strict';
import {mountComponent} from './helpers/component-recovery-harness.mjs';

const unit='11111111-1111-1111-1111-111111111111';
const modules={'./ApiDocumentation':'export function ApiDocumentationLink(props){return r.jsx("a",{...props,href:"/atendimento?page=api-docs"});}'};
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
test('the embedded App recovers a failed poll without hiding an uncertain action or showing cancelled requests',async()=>{
 const intervals=new Map(),original=globalThis.setInterval,originalClear=globalThis.clearInterval;
 let sequence=0,mode='okay',actionError=false;
 globalThis.setInterval=(fn,delay)=>{const id=++sequence;intervals.set(id,{fn,delay});return id;};
 globalThis.clearInterval=id=>intervals.delete(id);
 const api=async(path,method='GET')=>{
  if(method!=='GET'){if(actionError)throw new Error('Operação não confirmada. Confira o resultado.');return {};}
  if(path==='v1/me')return {id:'synthetic',name:'Pessoa',role:'admin'};
  if(path==='v1/profiles')return [{id:unit,name:'Unidade'}];
  if(path.includes('/presence'))return {data:[{actor:'synthetic',name:'Pessoa',present:0}]};
  if(path.endsWith('/status')){
   if(mode==='fail')throw new Error('Não foi possível atualizar o atendimento.');
   if(mode==='abort')throw new DOMException('Request cancelled','AbortError');
   return {settings:{},enabled:false,conversations:[],deliveries:[],connections:[]};
  }
  return {data:[]};
 };
 let view;
 try{
  view=await mountComponent('../../../../workers/communication/web/main.tsx',{managedContext:{api,initialPage:'overview'}},{componentName:'App',modules});
  const poll=async()=>{for(const timer of intervals.values())if(timer.delay===15000)await timer.fn();await tick();await view.flush();};
  mode='fail';await poll();assert.match(view.text(),/Não foi possível atualizar o atendimento/);
  mode='okay';await poll();assert.doesNotMatch(view.text(),/Não foi possível atualizar o atendimento/);
  mode='abort';await poll();assert.doesNotMatch(view.text(),/Request cancelled|access_request_failed/);
  actionError=true;mode='okay';
  await view.updateProps({managedContext:{api,initialPage:'presence'}});
  const action=view.find(node=>node.props.children==='Estou disponível');
  action.props.onClick();await tick();await view.flush();
  assert.match(view.text(),/Operação não confirmada/);
  await poll();assert.match(view.text(),/Operação não confirmada/);
 }finally{view?.unmount();globalThis.setInterval=original;globalThis.clearInterval=originalClear;}
});
