import test from 'node:test';import assert from 'node:assert/strict';
import {parseQueueSnapshot,readQueueReceipt,queueReceiptKey} from './fagoo-queues.ts';
test('snapshot binds unit and never accepts a stale/invalid revision shape',()=>{
 const value={unit:{id:'unit'},revision:0,server_time:new Date().toISOString(),config:{},queues:[],tickets:[],recent_calls:[],orders:[],campaigns:[],managed_campaigns:[],devices:[],effects:[]};
 assert.equal(parseQueueSnapshot(value,'unit').revision,0);assert.throws(()=>parseQueueSnapshot(value,'other'));assert.throws(()=>parseQueueSnapshot({...value,revision:-1},'unit'));assert.throws(()=>parseQueueSnapshot({...value,effects:null},'unit'));
});
test('uncertain receipt storage is actor/unit scoped and contains no queued operation',()=>{
 const id='11111111-1111-4111-8111-111111111111',values=new Map([[queueReceiptKey('actor','unit'),id]]),store={getItem:(key:string)=>values.get(key)??null};
 assert.equal(readQueueReceipt(store,'actor','unit'),id);assert.equal(readQueueReceipt(store,'other','unit'),null);assert.equal(readQueueReceipt(store,'actor','other'),null);values.set(queueReceiptKey('actor','unit'),'{"type":"ticket.issue"}');assert.equal(readQueueReceipt(store,'actor','unit'),null);
});
