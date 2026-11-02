/** Explicit tax decisions for a limited preparation profile. No calculation or XML. */
export const TAX_PREPARATION_PROFILE='sn-internal-sale-preparation-v1';
export const TAX_PREPARATION_FLAGS=Object.freeze({operational_effects:false,calculation_performed:false,xml_generated:false,transmitted:false,can_emit:false,tax_rules_validated:false,xsd_validated:false});
export const TAX_MONEY=/^(?:0|[1-9][0-9]{0,12})\.[0-9]{2}$/;
export const TAX_RATE=/^(?:0|[1-9][0-9]{0,2})\.[0-9]{2,4}$/;
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const exact=(v,keys)=>object(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
export class TaxPreparationError extends Error{constructor(code='FISCAL_TAX_INVALID_DECISIONS'){super(code);this.code=code;}}
const fail=code=>{throw new TaxPreparationError(code);};
const note=v=>v===null||typeof v==='string'&&[...v].length>=3&&[...v].length<=1000&&!/[\u0000-\u001f\u007f]/u.test(v)&&/\S/u.test(v);
const decimal=(v,kind)=>v===null||typeof v==='string'&&(kind==='rate'?TAX_RATE:TAX_MONEY).test(v);
function amounts(v,keys,rates=[]){return exact(v,keys)&&keys.every(k=>decimal(v[k],rates.includes(k)?'rate':'money'));}
export function validateTaxDecisions(decisions,model=null){
 if(!Array.isArray(decisions)||decisions.length>250)fail();const ids=new Set();
 for(const d of Array.from(decisions)){
  if(!exact(d,['item_id','cfop','icms','pis','cofins','review_note'])||typeof d.item_id!=='string'||!UUID.test(d.item_id)||ids.has(d.item_id)||!note(d.review_note))fail();ids.add(d.item_id);
  if(d.cfop!==null&&!['5102','5405'].includes(d.cfop))fail('FISCAL_TAX_UNSUPPORTED_BRANCH');
  const c=d.icms;
  if(c!==null){
   if(!object(c))fail();
   if(c.csosn==='102'){if(!exact(c,['csosn']))fail();}
   else if(c.csosn==='101'){
    if(model==='65')fail('FISCAL_TAX_UNSUPPORTED_BRANCH');
    if(!exact(c,['csosn','credit_rate','credit_period','credit_evidence'])||!decimal(c.credit_rate,'rate')||!note(c.credit_evidence)
     ||!(c.credit_period===null||typeof c.credit_period==='string'&&/^[1-9][0-9]{3}-(?:0[1-9]|1[0-2])$/.test(c.credit_period)))fail();
   }else if(c.csosn==='500'){
    if(!exact(c,['csosn','retention','fcp','effective'])
     ||!amounts(c.retention,['base','rate','substitute_icms','retained_icms'],['rate'])
     ||!amounts(c.fcp,['base','rate','amount'],['rate'])
     ||!amounts(c.effective,['reduction_rate','base','rate','amount'],['rate','reduction_rate']))fail();
   }else fail('FISCAL_TAX_UNSUPPORTED_BRANCH');
  }
  for(const k of ['pis','cofins'])if(d[k]!==null&&(!exact(d[k],['cst','base','rate','amount'])||d[k].cst!=='49'||!decimal(d[k].base,'money')||!decimal(d[k].rate,'rate')||!decimal(d[k].amount,'money')))fail('FISCAL_TAX_UNSUPPORTED_BRANCH');
 }
 return structuredClone(decisions);
}
export function resolveTaxItems({model,items,decisions}){
 if(!['55','65'].includes(model)||!Array.isArray(items)||items.length<1||items.length>250)fail('FISCAL_TAX_INVALID_BASIS');
 const choices=validateTaxDecisions(decisions,model),byId=new Map(choices.map(i=>[i.item_id,i])),seen=new Set();
 for(const [index,i] of items.entries()){if(!object(i)||typeof i.item_id!=='string'||!UUID.test(i.item_id)||seen.has(i.item_id)||i.position!==index+1||!(i.product_id===null||typeof i.product_id==='string'&&UUID.test(i.product_id))||!exact(i.identifiers,['ncm','origin','cest','gtin','gtin_tax']))fail('FISCAL_TAX_INVALID_BASIS');seen.add(i.item_id);}
 if(choices.some(d=>!seen.has(d.item_id)))fail('FISCAL_TAX_FOREIGN_ITEM');
 return items.map(i=>{
  const d=byId.get(i.item_id)||{item_id:i.item_id,cfop:null,icms:null,pis:null,cofins:null,review_note:null};
  const pending=['ACCOUNTING_REVIEW_REQUIRED','CFOP_APPLICABILITY_UNVERIFIED','TAX_CLASSIFICATION_UNVERIFIED','IPI_APPLICABILITY_UNREVIEWED','RTC_APPLICABILITY_UNREVIEWED','TRIBUTARY_VALUES_UNPREPARED','TAX_VALUES_NOT_CALCULATED'];
  if(d.cfop===null)pending.push('CFOP_UNPREPARED');
  if(d.icms===null)pending.push('ICMS_UNPREPARED');
  else if(d.icms.csosn==='101'){
   if(d.icms.credit_rate===null)pending.push('CREDIT_RATE_UNPREPARED');
   if(d.icms.credit_period===null||d.icms.credit_evidence===null)pending.push('CREDIT_BASIS_UNPREPARED');
   pending.push('CREDIT_ENTITLEMENT_UNVERIFIED','CREDIT_AMOUNT_NOT_CALCULATED');
  }else if(d.icms.csosn==='500')pending.push('RETENTION_APPLICABILITY_UNREVIEWED');
  if(d.pis===null)pending.push('PIS_UNPREPARED');else pending.push('PIS_DECLARED_VALUES_UNVERIFIED');
  if(d.cofins===null)pending.push('COFINS_UNPREPARED');else pending.push('COFINS_DECLARED_VALUES_UNVERIFIED');
  if(i.product_id===null)pending.push('FREE_ITEM_REQUIRES_REVIEW');
  return{item_id:i.item_id,position:i.position,product_id:i.product_id,identifiers:structuredClone(i.identifiers),
   decisions:structuredClone(d),provenance:{cfop:d.cfop===null?'unreviewed':'manual',icms:d.icms===null?'unreviewed':'manual',pis:d.pis===null?'unreviewed':'manual',cofins:d.cofins===null?'unreviewed':'manual'},pending};
 });
}
