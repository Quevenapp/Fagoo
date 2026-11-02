import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {
 inspectGtinPrefix,GtinPrefixError,GTIN_PREFIX_FLAGS,
 GTIN_PREFIX_TABLE,GTIN_PREFIX_MANIFEST,GTIN_PREFIX_MANIFEST_HASH
} from '../src/gtin-prefix-profile.mjs';

const sha=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
// Independent snapshot of every listed prefix in A2:B128, prefix 000 at the left.
const listedMask=BigInt('0xfffffffffffffffffffffffffffffffffff000000000000000fffffffffffffffffffffffffffffffffffffffffffff95400ffffffffff803fffff3ffffffffc00c0f11ffc00807ff00221d8d5bffc00ffc0000000003ffffc00007fffe231fff578a600ffffffffffffe0385fff8ca49fffff003fffff12ffc07f83ff').toString(2).padStart(1000,'0');
// Synthetic identifiers, not evidence of assignment. Use a different BigInt formulation.
function withDigit(body){
 const sum=[...body].reverse().reduce((n,d,i)=>n+BigInt(d)*(i%2===0?3n:1n),0n);
 return body+String((10n-sum%10n)%10n);
}
const formatError=e=>e instanceof GtinPrefixError&&e.code==='GTIN_FORMAT_INVALID'&&e.message==='GTIN_FORMAT_INVALID';
function noAuthority(r){
 for(const key of Object.keys(GTIN_PREFIX_FLAGS))assert.equal(r[key],false,key);
 for(const key of ['valid','validGtin','assigned','country','quantity','packagingQuantity','ccgStatus','canPrepare'])assert.equal(key in r,false,key);
}

test('pins the 127 official fiscal ranges, worksheet rows, observation date and source hashes',()=>{
 assert.equal(GTIN_PREFIX_TABLE.length,127);
 assert.deepEqual(GTIN_PREFIX_TABLE.map(r=>r.sourceRow),Array.from({length:127},(_,i)=>i+2));
 assert.equal(sha(GTIN_PREFIX_TABLE),'4aa57784b9c1be68465a608d9be357a6873ee0d00ba250856b3ca67cbbeaee4a');
 assert.equal(sha(GTIN_PREFIX_TABLE),GTIN_PREFIX_MANIFEST.source.ranges.sha256);
 assert.equal(sha(GTIN_PREFIX_MANIFEST),GTIN_PREFIX_MANIFEST_HASH);
 assert.equal(GTIN_PREFIX_MANIFEST_HASH,'de4dcf61603e314d421575cfb7cb528896b489a44a24959b1a38145bc22d6140');
 assert.equal(GTIN_PREFIX_MANIFEST.source.sha256,'6f75b924f7fc97a2b5c4b6483479c035304ec642b48eebc61bd2b1afb5b62606');
 assert.equal(GTIN_PREFIX_MANIFEST.source.sizeBytes,22170);
 assert.equal(GTIN_PREFIX_MANIFEST.observedOn,'2026-10-16');
 assert.equal(GTIN_PREFIX_MANIFEST.source.internalModifiedAt,'2017-10-19T12:41:53Z');
 assert.equal(GTIN_PREFIX_MANIFEST.source.publisherVersion,null);
 assert.equal(GTIN_PREFIX_MANIFEST.source.effectiveFrom,null);
 assert.equal(GTIN_PREFIX_MANIFEST.source.ranges.cells,'A2:C128');
 assert.deepEqual(GTIN_PREFIX_TABLE.slice(15,17).map(r=>r.from),['490','460']);
});

test('all 1000 prefixes match the independent fiscal-table mask, including boundaries and gaps',()=>{
 assert.equal(listedMask.length,1000);let listed=0;
 for(let n=0;n<1000;n++){
  const prefix=String(n).padStart(3,'0'),result=inspectGtinPrefix(withDigit(prefix+'123456789'));
  assert.equal(result.prefix,prefix);assert.equal(result.prefixListed,listedMask[n]==='1',prefix);
  const matching=GTIN_PREFIX_TABLE.filter(r=>r.from<=prefix&&prefix<=r.to);
  assert.ok(matching.length<=1,'Overlapping ranges at '+prefix);
  assert.equal(result.range,matching[0]??null);assert.equal(result.checkDigitMatches,true);
  if(result.prefixListed)listed++;
 }
 assert.equal(listed,701);
 for(const prefix of ['140','199','381','382','952','953','954','959','970','976','985','989']){
  const r=inspectGtinPrefix(withDigit(prefix+'123456789'));assert.equal(r.prefixListed,false,prefix);assert.equal(r.range,null);
 }
});

test('recognizes each supported length without converting or changing the original text',()=>{
 const cases=[['96385074','00000096385074','963','positions_7_to_9'],['036000291452','00036000291452','003','positions_2_to_4'],['7891234567895','07891234567895','789','positions_2_to_4'],['10012345000017','10012345000017','001','positions_2_to_4']];
 for(const [original,normalized14,prefix,prefixMethod] of cases){
  const r=inspectGtinPrefix(original);assert.equal(r.original,original);assert.equal(r.length,original.length);
  assert.equal(r.normalized14,normalized14);assert.equal(r.prefix,prefix);assert.equal(r.prefixMethod,prefixMethod);
  assert.equal(r.checkDigitMatches,true);assert.equal(r.prefixListed,true);noAuthority(r);
 }
});

test('padding shorter identifiers to 14 is a comparison representation, never a newly assigned GTIN',()=>{
 for(const original of ['96385074','036000291452','7891234567895']){
  const shorter=inspectGtinPrefix(original),padded=inspectGtinPrefix(original.padStart(14,'0'));
  assert.equal(shorter.normalized14,padded.normalized14);assert.equal(shorter.prefix,padded.prefix);
  assert.equal(shorter.checkDigitMatches,padded.checkDigitMatches);assert.notEqual(shorter.original,padded.original);
  assert.equal(shorter.length,original.length);assert.equal(padded.length,14);noAuthority(padded);
 }
});

test('UPC/GTIN-12 includes the implicit leading zero in the three-digit fiscal prefix',()=>{
 const original=withDigit('61414100001'),r=inspectGtinPrefix(original);
 assert.equal(r.original,original);assert.equal(r.normalized14,'00'+original);assert.equal(r.prefix,'061');
 assert.notEqual(r.prefix,'614');assert.equal(r.prefixMethod,'positions_2_to_4');
 const zero=inspectGtinPrefix(withDigit('00012345678'));assert.equal(zero.original.startsWith('000'),true);assert.equal(zero.prefix,'000');
});

test('GTIN-8 and the first-six-zero exception follow the worksheet, without UPC-E expansion',()=>{
 for(const original of [withDigit('7891234'),withDigit('0012345'),withDigit('00000012345')]){
  const r=inspectGtinPrefix(original);assert.equal(r.prefix,r.normalized14.slice(6,9));assert.equal(r.prefixMethod,'positions_7_to_9');
  assert.equal(r.original,original);assert.equal(r.normalized14,original.padStart(14,'0'));noAuthority(r);
 }
 // A true GTIN-14 based on an eight-digit item is not recursively unpadded.
 const grouping=withDigit('1'+'00000'+'7891234'),r=inspectGtinPrefix(grouping);
 assert.equal(r.length,14);assert.equal(r.prefix,'000');assert.equal(r.prefixMethod,'positions_2_to_4');
 assert.notEqual(r.prefix,'789');noAuthority(r);
});

test('GTIN-14 indicators, including 9, never imply quantities, contained identifiers or eligibility',()=>{
 for(const indicator of ['1','2','3','4','5','6','7','8','9']){
  const original=withDigit(indicator+'789123456789'),r=inspectGtinPrefix(original);
  assert.equal(r.original,original);assert.equal(r.prefix,'789');assert.equal(r.checkDigitMatches,true);
  assert.equal(r.prefixListed,true);noAuthority(r);
 }
});

test('special ranges retain the worksheet illustrative flag without becoming errors or tax conclusions',()=>{
 for(const prefix of ['020','040','050','200','299','950','951','960','969','977','978','979','980','981','984','990','999']){
  const r=inspectGtinPrefix(withDigit(prefix+'123456789'));
  assert.equal(r.prefixListed,true,prefix);assert.equal(r.range.specialIllustrative,true,prefix);noAuthority(r);
 }
 for(const prefix of ['000','060','139','789','790','955','958'])assert.equal(inspectGtinPrefix(withDigit(prefix+'123456789')).range.specialIllustrative,false,prefix);
});

test('check digit, listed prefix and product assignment are separate observations',()=>{
 const listedBad=inspectGtinPrefix('7891234567896');assert.equal(listedBad.checkDigitMatches,false);assert.equal(listedBad.prefixListed,true);
 const unlistedGood=inspectGtinPrefix(withDigit('199123456789'));assert.equal(unlistedGood.checkDigitMatches,true);assert.equal(unlistedGood.prefixListed,false);
 for(const size of [8,12,13,14]){
  const arithmeticOnly=inspectGtinPrefix('0'.repeat(size));assert.equal(arithmeticOnly.checkDigitMatches,true);assert.equal(arithmeticOnly.prefixListed,true);noAuthority(arithmeticOnly);
 }
});

test('single-digit substitutions fail the arithmetic check for all four lengths',()=>{
 for(const original of ['96385074','036000291452','7891234567895','10012345000017']){
  for(let at=0;at<original.length;at++){
   const altered=original.slice(0,at)+String((Number(original[at])+1)%10)+original.slice(at+1);
   assert.equal(inspectGtinPrefix(altered).checkDigitMatches,false,altered);
  }
 }
});

test('rejects nonexact input without coercion, trimming, UPC-E conversion or absence inference',()=>{
 let touched=0;const dangerous={get toString(){touched++;throw new Error('should not read');},get valueOf(){touched++;throw new Error('should not read');}};
 const proxy=new Proxy({}, {get(){touched++;throw new Error('should not read');}});
 const invalid=[null,undefined,true,7891234567895,7891234567895n,new String('96385074'),['96385074'],dangerous,proxy,'','SEM GTIN',' sem gtin ','9638507','963850740','0'.repeat(10),'0'.repeat(11),'0'.repeat(15),' 96385074','96385074 ','036000291452\n','7891234567895\r','96385074\u2028','96385074\u0000','９６３８５０７４','٩٦٣٨٥٠٧٤','789123456789.5','7.891234567895e12','1234-5678','0'.repeat(10000)];
 for(const input of invalid)assert.throws(()=>inspectGtinPrefix(input),formatError);
 assert.equal(touched,0);
});

test('results, range references and the pinned manifest are immutable and disclose only closed facts',()=>{
 const r=inspectGtinPrefix('96385074');
 const walk=value=>{if(value&&typeof value==='object'){assert.equal(Object.isFrozen(value),true);for(const child of Object.values(value))walk(child);}};
 walk(GTIN_PREFIX_MANIFEST);walk(GTIN_PREFIX_TABLE);walk(r);walk(GTIN_PREFIX_FLAGS);
 assert.throws(()=>{r.original='changed';},TypeError);assert.throws(()=>{r.range.from='999';},TypeError);
 assert.throws(()=>GTIN_PREFIX_TABLE.push({}),TypeError);assert.equal(inspectGtinPrefix('96385074').prefix,'963');
 assert.equal(r.manifestHash,GTIN_PREFIX_MANIFEST_HASH);assert.equal(r.sourceSha256,GTIN_PREFIX_MANIFEST.source.sha256);noAuthority(r);
});
