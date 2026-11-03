import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryRouter } from 'react-router-dom';
import { createUnsavedChangesStore, protectBeforeUnload } from '../src/lib/unsaved-changes-store.ts';

test('guard aggregates independent editor flags and drops all state when editors unmount', () => {
  const store=createUnsavedChangesStore(), document=Symbol(), attachment=Symbol();
  assert.equal(store.shouldBlock(),false);
  store.update(document,{dirty:true,busy:false});
  store.update(attachment,{dirty:false,busy:true});
  assert.deepEqual(store.getSnapshot(),{dirty:true,busy:true});
  store.update(document,{dirty:false,busy:false});
  assert.equal(store.shouldBlock(),true,'an attachment in progress still protects navigation');
  store.remove(attachment); assert.equal(store.shouldBlock(),false);
  store.remove(document); assert.deepEqual(store.getSnapshot(),{dirty:false,busy:false});
  assert.deepEqual(Object.keys(store.getSnapshot()),['dirty','busy']);
  assert.ok(Object.isFrozen(store.getSnapshot()));
});

test('confirmed navigation exemption is synchronous, scoped, and restored even after failures', () => {
  const store=createUnsavedChangesStore();store.update(Symbol(),{dirty:true,busy:false});
  store.runConfirmed(()=>assert.equal(store.shouldBlock(),false));
  assert.equal(store.shouldBlock(),true,'confirmation does not silently mark an editor saved');
  assert.throws(()=>store.runConfirmed(()=>{throw new Error('Synthetic failure');}));
  assert.equal(store.shouldBlock(),true);
});

test('beforeunload warns for dirty or pending state and removes the listener cleanly', () => {
  const target=new EventTarget(),store=createUnsavedChangesStore(),editor=Symbol();
  const cleanup=protectBeforeUnload(target,store.shouldBlock);
  const dispatch=()=>{const event=new Event('beforeunload',{cancelable:true});Object.defineProperty(event,'returnValue',{value:'untouched',writable:true});target.dispatchEvent(event);return event;};
  assert.equal(dispatch().defaultPrevented,false);
  store.update(editor,{dirty:true,busy:false});
  const dirty=dispatch();assert.equal(dirty.defaultPrevented,true);assert.equal(dirty.returnValue,'');
  store.update(editor,{dirty:false,busy:true});assert.equal(dispatch().defaultPrevented,true);
  cleanup();assert.equal(dispatch().defaultPrevented,false);
});

test('installed data router preserves location on cancel and supports proceed for push, query, back and forward', async () => {
  const store=createUnsavedChangesStore(), editor=Symbol();
  const router=createMemoryRouter([{path:'*',element:null}],{initialEntries:['/acesso','/documentos-empresa?tipo=sales_proposals'],initialIndex:1});
  router.getBlocker('guard',()=>store.shouldBlock());
  const block=()=>router.state.blockers.get('guard');
  store.update(editor,{dirty:true,busy:false});
  await router.navigate('/documentos-empresa?tipo=sales_orders');
  assert.equal(block().state,'blocked');assert.equal(router.state.location.search,'?tipo=sales_proposals');
  block().reset(); assert.equal(block().state,'unblocked');
  assert.equal(router.state.location.search,'?tipo=sales_proposals');
  await router.navigate('/financeiro-empresa'); block().proceed();
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(router.state.location.pathname,'/financeiro-empresa');
  await router.navigate(-1); assert.equal(block().state,'blocked');block().reset();
  assert.equal(router.state.location.pathname,'/financeiro-empresa');
  await router.navigate(-1);block().proceed();await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(router.state.location.pathname,'/documentos-empresa');
  await router.navigate(1);assert.equal(block().state,'blocked');block().reset();
  store.update(editor,{dirty:false,busy:true});
  await router.navigate('/acesso');assert.equal(block().state,'blocked','pending operation blocks a pristine editor');block().reset();
  store.remove(editor);await router.navigate('/acesso');assert.equal(router.state.location.pathname,'/acesso');
  router.dispose();
});
