/** DEV-only synthetic transport. No certificate, socket, SEFAZ or persistence. */
import {WSDL_BASE,WSDL_FLAGS,validWsdlRun,type WsdlRun,type WsdlResult} from '../lib/wsdl-model.ts';
import type {A1RequestOptions,NativeRequestOptions} from '../lib/real-access.ts';
type Counts={post:number;get:number;records:number};
export type WsdlQaCounts=Readonly<{revision:number;nf55:Readonly<Counts>;nf65:Readonly<Counts>}>;
const identity={section:'identity',data_mode:'erp_native',emission_enabled:false,record:{version:2,data:{legal_name:'EMPRESA FICTÍCIA · QA CONEXÃO SEFAZ',cnpj:'11222333000181'}}};
const a1={data_mode:'a1_custody',environment:'2',purpose:'offline-homologation',can_emit:false,can_transmit:false,current:{version:1,state:'configured_offline',credential_id:'e0000000-0000-4000-8000-000000005101',company_identity_version:2,company_changed:false,time_valid_now:true,
 metadata:{profile:'openssl3-pkcs12',legacy_provider_enabled:false,pfx_mac:'sha256',pfx_mac_iterations:2048,fingerprint_sha256:'a'.repeat(64),holder_cnpj:'11222333000181',not_before:'2026-01-01T00:00:00Z',not_after:'2030-01-01T00:00:00Z',rsa_bits:2048,presented_chain:['a'.repeat(64)],validated_at:'2026-10-16T12:00:00Z',key_matches_certificate:true,presented_chain_links_checked:true,icp_brasil_chain_validated:false,revocation_checked:false,a1_policy_verified:false,client_auth_eku_verified:false,can_transmit:false}}};
const fail=(error:string,status:number,recovery=false)=>Response.json({error,recovery_required:recovery},{status});
const abort=(signal?:AbortSignal)=>{if(signal?.aborted)throw new DOMException('Synthetic request cancelled','AbortError');};
function stored(p:WsdlRun):WsdlResult{
 const now=Date.now(),at=new Date(now).toISOString(),finished=new Date(now+1).toISOString();
 return{...WSDL_FLAGS,status:'stored',command_id:p.command_id,recovery_required:false,read_only:false,recovered:false,failure_code:null,
  receipt:{attempt_id:crypto.randomUUID(),command_id:p.command_id,profile:WSDL_FLAGS.profile,model:p.model,operation:p.operation,environment:'2',a1_version:p.expected_a1_version,identity_version:p.expected_identity_version,confirmed:true,created_at:at},
  current:{state:'stored',a1_version:1,identity_version:2,a1_changed:false,company_changed:false,certificate_time_valid_now:true,grant_consumed:true,lease_expired:false,expires_at:new Date(now+60000).toISOString(),used_at:at,finished_at:finished,recovery_required:false,retry_get_allowed:false},
  error_code:null,artifact:{sha256:(p.model==='55'?'5':'6').repeat(64),size_bytes:2048,inspection_status:'supported',inspection_code:null,created_at:finished}};
}
export function createWsdlQaFixture(){
 const records=new Map<string,{body:WsdlRun;value:WsdlResult;postLost:boolean;getLost:boolean}>(),listeners=new Set<()=>void>();
 let counts:WsdlQaCounts=Object.freeze({revision:0,nf55:Object.freeze({post:0,get:0,records:0}),nf65:Object.freeze({post:0,get:0,records:0})});
 const bump=(model:'55'|'65',field:keyof Counts)=>{const key=model==='55'?'nf55':'nf65';counts=Object.freeze({...counts,revision:counts.revision+1,[key]:Object.freeze({...counts[key],[field]:counts[key][field]+1})});listeners.forEach(fn=>fn());};
 return{
  getSnapshot:()=>counts,subscribe:(fn:()=>void)=>{listeners.add(fn);return()=>{listeners.delete(fn);};},
  async a1(path:string,options:A1RequestOptions={}){abort(options.signal);if(path!=='/v1/a1'||options.method&&options.method!=='GET'||options.body!==undefined)throw Error('QA_WSDL_METADATA_READ_ONLY');return structuredClone(a1);},
  async company(path:string,options:NativeRequestOptions={}){abort(options.signal);if(path!=='/v1/empresa/identidade'||options.method&&options.method!=='GET'||options.body!==undefined)throw Error('QA_WSDL_IDENTITY_READ_ONLY');return structuredClone(identity);},
  async fetch(url:string,init:RequestInit={}):Promise<Response>{
   const parsed=new URL(url);abort(init.signal??undefined);
   if(parsed.origin!=='https://unsigned.qa.invalid'||parsed.search||parsed.hash)return fail('WSDL_NOT_FOUND',404);
   if(parsed.pathname===WSDL_BASE+'/run'&&init.method==='POST'){
    let body:unknown;try{body=typeof init.body==='string'?JSON.parse(init.body):null;}catch{return fail('WSDL_INVALID_REQUEST',400);}
    if(!validWsdlRun(body))return fail('WSDL_INVALID_REQUEST',400);const p=structuredClone(body);bump(p.model,'post');
    if(p.expected_a1_version!==1||p.expected_identity_version!==2)return fail('WSDL_CONFLICT',409);
    let row=records.get(p.command_id);
    if(row&&Object.entries(row.body).some(([k,v])=>p[k as keyof WsdlRun]!==v))return fail('WSDL_CONFLICT',409,true);
    if(!row){row={body:p,value:stored(p),postLost:false,getLost:false};records.set(p.command_id,row);bump(p.model,'records');}
    if(p.model==='55'&&!row.postLost){row.postLost=true;throw new TypeError('QA_SYNTHETIC_WSDL_POST_RESPONSE_LOST');}
    abort(init.signal??undefined);return Response.json({...row.value,recovered:row.postLost});
   }
   const match=/^\/v1\/fiscal-wsdl\/commands\/([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/.exec(parsed.pathname);
   if(match&&(init.method===undefined||init.method==='GET')){
    const row=records.get(match[1]);if(!row)return fail('WSDL_NOT_FOUND',404);bump(row.body.model,'get');
    if(row.body.model==='55'&&!row.getLost){row.getLost=true;throw new TypeError('QA_SYNTHETIC_WSDL_GET_RESPONSE_LOST');}
    abort(init.signal??undefined);return Response.json({...row.value,read_only:true,recovered:false,current:{...row.value.current!,lease_expired:Date.now()>=Date.parse(row.value.current!.expires_at)}});
   }
   return fail('WSDL_NOT_FOUND',404);
  },
 };
}
export type WsdlQaFixture=ReturnType<typeof createWsdlQaFixture>;
