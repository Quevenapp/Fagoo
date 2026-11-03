// Browser/workerd-safe projection. Equality is never bank provenance or financial eligibility.
export const ITAU_LEGACY_PROFILE='itau109-legacy-readiness-v1';
export const ITAU_LEGACY_MAX_BYTES=262144;
export class ItauLegacyReadinessError extends Error{constructor(status,code){super(code);this.name='ItauLegacyReadinessError';this.status=status;this.code=code;}}
const invalid=()=>{throw new ItauLegacyReadinessError(502,'ITAU_LEGACY_RESPONSE_INVALID');};
const need=v=>{if(!v)invalid();};
const object=(v,keys)=>{need(v&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v)));const d=Object.getOwnPropertyDescriptors(v),ks=Reflect.ownKeys(d);need(ks.length===keys.length&&ks.every(k=>typeof k==='string'&&keys.includes(k)&&d[k].enumerable&&Object.hasOwn(d[k],'value')));return Object.fromEntries(keys.map(k=>[k,d[k].value]));};
const array=(v,max)=>{need(Array.isArray(v)&&Object.getPrototypeOf(v)===Array.prototype);const d=Object.getOwnPropertyDescriptors(v),n=d.length?.value;need(Number.isInteger(n)&&n<=max&&n>=0&&Reflect.ownKeys(d).length===n+1);return Array.from({length:n},(_,i)=>{need(d[i]?.enumerable&&Object.hasOwn(d[i],'value'));return d[i].value;});};
const text=(v,max=200)=>typeof v==='string'&&v.length<=max*2&&[...v].length<=max&&!/[\x00-\x1f\x7f-\x9f]/.test(v);
const id=v=>text(v)&&v.length>0;
const numericId=v=>typeof v==='string'&&/^[0-9]{1,40}$/.test(v)&&/[1-9]/.test(v);
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const version=v=>typeof v==='string'&&/^[1-9][0-9]{0,18}$/.test(v)&&BigInt(v)<=9223372036854775807n;
const bool=v=>typeof v==='boolean';
const nullable=(v,check)=>v===null||check(v);
const timestamp=v=>typeof v==='string'&&v.length<=40&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(v)&&Number.isFinite(Date.parse(v));
const day=v=>typeof v==='string'&&/^(19|20)\d{2}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v+'T00:00:00Z'))&&new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v;
const frozen=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(frozen);Object.freeze(v);}return v;};
const ordered=(a,b)=>{const x=new TextEncoder().encode(a),y=new TextEncoder().encode(b);for(let i=0;i<Math.min(x.length,y.length);i++)if(x[i]!==y[i])return x[i]<y[i];return x.length<y.length;};
const flags={read_only:true,persisted:false,can_bind:false,can_settle:false,can_generate:false,bridge_authenticated:false,origin_authenticated:false,financial_mutation_performed:false,coverage_certified:false};
const reference=v=>{const x=object(v,['state','value']);need(['absent','null','empty','complete','invalid','too_long'].includes(x.state));need(x.state==='complete'?text(x.value)&&x.value.length>0:x.state==='empty'?x.value==='':x.value===null);return x;};
const money=v=>{const x=object(v,['state','cents']);need(['available','missing','null','invalid_type','out_of_range','invalid_value'].includes(x.state));need(x.state==='available'?typeof x.cents==='string'&&/^(0|[1-9][0-9]{0,15})$/.test(x.cents):x.cents===null);return x;};
function item(raw){
 const x=object(raw,['source','references','contact_match','refresh','native_origin']);
 const s=object(x.source,['id','hash','version','seen_at','status_code','status_scope','identity_matches','comparison_supported','issued_on','due_on','amount','balance']);
 need(id(s.id)&&hash(s.hash)&&version(s.version)&&timestamp(s.seen_at)&&nullable(s.status_code,v=>typeof v==='string'&&/^[1-7]$/.test(v)));
 need(s.status_scope===(s.status_code==='1'?'open':s.status_code==='3'?'partial':s.status_code===null?'unknown':'outside_open_scope'));
 need(bool(s.identity_matches)&&s.comparison_supported===(numericId(s.id)&&s.identity_matches)&&nullable(s.issued_on,day)&&nullable(s.due_on,day));
 s.amount=money(s.amount);s.balance=money(s.balance);
 const r=object(x.references,['bank_number','document_number','bank_reference_format','control','account_scope']);r.bank_number=reference(r.bank_number);r.document_number=reference(r.document_number);
 need(r.control===null&&r.account_scope===null&&r.bank_reference_format===(r.bank_number.state!=='complete'?'unavailable':/^109\/[0-9]{8}-[0-9]$/.test(r.bank_number.value)?'itau109_display':'other'));
 const c=object(x.contact_match,['scope','state','record_id','record_version','pending_review','human_edited']);
 need(c.scope==='catalog_only'&&['missing_reference','invalid_reference','unmatched','matched','inactive'].includes(c.state)&&nullable(c.pending_review,bool)&&nullable(c.human_edited,bool));
 need(['matched','inactive'].includes(c.state)?uuid(c.record_id)&&version(c.record_version)&&bool(c.pending_review)&&bool(c.human_edited):c.record_id===null&&c.record_version===null&&c.pending_review===null&&c.human_edited===null);
 const f=object(x.refresh,['state','last_finished_at','current_source_matches_result']);need(['never_attempted','incomplete','pending','stored','failed','conflict'].includes(f.state)&&nullable(f.last_finished_at,timestamp)&&nullable(f.current_source_matches_result,bool));need(f.state==='stored'?bool(f.current_source_matches_result):f.current_source_matches_result===null);
 let n=null;if(x.native_origin!==null){n=object(x.native_origin,['title_id','title_version','origin_command_id','source_hash','source_version','source_matches_current','current_status']);need(uuid(n.title_id)&&version(n.title_version)&&uuid(n.origin_command_id)&&hash(n.source_hash)&&version(n.source_version)&&['open','partial','paid','cancelled'].includes(n.current_status));need(n.source_matches_current===(n.source_hash===s.hash&&n.source_version===s.version));}
 return {source:s,references:r,contact_match:c,refresh:f,native_origin:n};
}
export function captureItauLegacyFilters(raw){try{const f=object(raw,['status','bank_reference','limit','after']);need(['open_partial','all'].includes(f.status)&&['all','present','missing'].includes(f.bank_reference)&&Number.isInteger(f.limit)&&f.limit>=1&&f.limit<=25&&nullable(f.after,id));return Object.freeze(f);}catch{throw new ItauLegacyReadinessError(400,'ERP_INVALID_QUERY');}}
export function parseItauLegacyPage(raw,filters){try{
 const expected=captureItauLegacyFilters(filters);const p=object(raw,['profile',...Object.keys(flags),'observed_at','scope','filters','items','has_more','next_after']);
 need(p.profile===ITAU_LEGACY_PROFILE&&p.scope==='stored_receivables'&&timestamp(p.observed_at)&&Object.entries(flags).every(([k,v])=>p[k]===v));
 p.filters=captureItauLegacyFilters(p.filters);need(Object.keys(expected).every(k=>p.filters[k]===expected[k]));p.items=array(p.items,expected.limit).map(item);
 let previous=expected.after;for(const x of p.items){need(previous===null||ordered(previous,x.source.id));previous=x.source.id;need(expected.status==='all'||['open','partial'].includes(x.source.status_scope));const missing=['absent','null','empty'].includes(x.references.bank_number.state);need(expected.bank_reference==='all'||missing===(expected.bank_reference==='missing'));}
 need(bool(p.has_more)&&nullable(p.next_after,id));need(p.has_more?p.items.length===expected.limit&&p.next_after===previous:p.next_after===null);
 need(new TextEncoder().encode(JSON.stringify(p)).byteLength<=ITAU_LEGACY_MAX_BYTES);return frozen(p);
}catch{invalid();}}
export function itauLegacyComparisonSource(raw){try{const x=item(raw),s=x.source,r=x.references;need(s.comparison_supported);return Object.freeze({source_id:s.id,source_hash:s.hash,source_version:s.version,status_code:s.status_code,amount_cents:s.amount.cents,balance_cents:s.balance.cents,due_on:s.due_on,bank_number:r.bank_number.state==='complete'?r.bank_number.value:null,document_number:r.document_number.state==='complete'?r.document_number.value:null,document_number_complete:r.document_number.state==='complete',control:null,account_scope:null});}catch{throw new ItauLegacyReadinessError(400,'ITAU_LEGACY_SOURCE_UNSUPPORTED');}}
