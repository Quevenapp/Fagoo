/** Preferências (migration 115): field kinds, value validation and page schema helpers shared by the API boundary,
 * the browser renderer and the SQL generator. The SQL catalog in erp_preferences.definition is authoritative; a PGlite
 * parity test keeps it identical to these schemas. Values never carry floats: integers are small whole numbers and
 * decimals travel as strings. */
export const PREFERENCE_ROLES=Object.freeze(['admin','consulta','vendas','financeiro','estoque','fiscal']);
export const PREFERENCE_KINDS=Object.freeze(['toggle','choice','multi','integer','decimal','text','textarea','users','keymap','documents']);
export const PREFERENCE_SCOPES=Object.freeze(['company','user']);
// 264: 'digits' (only digits, from minLength or 1 to maxLength; empty means not informed).
export const PREFERENCE_FORMATS=Object.freeze(['plain','email','email_list','digits']);
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const KEY=/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const PAGE=/^[a-z][a-z0-9-]{1,47}$/;
const SECTION=/^[a-z][a-z0-9-]{0,39}$/;
// Same character classes as the SQL checks: [[:cntrl:]] for single-line text, every control except LF for text areas.
const CONTROL=/[\u0000-\u001f\u007f]/;
const AREA_CONTROL=/[\u0000-\u0009\u000b-\u001f\u007f]/;
const EMAIL=/^[^@ ]+@[^@ ]+\.[^@ ]+$/;
// Leading or trailing blanks are refused, exactly like btrim() in SQL (controls are refused separately).
const EDGE_SPACE=/^ | $/,EDGE_AREA=/^[ \n]|[ \n]$/;
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v));
const bad=message=>{throw new Error(message);};

export const preferenceUuid=v=>typeof v==='string'&&v.length===36&&UUID.test(v);
export const preferenceKey=v=>typeof v==='string'&&v.length<=80&&KEY.test(v);
export const preferencePageId=v=>typeof v==='string'&&PAGE.test(v);

/** CPF and CNPJ check digits, identical to erp_catalog.valid_cpf / valid_cnpj (migration 096). */
export function validCpf(value){
 if(typeof value!=='string'||!/^[0-9]{11}$/.test(value)||/^([0-9])\1{10}$/.test(value))return false;
 for(const n of[9,10]){let sum=0;for(let i=1;i<=n;i++)sum+=Number(value[i-1])*(n+2-i);let digit=(sum*10)%11;if(digit===10)digit=0;if(digit!==Number(value[n]))return false;}
 return true;
}
export function validCnpj(value){
 if(typeof value!=='string'||!/^[A-Z0-9]{12}[0-9]{2}$/.test(value)||/^([0-9])\1{13}$/.test(value))return false;
 let base=value.slice(0,12);
 for(let j=0;j<2;j++){let sum=0,weight=2;for(let i=base.length-1;i>=0;i--){sum+=(base.charCodeAt(i)-48)*weight;weight=weight===9?2:weight+1;}const rest=sum%11;base+=String(rest<2?0:11-rest);}
 return base===value;
}
export const validPersonDocument=v=>validCpf(v)||validCnpj(v);

const optionValues=field=>field.kind==='keymap'?null:(field.options??[]).map(o=>o[0]);
// 299: a multi field with `situations` also takes, after its options, the ids of custom situações of that document kind
// (Sistema › Gerenciador de transições): lower-case UUIDs, ascending, distinct, up to the 30 situações of a kind.
export const PREFERENCE_SITUATION_KINDS=Object.freeze(['sales_orders','purchase_orders','service_orders']);
export const PREFERENCE_SITUATION_IDS=30;
/** The custom situação ids of a multi value (empty for a field without `situations`). */
export const preferenceSituationIds=(field,value)=>field.situations&&Array.isArray(value)?value.filter(v=>!optionValues(field).includes(v)):[];
/** Validation mirrored by erp_preferences.value_valid. Membership of user ids is checked by the server at save time. */
export function preferenceValueValid(field,value){
 switch(field.kind){
  case'toggle':return typeof value==='boolean';
  case'choice':return typeof value==='string'&&optionValues(field).includes(value);
  case'multi':{
   if(!Array.isArray(value))return false;
   const allowed=optionValues(field);
   if(field.situations){
    if(value.some(v=>typeof v!=='string'))return false;
    const custom=value.filter(v=>!allowed.includes(v)),base=value.filter(v=>allowed.includes(v));
    if(custom.length>PREFERENCE_SITUATION_IDS||custom.some((v,i)=>!preferenceUuid(v)||i>0&&!(custom[i-1]<v))||![...base,...custom].every((v,i)=>v===value[i]))return false;
    value=base;
   }
   if(value.length>field.maxItems)return false;
   if(value.some(v=>typeof v!=='string'||!allowed.includes(v))||new Set(value).size!==value.length)return false;
   // Canonical order is the option order, so the same choice always hashes and compares the same.
   const ordered=allowed.filter(v=>value.includes(v));return ordered.every((v,i)=>v===value[i]);
  }
  case'integer':return Number.isSafeInteger(value)&&Math.abs(value)<1e9&&value>=field.min&&value<=field.max;
  case'decimal':{
   if(typeof value!=='string'||!new RegExp(`^(0|[1-9][0-9]{0,8})(\\.[0-9]{1,${field.scale}})?$`).test(value))return false;
   const whole=BigInt(value.split('.')[0]),fraction=value.includes('.')&&/[1-9]/.test(value.split('.')[1]);
   return whole>=BigInt(field.min)&&(whole<BigInt(field.max)||whole===BigInt(field.max)&&!fraction);
  }
  case'text':{
   if(typeof value!=='string'||value.length>field.maxLength||CONTROL.test(value)||EDGE_SPACE.test(value))return false;
   if(value===''||field.format==='plain')return true;
   if(field.format==='email')return EMAIL.test(value);
   if(field.format==='digits')return /^[0-9]+$/.test(value)&&value.length>=(field.minLength??1);
   const parts=value.split(',').map(v=>v.replace(/^ +| +$/g,''));return parts.length<=field.maxItems&&parts.every(v=>EMAIL.test(v));
  }
  case'textarea':return typeof value==='string'&&value.length<=field.maxLength&&!AREA_CONTROL.test(value)&&!EDGE_AREA.test(value);
  case'users':return Array.isArray(value)&&value.length<=field.maxItems&&value.every(preferenceUuid)&&value.every((v,i)=>i===0||value[i-1]<v);
  case'keymap':{
   if(!plain(value))return false;const keys=Object.keys(value),{actions,keys:allowed}=field.options;
   if(keys.length!==actions.length||actions.some(a=>!Object.hasOwn(value,a)))return false;
   const chosen=actions.map(a=>value[a]);return chosen.every(k=>typeof k==='string'&&allowed.includes(k))&&new Set(chosen).size===chosen.length;
  }
  case'documents':{
   if(!Array.isArray(value)||value.length>field.maxItems)return false;
   const seen=new Set();
   for(const row of value){
    if(!plain(row)||Object.keys(row).length!==2||!Object.hasOwn(row,'document')||!Object.hasOwn(row,'name'))return false;
    if(!validPersonDocument(row.document)||seen.has(row.document))return false;seen.add(row.document);
    if(typeof row.name!=='string'||row.name.length>80||CONTROL.test(row.name)||EDGE_SPACE.test(row.name))return false;
   }
   return true;
  }
  default:return false;
 }
}

/** Structural JSON equality for values (objects compared by keys, arrays by order). */
export function preferenceValueEqual(a,b){
 if(Array.isArray(a)||Array.isArray(b))return Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&a.every((v,i)=>preferenceValueEqual(v,b[i]));
 if(plain(a)||plain(b)){if(!plain(a)||!plain(b))return false;const ka=Object.keys(a).sort(),kb=Object.keys(b).sort();return ka.length===kb.length&&ka.every((k,i)=>k===kb[i]&&preferenceValueEqual(a[k],b[k]));}
 return Object.is(a,b);
}
export function preferenceClone(value){return value===null||typeof value!=='object'?value:JSON.parse(JSON.stringify(value));}

const FIELD_KEYS=['key','section','label','kind','options','default','min','max','scale','maxLength','maxItems','format','widget','hint','group','showIf','status','note','since','minLength','formatSince','situations','migratedDefaults'];
const INFO_KEYS=['id','info','section','label','text','link','status','source','group'];
const freezeDeep=v=>{if(v&&typeof v==='object'){Object.freeze(v);for(const x of Object.values(v))freezeDeep(x);}return v;};
/** Checks a page schema once at import, so a malformed definition never reaches the API or the renderer. */
export function definePage(page){
 if(!plain(page)||!preferencePageId(page.id)||!/^[a-z][a-z0-9-]{1,39}$/.test(page.category)||!/^[a-z][a-z0-9-]{1,39}$/.test(page.path)
  ||typeof page.title!=='string'||!PREFERENCE_SCOPES.includes(page.scope)||!Array.isArray(page.readRoles)||!page.readRoles.length
  ||page.readRoles.some(r=>!PREFERENCE_ROLES.includes(r))||new Set(page.readRoles).size!==page.readRoles.length
  ||typeof page.subsections!=='boolean'||page.since!==undefined&&(typeof page.since!=='string'||!/^1[5-9][0-9]$/.test(page.since))||!Array.isArray(page.sections)||!page.sections.length||!Array.isArray(page.fields))bad(`PREFERENCE_PAGE_INVALID ${page?.id}`);
 const sections=new Set();for(const s of page.sections){if(!plain(s)||!SECTION.test(s.id)||typeof s.title!=='string'||sections.has(s.id))bad(`PREFERENCE_SECTION_INVALID ${page.id}`);sections.add(s.id);}
 const keys=new Set(),infos=new Set();let since=page.since??'115';
 for(const f of page.fields){
  if(!plain(f)||!sections.has(f.section))bad(`PREFERENCE_FIELD_SECTION ${page.id} ${f?.key??f?.id}`);
  if(f.info){
   if(Object.keys(f).some(k=>!INFO_KEYS.includes(k))||typeof f.id!=='string'||infos.has(f.id)||!['applied','unavailable'].includes(f.status)||typeof f.label!=='string'||typeof f.text!=='string')bad(`PREFERENCE_INFO_INVALID ${page.id} ${f.id}`);
   if(f.link!==undefined&&(!plain(f.link)||typeof f.link.label!=='string'||typeof f.link.to!=='string'||!f.link.to.startsWith('/')||f.link.roles!==undefined&&(!Array.isArray(f.link.roles)||f.link.roles.some(r=>!PREFERENCE_ROLES.includes(r)))))bad(`PREFERENCE_INFO_LINK ${page.id} ${f.id}`);
   infos.add(f.id);continue;
  }
  if(Object.keys(f).some(k=>!FIELD_KEYS.includes(k))||!preferenceKey(f.key)||keys.has(f.key)||!PREFERENCE_KINDS.includes(f.kind)||typeof f.label!=='string'||!['stored','applied'].includes(f.status))bad(`PREFERENCE_FIELD_INVALID ${page.id} ${f?.key}`);
  if(['choice','multi'].includes(f.kind)&&(!Array.isArray(f.options)||!f.options.length||f.options.some(o=>!Array.isArray(o)||o.length!==2||!/^[a-z0-9][a-z0-9_]{0,39}$/.test(o[0])||typeof o[1]!=='string')||new Set(f.options.map(o=>o[0])).size!==f.options.length))bad(`PREFERENCE_OPTIONS_INVALID ${f.key}`);
  if(f.kind==='keymap'&&(!plain(f.options)||!Array.isArray(f.options.actions)||!Array.isArray(f.options.keys)||!Array.isArray(f.options.labels)||f.options.labels.length!==f.options.actions.length))bad(`PREFERENCE_KEYMAP_INVALID ${f.key}`);
  if(f.kind==='multi'&&!Number.isInteger(f.maxItems))f.maxItems=f.options.length;
  // 299: {kind, bases}: the custom situações of the kind are options too; bases maps an option to the status it already covers.
  if(f.situations!==undefined&&(f.kind!=='multi'||!plain(f.situations)||Object.keys(f.situations).length!==2||!PREFERENCE_SITUATION_KINDS.includes(f.situations.kind)||!plain(f.situations.bases)
   ||Object.entries(f.situations.bases).some(([o,s])=>!f.options.some(x=>x[0]===o)||typeof s!=='string'||!/^[a-z_]{2,40}$/.test(s))))bad(`PREFERENCE_SITUATIONS_INVALID ${f.key}`);
  if(['integer','decimal'].includes(f.kind)&&(!Number.isInteger(f.min)||!Number.isInteger(f.max)||f.min>f.max))bad(`PREFERENCE_BOUNDS_INVALID ${f.key}`);
  if(f.kind==='decimal'&&(!Number.isInteger(f.scale)||f.scale<1||f.scale>6))bad(`PREFERENCE_SCALE_INVALID ${f.key}`);
  if(['text','textarea'].includes(f.kind)&&(!Number.isInteger(f.maxLength)||f.maxLength<1||f.maxLength>4000))bad(`PREFERENCE_LENGTH_INVALID ${f.key}`);
  if(f.kind==='text'){f.format??='plain';if(!PREFERENCE_FORMATS.includes(f.format)||f.format==='email_list'&&!Number.isInteger(f.maxItems))bad(`PREFERENCE_FORMAT_INVALID ${f.key}`);}
  // 264: minLength only with 'digits'; formatSince is the migration that turned an applied 'plain' field into its current format.
  if(f.minLength!==undefined&&(f.format!=='digits'||!Number.isInteger(f.minLength)||f.minLength<1||f.minLength>f.maxLength))bad(`PREFERENCE_MIN_LENGTH_INVALID ${f.key}`);
  if(f.formatSince!==undefined&&(f.kind!=='text'||f.format==='plain'||typeof f.formatSince!=='string'||!/^[12][0-9]{2}$/.test(f.formatSince)||f.formatSince<=(f.since??page.since??'115')))bad(`PREFERENCE_FORMAT_SINCE_INVALID ${f.key}`);
  if(['users','documents'].includes(f.kind)&&!Number.isInteger(f.maxItems))bad(`PREFERENCE_ITEMS_INVALID ${f.key}`);
  if(!preferenceValueValid(f,f.default))bad(`PREFERENCE_DEFAULT_INVALID ${f.key}`);
  if(f.migratedDefaults!==undefined&&(!Array.isArray(f.migratedDefaults)||!f.migratedDefaults.length||f.migratedDefaults.length>4||f.migratedDefaults.some(v=>!preferenceValueValid(f,v))))bad(`PREFERENCE_MIGRATED_DEFAULT_INVALID ${f.key}`);
  if(f.showIf!==undefined&&(!plain(f.showIf)||!keys.has(f.showIf.key)))bad(`PREFERENCE_SHOW_IF_INVALID ${f.key}`);
  // A key added to an applied page by a later migration (`since`) comes after the keys already applied, so their ordinals never move.
  if(f.since!==undefined&&(typeof f.since!=='string'||!/^(1[5-9][0-9]|2[0-9]{2})$/.test(f.since)||f.since<=(page.since??'115')))bad(`PREFERENCE_SINCE_INVALID ${f.key}`);
  if((f.since??page.since??'115')<since)bad(`PREFERENCE_SINCE_ORDER ${f.key}`);since=f.since??since;
  keys.add(f.key);
 }
 return freezeDeep({...page,storedKeys:[...keys]});
}

export const storedFields=page=>page.fields.filter(f=>!f.info);
/** Migration that inserts a stored field: its own `since` or the page's (absent: 115). */
export const fieldMigration=(page,field)=>field.since??page.since??'115';
/** The field as a migration applied it: before its `formatSince`, a text field still had the format 'plain' and no minLength. */
export const fieldAt=(field,migration='999')=>field.formatSince&&migration<field.formatSince?Object.freeze({...field,format:'plain',minLength:undefined}):field;
/** The SQL row each stored field becomes (erp_preferences.definition), in page order. */
/** `migration` (default: the latest) gives the rows as that migration wrote them (see fieldAt); min_length only when set. */
export function definitionRows(page,migration='999'){
 return storedFields(page).map(field=>fieldAt(field,migration)).map((f,i)=>({key:f.key,page_id:page.id,section:f.section,ordinal:i+1,kind:f.kind,
  options:f.kind==='keymap'?{actions:[...f.options.actions],keys:[...f.options.keys]}:['choice','multi'].includes(f.kind)?f.options.map(o=>o[0]):null,
  default_value:f.default,min_value:f.min??null,max_value:f.max??null,scale:f.scale??null,max_length:f.maxLength??null,
  max_items:['multi','users','documents'].includes(f.kind)||f.format==='email_list'?f.maxItems:null,format:f.kind==='text'?f.format:null,...(f.minLength!==undefined?{min_length:f.minLength}:{})}));
}

// Who reads each page: the roles that read the module the page configures (same lists as apps/erp/src/lib/origin-menu.ts).
export const PREFERENCE_READERS=Object.freeze({
 all:PREFERENCE_ROLES,
 products:Object.freeze(['admin','consulta','vendas','estoque','fiscal']),
 stock:Object.freeze(['admin','consulta','vendas','estoque','fiscal']),
 purchases:Object.freeze(['admin','consulta','financeiro','estoque','fiscal']),
 proposals:Object.freeze(['admin','consulta','financeiro','vendas']),
 services:Object.freeze(['admin','consulta','financeiro','vendas']),
 pdv:Object.freeze(['admin','consulta','vendas']),
 fiscal:Object.freeze(['admin','consulta','fiscal']),
 finance:Object.freeze(['admin','consulta','financeiro']),
 accountant:Object.freeze(['admin','financeiro','fiscal']),
 certificate:Object.freeze(['admin','fiscal']),
});

// Reusable option lists (Origin labels).
export const BOOLEAN_YES_NO=[['sim','Sim'],['nao','Não']];
export const HEADER_TYPES=[['padrao','Padrão do Sistema'],['personalizado','Personalizado']];
export const NOT_APPLIED='Guardado. O FAGOO ainda não segue esta opção; ela passa a valer quando a função correspondente existir.';
