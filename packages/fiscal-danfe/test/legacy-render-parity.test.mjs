import test from 'node:test';
import assert from 'node:assert/strict';
import {candidateFixture,boundedLongHeader} from './fixtures.mjs';
import {extractCandidatePreview} from '../src/extract.mjs';
import {renderCandidateHtml} from '../src/render.mjs';
// Captured from the frozen pre-extraction renderer. All inputs are fictitious.
const baselines=[
 [{model:'55'},'16842a538bb96309c270ce9c8a6b2b40d7e3493fbc9c328feea41c876b5f67a0',10006,1],
 [{model:'65'},'d57bfeed3d55f4058926e913cd79194bdc2618e8248029f20631b27dc5172f78',18529,null],
 [{count:250},'e75cb3cbe4e8b7c50f4eabd7917974299536e35a770897657fb756a912f9802f',216370,22],
 [{transformUnsigned:boundedLongHeader},'8ea50d325536b0e84ccbb0624b46f2226ab9288e00a57c45d2a6bfa93088d6ef',10249,1],
];
test('private layout extraction preserves legacy HTML bytes and page counts',async()=>{
 for(const [options,sha256,size,pages]of baselines){const f=await candidateFixture(options),r=renderCandidateHtml(extractCandidatePreview(f.bytes,f.context));assert.equal(r.sha256,sha256);assert.equal(Buffer.byteLength(r.html),size);assert.equal(r.page_count,pages);assert.equal(r.source_sha256,f.context.sha256);assert.equal(r.mode,'candidate_preview');assert.equal(r.authorized,false);assert.equal(r.can_transmit,false);}
});
