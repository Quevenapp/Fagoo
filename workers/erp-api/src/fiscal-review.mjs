import {executeFiscalDraftRoute} from './fiscal-drafts.mjs';
import {buildFiscalReview} from '../../../packages/fiscal-core/src/review.mjs';
const PREFIX='/v1/rascunhos-fiscais';
export class FiscalReviewError extends Error {constructor(status,code){super(code);this.status=status;this.code=code;}}
const invalid=()=>{throw new FiscalReviewError(400,'ERP_INVALID_QUERY');};
export function fiscalReviewRoute(path){
 const match=/^\/v1\/rascunhos-fiscais\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\/conferencia$/i.exec(path);
 return match?{id:match[1].toLowerCase()}:null;
}
export const fiscalReviewMethods=()=>['GET'];
export function parseFiscalReviewRoute(request){
 const url=new URL(request.url),route=fiscalReviewRoute(url.pathname);
 if(!route){if(url.pathname.startsWith(PREFIX)&&url.pathname.endsWith('/conferencia'))throw new FiscalReviewError(404,'ERP_NOT_FOUND');return null;}
 if(request.method!=='GET')throw new FiscalReviewError(405,'ERP_METHOD_NOT_ALLOWED');
 if(request.body!==null)invalid();
 for(const key of url.searchParams.keys())if(key!=='revision'||url.searchParams.getAll(key).length!==1)invalid();
 const revision=url.searchParams.get('revision');
 if(!/^[1-9]\d{0,9}$/.test(revision||'')||Number(revision)>2147483647)invalid();
 return{...route,revision:Number(revision),rpc:'erp_fiscal_draft_review',args:{p_id:route.id,p_revision:Number(revision)}};
}
/** Authenticate upstream; the SQL RPC rechecks admin/fiscal membership. */
export async function executeFiscalReviewRoute(route,{userId,rpc}){
 if(!route)throw new FiscalReviewError(404,'ERP_NOT_FOUND');
 const raw=await rpc(route.rpc,{p_user_id:userId,...route.args});
 try{
  const draft=await executeFiscalDraftRoute({operation:'get',rpc:'erp_fiscal_draft_get',id:route.id,revision:route.revision,args:route.args},{userId,rpc:async()=>raw?.draft});
  return buildFiscalReview({draft,catalog:raw?.catalog,observed_at:raw?.observed_at});
 }catch{throw new FiscalReviewError(502,'ERP_UPSTREAM_INVALID_RESPONSE');}
}
