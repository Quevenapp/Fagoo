import {AccessError} from './component-recovery-harness.mjs';
import {unsignedFixture,unsignedUuid} from './fiscal-unsigned-fixtures.mjs';
import {configured,envelope} from './a1-fixtures.mjs';
import {SIGNED_FLAGS} from '../../src/lib/fiscal-signed-model.ts';
const copy=structuredClone;
export function signedFixture({model='55',state=null,before=()=>{},after=()=>{}}={}){
 const f=unsignedFixture({model}),s={f,a1:copy(configured),candidate:null,commands:new Map(),calls:[],counts:{},role:'admin'};
 s.make=(status='stored')=>({...SIGNED_FLAGS,status,candidate_id:unsignedUuid(700),candidate_version:1,unsigned_job_id:f.job.job_id,unsigned_hash:f.job.artifact.sha256,basis_hash:f.job.basis_hash,model,
  completion_version:f.job.completion_version,completion_hash:f.job.completion_hash,a1_version:1,error_code:status==='failed'?'XSD_INVALID':null,
  signed:status==='stored',signature_verified:status==='stored',xsd_validated:status==='stored',
  current:{state:status,attempt_count:1,unsigned_artifact_current:true,basis_changed:false,draft_archived:false,source_cancelled:false,series_enabled:true,a1_version:1,a1_changed:false,certificate_time_valid_now:true,latest_candidate_id:unsignedUuid(700),latest_candidate_version:1,is_latest_candidate:true,artifact_current:status==='stored'},
  artifact:status==='stored'?{sha256:'7'.repeat(64),size_bytes:12000,created_at:'2026-10-16T15:00:00.123456Z'}:null});
 if(state)s.candidate=s.make(state);
 const call=async(channel,path,o={})=>{
  const kind=channel==='a1'?'a1':path.endsWith('/run')?'run':path.endsWith('/history')?'history':path.includes('/commands/')?'command':'candidate';
  const c={kind,channel,path,body:copy(o.body),method:o.method??'GET',signal:o.signal};s.calls.push(c);s.counts[kind]=(s.counts[kind]??0)+1;await before(c,s);let value;
  if(kind==='a1')value=envelope(s.a1);
  else if(kind==='history')value={...SIGNED_FLAGS,read_only:true,unsigned_job_id:f.job.job_id,items:s.candidate&&(!o.body.before||s.candidate.candidate_version<o.body.before)?[{...copy(s.candidate),read_only:true}]:[],limit:25,has_more:false,next_cursor:null};
  else if(kind==='run'){s.candidate??=s.make();s.commands.set(o.body.command_id,copy(o.body));value={...copy(s.candidate),command_id:o.body.command_id};}
  else if(kind==='command'){const id=path.split('/').at(-1);if(!s.commands.has(id))throw new AccessError(404);value={...copy(s.candidate),command_id:id,read_only:true};}
  else{if(!s.candidate)throw new AccessError(404);value={...copy(s.candidate),read_only:true};}
  await after(c,s);return copy(value);
 };
 s.controller={getSnapshot:()=>({phase:'ready',membership:{user_id:unsignedUuid(99),role:s.role}}),a1:(p,o)=>call('a1',p,o),fiscalSigned:(p,o)=>call('signed',p,o)};return s;
}
export const text=v=>Array.isArray(v)?v.map(text).join(''):v&&typeof v==='object'?text(v.props?.children):v==null||typeof v==='boolean'?'':String(v);
export const checkbox=v=>v.find(n=>n.type==='input'&&n.props.type==='checkbox');
export const confirm=async v=>{checkbox(v).props.onChange({target:{checked:true}});await v.flush();};
