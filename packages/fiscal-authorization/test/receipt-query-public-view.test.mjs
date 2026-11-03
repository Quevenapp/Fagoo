import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
import {projectReceiptQueryLedger} from '../src/receipt-query-ledger-dto.mjs';
import {projectReceiptQueryResult,projectReceiptQueryHistory,projectReceiptQueryContext} from '../src/receipt-query-public-view.mjs';
// Optional synthetic native export; permanent in-memory tests are added with the service fixture.
const file='/Volumes/Dev/tmp/brufap-receipt-query089-synthetic-exports.json';let input;try{input=JSON.parse(await readFile(file,'utf8'));}catch{}
test('native089 export maps all four exact sources to the public boundary without private keys',{skip:input===undefined},()=>{
 for(const x of input.items){const raw=x.command,actor=raw.receipt.actor,s=raw.source,ca={p_user_id:actor,p_source_kind:s.source_kind,p_source_command_id:s.source_command_id,p_expected_attempt_id:s.authorization_attempt_id};
  const ctx=projectReceiptQueryLedger('context',x.context,ca),validation=raw.source_validation;
  const out=projectReceiptQueryContext(ctx,{action:'receiptQueryContext',input:{source_kind:s.source_kind,source_command_id:s.source_command_id,expected_attempt_id:s.authorization_attempt_id}},{verified:true,enabled:false,validation});assert.equal(out.can_query,false);assert.ok(out.blockers.includes('RUNTIME_DISABLED'));
  const a={p_user_id:actor,p_command_id:raw.query_id},cmd=projectReceiptQueryLedger('command',raw,a),publicCmd=projectReceiptQueryResult(cmd,{action:'receiptQueryCommand',commandId:raw.query_id});assert.equal(publicCmd.current.state,'authorized_homologation');assert.equal(publicCmd.receipt.query_id,raw.query_id);
  const hi={authorization_command_id:s.authorization_command_id,expected_attempt_id:s.authorization_attempt_id,limit:25,before:null},h=projectReceiptQueryLedger('history',x.history,{p_user_id:actor,p_authorization_command_id:hi.authorization_command_id,p_expected_attempt_id:hi.expected_attempt_id,p_limit:25,p_before:null});assert.equal(projectReceiptQueryHistory(h,{action:'receiptQueryHistory',input:hi}).items.length,1);
  for(const value of[out,publicCmd])for(const key of ['credential_id','lease_id','envelope_hash','private_executor_only','access_key'])assert.equal(JSON.stringify(value).includes('"'+key+'"'),false);
 }
});
