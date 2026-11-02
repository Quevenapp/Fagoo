import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateNfceEmissionWindow as evaluate,requireNfceEmissionWindow as requireWindow} from '../src/emission-window.mjs';
const issuedAt='2026-10-17T03:00:00-03:00',issued=Date.parse(issuedAt);
const input=(delta=0,margin=30000)=>({model:'65',environment:'2',emissionType:'1',issuedAt,now:issued+delta,safetyMarginMs:margin});
test('normal65 exact300s boundary is conservative, separate from30s consumption margin',()=>{
 for(const [age,margin,status] of [[269999,30000,'valid'],[270000,30000,'too_short'],[270001,30000,'too_short'],[299999,0,'valid'],[300000,0,'expired'],[300001,0,'expired'],[300000,30000,'expired']])assert.equal(evaluate(input(age,margin)).status,status);
 assert.throws(()=>requireWindow(input(270000)),{code:'AUTHORIZATION_NFCE_EMISSION_WINDOW_TOO_SHORT'});
 assert.throws(()=>requireWindow(input(300000,0)),{code:'AUTHORIZATION_NFCE_EMISSION_EXPIRED'});
});
test('future tolerance is300s inclusive and never added to the maximum age',()=>{
 for(const [age,status] of [[-299999,'valid'],[-300000,'valid'],[-300001,'future'],[599999,'expired']])assert.equal(evaluate(input(age)).status,status);
 assert.throws(()=>requireWindow(input(-300001)),{code:'AUTHORIZATION_NFCE_EMISSION_FUTURE'});
});
test('equivalent timezone timestamps and projected UTC milliseconds roundtrip exactly',()=>{
 const out=evaluate(input(1234));assert.ok(Object.isFrozen(out));
 assert.deepEqual(out,{issued_at:'2026-10-17T06:00:00.000Z',observed_at:'2026-10-17T06:00:01.234Z',expires_at:'2026-10-17T06:05:00.000Z',send_before:'2026-10-17T06:04:30.000Z',max_age_seconds:300,safety_margin_seconds:30,status:'valid'});
 for(const text of [out.issued_at,'2026-10-17T06:00:00Z','2026-10-17T08:00:00+02:00'])assert.deepEqual(evaluate({...input(1234),issuedAt:text}),out);
 const fractional=evaluate({...input(),issuedAt:'2026-10-17T06:00:00.123Z'});assert.equal(fractional.expires_at,'2026-10-17T06:05:00.123Z');
});
test('invalid calendars, noncanonical values, unsupported scope and injected margins fail closed',()=>{
 const patches=[...['2026-02-30T06:00:00Z','2026-10-17T24:00:00Z','2026-10-17T06:00:60Z','2026-10-17T06:00:00+14:01','2026-10-17T06:00:00Z\n','2026-10-17','2026-02-30T06:00:00.000Z','2026-10-17T06:00:00.1Z','2026-10-17T06:00:00'].map(issuedAt=>({issuedAt})),{model:'57'},{environment:'1'},{emissionType:'9'},{now:NaN},{now:Infinity},{now:issued+.5},{now:new Date(issued)},{safetyMarginMs:1},{safetyMarginMs:300000}];
 for(const patch of patches)assert.throws(()=>evaluate({...input(),...patch}),{code:'AUTHORIZATION_NFCE_EMISSION_INPUT_INVALID'});
});
test('closed scalar input rejects getters without evaluating them; copied output does not change source',()=>{
 let reads=0;const value={...input()};Object.defineProperty(value,'issuedAt',{enumerable:true,get(){reads++;return issuedAt;}});
 assert.throws(()=>evaluate(value),{code:'AUTHORIZATION_NFCE_EMISSION_INPUT_INVALID'});assert.equal(reads,0);
 for(const value of [{...input(),canTransmit:true},Object.assign(Object.create({}),input()),{...input(),[Symbol('extra')]:true}])assert.throws(()=>evaluate(value),{code:'AUTHORIZATION_NFCE_EMISSION_INPUT_INVALID'});
 const source=input(),out=evaluate(source);source.issuedAt='invalid';source.now=0;assert.equal(out.status,'valid');
});
test('model55 has no new temporal gate, including historical or future timestamps',()=>{
 for(const age of [-1000000,1000000])assert.equal(requireWindow({...input(age),model:'55'}),null);
 assert.equal(evaluate({...input(),model:'55',issuedAt:'not used by55'}),null);
});
