import test from 'node:test';
import assert from 'node:assert/strict';
import {importBeforeDispatch,isAppImportFailure,observePreloadFailures,APP_UPDATE_REQUIRED,APP_UPDATE_MESSAGE} from '../src/lib/import-failure.ts';

test('only module-load failure gets a local nondispatch marker and private diagnostic is discarded',async()=>{
 let calls=0;
 await assert.rejects(()=>importBeforeDispatch(async()=>{calls++;throw new TypeError('PRIVATE_URL_TOKEN_AND_HTML');}),error=>{
  assert.equal(error.code,APP_UPDATE_REQUIRED);assert.equal(error.request_dispatched,false);assert.equal(isAppImportFailure(error),true);assert.ok(Object.isFrozen(error));
  assert.equal(error.message,APP_UPDATE_MESSAGE);assert.equal(error.cause,undefined);assert.doesNotMatch(JSON.stringify(error),/PRIVATE_URL_TOKEN_AND_HTML/);return true;
 });assert.equal(calls,1);
 assert.equal(isAppImportFailure({code:APP_UPDATE_REQUIRED,request_dispatched:false}),false);assert.equal(isAppImportFailure(new Error(APP_UPDATE_MESSAGE)),false);
});

test('successful import is unchanged and a subsequent request failure never becomes a local import failure',async()=>{
 let sent=0;const failure=new Error('network outcome unknown'),module={async run(){sent++;throw failure;}};
 const loaded=await importBeforeDispatch(async()=>module);assert.equal(loaded,module);assert.equal(sent,0);
 await assert.rejects(()=>loaded.run(),error=>error===failure&&!isAppImportFailure(error));assert.equal(sent,1);
});

test('Vite failure observation only raises one notice, never prevents default or reloads and unsubscribes',()=>{
 const target=new EventTarget();let notices=0;const unsubscribe=observePreloadFailures(target,()=>notices++);
 const event=new Event('vite:preloadError',{cancelable:true});assert.equal(target.dispatchEvent(event),true);assert.equal(event.defaultPrevented,false);
 target.dispatchEvent(new Event('vite:preloadError'));assert.equal(notices,1);unsubscribe();target.dispatchEvent(new Event('vite:preloadError'));assert.equal(notices,1);
 const cleanup=observePreloadFailures(target,()=>{throw Error('notice unavailable');});assert.doesNotThrow(()=>target.dispatchEvent(new Event('vite:preloadError')));cleanup();
});
