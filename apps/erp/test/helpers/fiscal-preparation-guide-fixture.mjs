import {configured,envelope,metadata} from './a1-fixtures.mjs';
import {numberFlags,unsignedUuid,unsignedFixture} from './fiscal-unsigned-fixtures.mjs';
export const actor=unsignedUuid(80),at='2026-10-17T03:00:00Z';
export function guideFixture({model='55',empty=false,before}={}){
 const company={section:'identity',data_mode:'erp_native',emission_enabled:false,record:empty?null:{version:1,data:{legal_name:'EMPRESA SINTÉTICA DA GUIA',cnpj:'11222333000181',ie:'123456789',state:'SP'}}};
 const fiscal={section:'fiscal',data_mode:'erp_native',emission_enabled:false,record:empty?null:{version:1,identity_version:1,crt:'1',confirmed:true}};
 const a1=envelope(empty?{version:0,state:'unconfigured',credential_id:null,company_identity_version:null,metadata:null,company_changed:false,time_valid_now:false}:{...configured,company_identity_version:1,metadata:{...metadata,holder_cnpj:'11222333000181'}});
 const series={...numberFlags,read_only:true,items:empty?[]:[{...unsignedFixture({model}).series,issuer_cnpj:'11222333000181'}],limit:25,has_more:false,next_cursor:null};
 const order={id:unsignedUuid(90),kind:'sales_orders',number:'1',version:1,status:'verified',date:'2026-10-16',total:'12.34',contact_id:unsignedUuid(91),contact_name:'CLIENTE PRIVADO SINTÉTICO',created_at:at,updated_at:at};
 const orders={kind:'sales_orders',data_mode:'erp_native',operational_effects:false,items:empty?[]:[order],limit:25,has_more:false,next_cursor:null};
 const s={model,company,fiscal,a1,series,orders,calls:[],state:{phase:'ready',membership:{user_id:actor,role:'fiscal',resources:[],data_mode:'staging_readonly'}},listeners:new Set()};
 s.setState=patch=>{s.state={...s.state,...patch};for(const fn of s.listeners)fn();};
 const read=async(path,options={})=>{s.calls.push({path,...options});if(before){const value=await before(path,options,s);if(value!==undefined)return value;}if(path==='/v1/empresa/identidade')return structuredClone(s.company);if(path==='/v1/empresa/fiscal')return structuredClone(s.fiscal);if(path==='/v1/a1')return structuredClone(s.a1);if(path.startsWith('/v1/numeracao-fiscal/series?'))return structuredClone(s.series);if(path==='/v1/documentos/sales_orders?limit=25&origin=brufap')return structuredClone(s.orders);if(path.startsWith('/v1/rascunhos-fiscais?'))return{data_mode:'fiscal_draft',emission_enabled:false,operational_effects:false,items:[],limit:25,has_more:false,next_cursor:null};throw new Error('UNEXPECTED_GUIDE_ROUTE');};
 s.controller={company:read,a1:read,fiscalNumbering:read,documents:read,fiscalDraft:read,getSnapshot:()=>s.state,subscribe:fn=>{s.listeners.add(fn);return()=>s.listeners.delete(fn);}};return s;
}
