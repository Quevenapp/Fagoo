import {itauLegacyQaPage,itauLegacyQaItem,itauLegacyQaActor} from '../../src/qa/itau-legacy-readiness-fixture.ts';
import {captureItauLegacyRequest} from '../../src/lib/itau-legacy-readiness-request.ts';
import {generateRemittance} from '../../../../packages/cnab-core/src/remittance.mjs';
import {PROFILES,title,returnFile} from '../../../../packages/cnab-core/test/fixtures.mjs';
export {itauLegacyQaItem as item,itauLegacyQaPage as page,returnFile};
export const BASE='/v1/cobrancas-legadas-itau',ACTOR=itauLegacyQaActor,OTHER='84000000-0000-4000-8000-000000000901';
export const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
export async function remittance(patch={}){return(await generateRemittance({profile:PROFILES.itau,titles:[title(patch)],generatedOn:'2026-10-16',remittanceSequence:'1',purpose:'homologation'})).bytes;}
export const file=(bytes,name='synthetic.REM')=>new File([bytes],name);
export async function choose(v,files){v.input('itau-legacy-files').props.onChange({target:{files}});await v.flush();}
export function fixture({numbers=[1,2],role='admin',phase='ready',before=()=>{},after=(_,r)=>r}={}){let state={phase,membership:{user_id:ACTOR,role,resources:[],data_mode:'staging_readonly'},records:null,listPending:false,loginPending:false,message:null,logoutFailed:false};const listeners=new Set(),f={calls:[]};f.setAccess=patch=>{const actor=Object.hasOwn(patch,'actor')?patch.actor:state.membership?.user_id;state={...state,phase:patch.phase??state.phase,membership:actor?{user_id:actor,role:patch.role??state.membership?.role??'admin',resources:[],data_mode:'staging_readonly'}:null};listeners.forEach(fn=>fn());};f.controller={getSnapshot:()=>state,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},async itauLegacyReadiness(path,options){const call={path,...options};f.calls.push(call);const override=await before(call,f);if(override!==undefined)return override;const r=captureItauLegacyRequest(path,options);return after(call,structuredClone(itauLegacyQaPage(r.filters,numbers)),f);}};return f;}
