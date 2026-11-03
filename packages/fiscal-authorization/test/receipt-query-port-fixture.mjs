import {serviceFixture} from './receipt-query-service-fixture.mjs';
import {receiptQuerySource,disposeReceiptQuerySource} from '../src/receipt-query-source.mjs';
import {prepareReceiptQuery} from '../src/receipt-core.mjs';
import {prepareReviewedReceiptSoap} from '../src/receipt-soap-binding.mjs';
import {RECEIPT_QUERY_LEDGER_FLAGS} from '../src/receipt-query-ledger-dto.mjs';
export async function preparedFixture(f,patch={},model='55'){
 const x=serviceFixture(f,model);let captured;
 await x.service({withPreparedSession:async value=>{captured=value.context;throw Error('synthetic capture before use');}}).run(x.input());
 const source=await x.x.read(),request=prepareReceiptQuery({evidence:receiptQuerySource(source).evidence}),context={...structuredClone(captured),...patch};
 return{x,value:{actor:x.actor,source,request,context},soap:prepareReviewedReceiptSoap({request}),used:{...RECEIPT_QUERY_LEDGER_FLAGS,private_executor_only:true,grant:{...context,issued_at:new Date().toISOString()}},close:()=>disposeReceiptQuerySource(source)};
}
