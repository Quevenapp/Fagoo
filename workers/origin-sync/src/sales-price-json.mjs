/** 078: only sales-detail line prices; no discount policy, list fallback or eligibility. */
import {parseSelectedPriceJson} from './price-json-parser.mjs';
export const SALES_PRICE_CAPTURE_PROFILE='origin-sales-price-json-v1';
const captured=new WeakMap();
export function salesPriceEndpoint(path){return typeof path==='string'&&/^\/pedidos\/vendas\/[0-9]{1,40}$/.test(path)?'sales_detail':null;}
export const salesPriceCapture=value=>captured.get(value)??null;
export async function parseSalesPriceJson(text,bytes,endpoint){
 if(endpoint!=='sales_detail')throw Object.assign(new Error('ORIGIN_PRICE_CAPTURE_UNAVAILABLE'),{code:'ORIGIN_PRICE_CAPTURE_UNAVAILABLE'});
 const {result,hash,tokens}=await parseSelectedPriceJson(text,bytes,path=>path.length===4&&path[0]==='data'&&path[1]==='itens'&&typeof path[2]==='number'&&path[3]==='valor'?[0,`/itens/${path[2]}/valor`]:null);
 const data=result?.data,found=tokens.get(0)||[];
 if(JSON.stringify(found).length>130000)throw Object.assign(new Error('ORIGIN_PRICE_TOKEN_LIMIT'),{code:'ORIGIN_PRICE_TOKEN_LIMIT'});
 if(data!==null&&typeof data==='object'&&!Array.isArray(data))captured.set(data,Object.freeze({profile:SALES_PRICE_CAPTURE_PROFILE,response_sha256:hash,source:'detail',tokens:Object.freeze(found)}));
 return result;
}
