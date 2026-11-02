/** Shape-only persistence profile; no identity, arithmetic, XML or fiscal authorization. */
export const COMPLETION_PROFILE='sn-sp-business-completion-v1';
export const COMPLETION_FLAGS=Object.freeze({data_mode:'fiscal_business_completion',profile:COMPLETION_PROFILE,schema_profile:'pl010f-v1.04',
 operational_effects:false,calculation_performed:false,arithmetic_verified:false,tax_rules_validated:false,numbering_bound:false,
 xml_generated:false,xsd_validated:false,signature_verified:false,authorized:false,can_emit:false,can_transmit:false});
export const COMPLETION_TOTAL_FIELDS=Object.freeze(['vBC','vICMS','vICMSDeson','vFCP','vBCST','vST','vFCPST','vFCPSTRet','vProd','vFrete','vSeg','vDesc','vII','vIPI','vIPIDevol','vPIS','vCOFINS','vOutro','vNF']);
export const COMPLETION_EXCLUDED_FIELDS=Object.freeze(['ipi','ii','issqn','ibs_cbs','is','monophase','destination_icms']);
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v));
const exact=(v,keys)=>plain(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
export class BusinessCompletionError extends Error{constructor(){super('BUSINESS_COMPLETION_INVALID');this.name='BusinessCompletionError';this.code='BUSINESS_COMPLETION_INVALID';}}
const need=v=>{if(!v)throw new BusinessCompletionError();};
const choice=(v,values)=>v===null||typeof v==='string'&&values.includes(v);
const text=(v,max)=>v===null||typeof v==='string'&&v.length>=1&&v.length<=max&&/^[\x21-\x7e\xa0-\xff](?:[\x20-\x7e\xa0-\xff]*[\x21-\x7e\xa0-\xff])?$/.test(v);
const money=v=>v===null||typeof v==='string'&&/^(?:0|[1-9][0-9]{0,12})\.[0-9]{2}$/.test(v);
const decimal=(v,scale,positive=false)=>v===null||typeof v==='string'&&new RegExp(`^(?:0|[1-9][0-9]{0,10})(?:\\.[0-9]{1,${scale}})?$`).test(v)&&(!positive||/[1-9]/.test(v));
const missing=v=>Object.values(v).some(x=>x===null);
/** Items are the server-captured 022/035/040 projection, not arbitrary browser references. */
export function resolveBusinessCompletion(value,{model,items}={}){
 need(['55','65'].includes(model)&&Array.isArray(items)&&items.length>=1&&items.length<=250);
 need(exact(value,['operation','recipient','items','totals','payments','transport_mode','excluded_groups','homologation_labels','additional_information']));
 const x=value,op=x.operation;
 need(exact(op,['tpNF','idDest','finNFe','indFinal','indPres'])&&choice(op.tpNF,['1'])&&choice(op.idDest,['1'])&&choice(op.finNFe,['1'])&&choice(op.indFinal,model==='65'?['1']:['0','1'])&&choice(op.indPres,['1']));
 need(exact(x.recipient,['municipality_code','indIEDest'])&&(x.recipient.municipality_code===null||typeof x.recipient.municipality_code==='string'&&/^35[0-9]{5}$/.test(x.recipient.municipality_code))&&choice(x.recipient.indIEDest,model==='65'?['9']:['1','2','9']));
 need(Array.isArray(x.items)&&x.items.length===items.length&&exact(x.totals,COMPLETION_TOTAL_FIELDS)&&Object.values(x.totals).every(money));
 need(exact(x.payments,['items','change'])&&Array.isArray(x.payments.items)&&x.payments.items.length<=100&&money(x.payments.change));
 for(const p of x.payments.items)need(exact(p,['type','timing','amount'])&&choice(p.type,['01','15'])&&choice(p.timing,['0','1'])&&money(p.amount));
 need(choice(x.transport_mode,['0','1','2','3','4','9'])&&exact(x.excluded_groups,COMPLETION_EXCLUDED_FIELDS)&&Object.values(x.excluded_groups).every(v=>choice(v,['not_included_in_profile']))&&choice(x.homologation_labels,['apply_test_labels'])&&text(x.additional_information,2000));
 const general=['ARITHMETIC_NOT_CHECKED','TAX_APPLICABILITY_UNVERIFIED','RTC_APPLICABILITY_UNVERIFIED','NUMBERING_NOT_BOUND','XML_NOT_GENERATED'];
 if(missing(op))general.push('OPERATION_UNPREPARED');if(missing(x.recipient))general.push('RECIPIENT_UNPREPARED');if(missing(x.totals))general.push('TOTALS_UNPREPARED');
 if(!x.payments.items.length||x.payments.change===null||x.payments.items.some(missing))general.push('PAYMENTS_UNPREPARED');
 if(x.transport_mode===null)general.push('TRANSPORT_UNPREPARED');if(missing(x.excluded_groups))general.push('EXCLUDED_GROUPS_UNREVIEWED');if(x.homologation_labels===null)general.push('HOMOLOGATION_LABELS_UNREVIEWED');
 const seen=new Set(),pendingItems=[];
 for(const [n,i]of x.items.entries()){
  const basis=items[n];need(exact(basis,['item_id','position','cest','csosn'])&&typeof basis.item_id==='string'&&UUID.test(basis.item_id)&&basis.position===n+1&&choice(basis.csosn,model==='65'?['102','500']:['101','102','500'])&&(basis.cest===null||typeof basis.cest==='string'&&/^[0-9]{7}$/.test(basis.cest)));
  need(exact(i,['item_id','tributary','allocations','cest_absence','icms'])&&i.item_id===basis.item_id&&!seen.has(i.item_id));seen.add(i.item_id);
  need(exact(i.tributary,['unit','quantity','unit_price'])&&text(i.tributary.unit,6)&&decimal(i.tributary.quantity,6,true)&&decimal(i.tributary.unit_price,10));
  need(exact(i.allocations,['global_discount','freight','other'])&&Object.values(i.allocations).every(money)&&choice(i.cest_absence,['omit'])&&(basis.cest===null||i.cest_absence===null));
  need(exact(i.icms,['credit','groups500']));const credit=i.icms.credit,g=i.icms.groups500;
  need(credit===null||exact(credit,['base','amount'])&&Object.values(credit).every(money));
  need(g===null||exact(g,['retention','fcp','effective'])&&Object.values(g).every(v=>choice(v,['include','omit'])));
  need((basis.csosn==='101'||credit===null)&&(basis.csosn==='500'||g===null));
  const codes=[];if(missing(i.tributary))codes.push('TRIBUTARY_UNPREPARED');
  if(i.tributary.quantity!==null&&/[1-9]/.test((i.tributary.quantity.split('.')[1]??'').slice(4)))codes.push('QUANTITY_PRECISION_REVIEW');
  if(missing(i.allocations))codes.push('ALLOCATIONS_UNPREPARED');if(basis.cest===null&&i.cest_absence===null)codes.push('CEST_OMISSION_UNREVIEWED');
  if(basis.csosn===null)codes.push('ICMS_BRANCH_UNPREPARED');if(basis.csosn==='101'&&(credit===null||missing(credit)))codes.push('CREDIT_UNPREPARED');if(basis.csosn==='500'&&(g===null||missing(g)))codes.push('RETENTION_GROUPS_UNREVIEWED');
  pendingItems.push({item_id:i.item_id,position:n+1,codes});
 }
 // Validate bounded shapes before serializing; malformed huge/cyclic objects cannot
 // force an unbounded stringify merely to discover that they are outside the profile.
 let encoded;try{encoded=JSON.stringify(value);}catch{throw new BusinessCompletionError();}need(new TextEncoder().encode(encoded).length<=524288);
 return{completion:structuredClone(x),pending:{general,items:pendingItems}};
}
