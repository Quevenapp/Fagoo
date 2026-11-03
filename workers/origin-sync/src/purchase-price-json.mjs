/** 071: only purchase-detail line prices; never list fallback or eligibility. */
import {parseSelectedPriceJson} from './price-json-parser.mjs';
export const PURCHASE_PRICE_CAPTURE_PROFILE='origin-purchase-price-json-v1';
const captured=new WeakMap();
export function purchasePriceEndpoint(path){return typeof path==='string'&&/^\/pedidos\/compras\/[0-9]{1,40}$/.test(path)?'purchase_detail':null;}
export const purchasePriceCapture=value=>captured.get(value)??null;
export async function parsePurchasePriceJson(text,bytes,endpoint){
 if(endpoint!=='purchase_detail')throw Object.assign(new Error('ORIGIN_PRICE_CAPTURE_UNAVAILABLE'),{code:'ORIGIN_PRICE_CAPTURE_UNAVAILABLE'});
 const {result,hash,tokens}=await parseSelectedPriceJson(text,bytes,path=>path.length===4&&path[0]==='data'&&path[1]==='itens'&&typeof path[2]==='number'&&path[3]==='valor'?[0,`/itens/${path[2]}/valor`]:null);
 const data=result?.data,found=tokens.get(0)||[];
 if(JSON.stringify(found).length>130000)throw Object.assign(new Error('ORIGIN_PRICE_TOKEN_LIMIT'),{code:'ORIGIN_PRICE_TOKEN_LIMIT'});
 if(data!==null&&typeof data==='object'&&!Array.isArray(data))captured.set(data,Object.freeze({profile:PURCHASE_PRICE_CAPTURE_PROFILE,response_sha256:hash,source:'detail',tokens:Object.freeze(found)}));
 return result;
}
