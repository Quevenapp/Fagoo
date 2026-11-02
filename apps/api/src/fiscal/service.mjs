import { createHash, randomUUID } from 'node:crypto';
import { invoiceImportCandidates, InvoiceImportError, IMPORT_MAX_BYTES } from '../../../../packages/fiscal-xml/invoice-import.mjs';
import { isValidCnpj, inspectAccessKey } from '../../../../packages/fiscal-core/identity.mjs';
import { assert, BusinessError, object, uuid, text, quantity, price, money, date, version } from '../../../../packages/domain/decimal.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const first = result => result.rows[0];
const json = value => JSON.stringify(value);
const canonical = value => value === null || typeof value !== 'object' ? json(value) : Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : `{${Object.keys(value).sort().map(k=>`${json(k)}:${canonical(value[k])}`).join(',')}}`;
const REGIMES=['unconfigured','simples_nacional','lucro_presumido','lucro_real'];
function permit(actor,scope){assert(actor&&typeof actor.id==='string'&&actor.id&&Array.isArray(actor.scopes),'AUTH_REQUIRED',401);uuid(actor.companyId);assert(actor.scopes.includes('*')||actor.scopes.includes(scope),'FORBIDDEN',403);}
function found(row){assert(row,'NOT_FOUND',404);return row;}
function publicInvoice(row){const{object_key,normalized,...invoice}=row;return invoice;}
const validation=(signed)=>({xml_structure_checked:true,access_key_checked:true,declared_authorization:true,signature_present:signed,signature_verified:false,sefaz_checked:false,xsd_validated:false,tax_rules_validated:false,stock_effects_performed:false,financial_effects_performed:false});

export function createFiscalService({pool,storage}) {
  async function run(actor,scope,action,input,operation){
    permit(actor,scope);const commandId=uuid(input.command_id),requestHash=hash(canonical(input));const client=pool.connect?await pool.connect():pool;
    try{
      await client.query('BEGIN');
      // Same lock/order as commercial commands: later events cannot commit first.
      found(first(await client.query('SELECT id FROM fagoo.company WHERE id=$1 FOR NO KEY UPDATE',[actor.companyId])));
      await client.query('INSERT INTO fagoo.command(company_id,id,actor_id,action,request_hash) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',[actor.companyId,commandId,actor.id,action,requestHash]);
      const prior=first(await client.query('SELECT * FROM fagoo.command WHERE company_id=$1 AND id=$2 FOR UPDATE',[actor.companyId,commandId]));assert(prior.actor_id===actor.id&&prior.action===action&&prior.request_hash===requestHash,'COMMAND_REUSED',409);
      if(prior.result!==null){await client.query('COMMIT');return{...prior.result,replayed:true};}
      const result={...await operation(client),command_id:commandId,replayed:false};await client.query('UPDATE fagoo.command SET result=$3::jsonb WHERE company_id=$1 AND id=$2',[actor.companyId,commandId,json(result)]);
      await client.query('INSERT INTO fagoo.audit(company_id,actor_id,command_id,action,resource_id) VALUES($1,$2,$3,$4,$5)',[actor.companyId,actor.id,commandId,action,result.invoice?.id??null]);await client.query('COMMIT');return result;
    }catch(error){await client.query('ROLLBACK').catch(()=>{});if(error instanceof InvoiceImportError)throw new BusinessError(400,error.reason,{field:error.field});if(error.code==='23505')throw new BusinessError(409,'ALREADY_EXISTS');throw error;}
    finally{client.release?.();}
  }
  async function candidates(actor,invoice){
    if(!actor.scopes.includes('*')&&!actor.scopes.includes('catalog:read'))return{items:[],available:false};
    const normalized={...invoice.normalized,items:invoice.normalized?.items??[]};const codes=[...new Set(normalized.items.map(i=>i.code).filter(Boolean))];const gtins=[...new Set(normalized.items.map(i=>i.gtin).filter(g=>g&&g!=='SEM GTIN'))];
    const matches=(await pool.query(`SELECT p.id,p.code,p.name,p.unit,p.gtin,s.supplier_id,s.code AS supplier_code,s.unit_factor FROM fagoo.product p LEFT JOIN fagoo.product_supplier s ON s.company_id=p.company_id AND s.product_id=p.id AND s.supplier_id IN (SELECT id FROM fagoo.contact WHERE company_id=$1 AND upper(regexp_replace(coalesce(document,''),'[^A-Za-z0-9]','','g'))=$4) WHERE p.company_id=$1 AND p.active=true AND (p.code=ANY($2::text[]) OR p.gtin=ANY($3::text[]) OR s.code=ANY($2::text[])) ORDER BY p.id,s.supplier_id LIMIT 2001`,[actor.companyId,codes,gtins,invoice.supplier_document])).rows;
    assert(matches.length<=2000,'TOO_MANY_PRODUCT_CANDIDATES',409);
    return{available:true,items:normalized.items.map(item=>({position:item.position,candidates:matches.flatMap(p=>{
      const by=[];if(item.code&&p.supplier_code===item.code)by.push('supplier_code');if(item.gtin&&item.gtin!=='SEM GTIN'&&p.gtin===item.gtin)by.push('gtin');if(item.code&&p.code===item.code)by.push('internal_code');if(!by.length)return[];
      return[{product_id:p.id,code:p.code,name:p.name,unit:p.unit,matched_by:by,supplier_id:p.supplier_id,unit_factor:p.supplier_code===item.code?p.unit_factor:null,unit_requires_review:p.unit!==item.unit}];
    })}))};
  }
  return{
    async configuration(actor){permit(actor,'fiscal:read');const company=found(first(await pool.query('SELECT id,name,document,tax_regime,fiscal_version FROM fagoo.company WHERE id=$1',[actor.companyId])));return{company,capabilities:{xml_import:Boolean(storage&&company.document),private_storage:Boolean(storage),issuance:false,automatic_distribution:false,tax_calculation:false,signature_verification:false}};},
    async configure(actor,input){
      object(input,['command_id','expected_version','document','tax_regime']);const document=text(input.document,20).replace(/[.\/-]/g,'').toUpperCase();assert(isValidCnpj(document),'CNPJ_INVALID');assert(REGIMES.includes(input.tax_regime),'TAX_REGIME_INVALID');
      return run(actor,'system:write','company.fiscal.configure',input,async client=>{
        const old=found(first(await client.query('SELECT document,fiscal_version FROM fagoo.company WHERE id=$1 FOR UPDATE',[actor.companyId])));assert(old.fiscal_version===version(input.expected_version),'VERSION_CONFLICT',409);
        if(old.document&&old.document!==document)assert(!first(await client.query('SELECT id FROM fagoo.received_invoice WHERE company_id=$1 LIMIT 1',[actor.companyId])),'COMPANY_DOCUMENT_LOCKED',409);
        const company=first(await client.query('UPDATE fagoo.company SET document=$2,tax_regime=$3,fiscal_version=fiscal_version+1 WHERE id=$1 RETURNING id,name,document,tax_regime,fiscal_version',[actor.companyId,document,input.tax_regime]));return{company};
      });
    },
    async importXml(actor,input){
      object(input,['command_id','xml']);assert(typeof input.xml==='string'&&input.xml.length>0,'XML_REQUIRED');assert(Buffer.byteLength(input.xml,'utf8')<=IMPORT_MAX_BYTES,'XML_TOO_LARGE',413);
      return run(actor,'fiscal:write','invoice.import',input,async client=>{
        assert(storage&&typeof storage.put==='function'&&typeof storage.get==='function','PRIVATE_STORAGE_NOT_CONFIGURED',503);
        const company=found(first(await client.query('SELECT document FROM fagoo.company WHERE id=$1 FOR SHARE',[actor.companyId])));assert(company.document,'COMPANY_DOCUMENT_NOT_CONFIGURED',409);
        const encoding=/^\s*<\?xml[^>]*encoding\s*=\s*['"]([^'"]+)['"]/i.exec(input.xml)?.[1];assert(!encoding||/^utf-8$/i.test(encoding),'XML_ENCODING_UNSUPPORTED');
        const parsed=invoiceImportCandidates(input.xml);assert(parsed.model==='55'&&parsed.as_emitter.direction==='1','RECEIVED_DOCUMENT_UNSUPPORTED');assert(parsed.recipient_document===company.document,'INVOICE_RECIPIENT_MISMATCH',403);
        const identity=inspectAccessKey(parsed.key);assert(identity.valid&&identity.parts.cnpj===parsed.emitter_document&&identity.parts.model===parsed.model,'ACCESS_KEY_INVALID');
        const note=parsed.as_emitter;assert(identity.parts.number===String(note.number).padStart(9,'0')&&identity.parts.series===String(note.series).padStart(3,'0')&&identity.parts.yearMonth===note.issue_date.slice(2,4)+note.issue_date.slice(5,7),'ACCESS_KEY_IDENTITY_MISMATCH');
        const total=money(parsed.total);date(note.issue_date);const flags=validation(parsed.signed);
        // Keep issuer tax fields unchanged. Entry treatment is a separate reviewed decision.
        const items=note.items.map(item=>({...item,quantity:quantity(item.quantity,true),unit_price:price(item.unit_price),...(item.declared_product_total?{declared_product_total:money(item.declared_product_total)}:{})}));
        const normalized={model:parsed.model,series:note.series,number:note.number,supplier:parsed.as_recipient.recipient,recipient_document:parsed.recipient_document,issued_on:note.issue_date,protocol:parsed.protocol,items,installments:note.payment.installments,freight:note.freight,insurance:note.insurance,discount:note.discount,other_expenses:note.other_expenses,total};
        const bytes=Buffer.from(input.xml,'utf8'),sha=hash(bytes);const existing=first(await client.query('SELECT * FROM fagoo.received_invoice WHERE company_id=$1 AND access_key=$2 FOR UPDATE',[actor.companyId,parsed.key]));
        if(existing){assert(existing.xml_sha256===sha,'XML_CONFLICT_FOR_ACCESS_KEY',409);return{invoice:publicInvoice(existing),items:existing.normalized.items,validation:existing.validation,already_imported:true};}
        const key=`companies/${actor.companyId}/received-invoices/${sha}.xml`;await storage.put(key,bytes,{contentType:'application/xml; charset=utf-8',sha256:sha});
        const invoice=first(await client.query("INSERT INTO fagoo.received_invoice(company_id,id,access_key,supplier_document,number,issued_on,total,document_state,xml_sha256,object_key,normalized,validation,imported_by) VALUES($1,$2,$3,$4,$5,$6,$7,'xml_available',$8,$9,$10::jsonb,$11::jsonb,$12) ON CONFLICT(company_id,access_key) DO NOTHING RETURNING *",[actor.companyId,randomUUID(),parsed.key,parsed.emitter_document,note.number,note.issue_date,total,sha,key,json(normalized),json(flags),actor.id]));
        if(!invoice){const concurrent=found(first(await client.query('SELECT * FROM fagoo.received_invoice WHERE company_id=$1 AND access_key=$2',[actor.companyId,parsed.key])));assert(concurrent.xml_sha256===sha,'XML_CONFLICT_FOR_ACCESS_KEY',409);return{invoice:publicInvoice(concurrent),items:concurrent.normalized.items,validation:concurrent.validation,already_imported:true};}
        await client.query("INSERT INTO fagoo.event(company_id,type,resource_id,payload) VALUES($1,'invoice.received',$2,$3::jsonb)",[actor.companyId,invoice.id,json({invoice_id:invoice.id,signature_verified:false,tax_review:'pending'})]);return{invoice:publicInvoice(invoice),items,validation:flags,already_imported:false};
      });
    },
    async detail(actor,id){permit(actor,'fiscal:read');const invoice=found(first(await pool.query('SELECT * FROM fagoo.received_invoice WHERE company_id=$1 AND id=$2',[actor.companyId,uuid(id)])));return{invoice:publicInvoice(invoice),items:invoice.normalized.items??[],document:invoice.normalized,product_candidates:await candidates(actor,invoice)};},
    async xml(actor,id){permit(actor,'fiscal:read');assert(storage,'PRIVATE_STORAGE_NOT_CONFIGURED',503);const invoice=found(first(await pool.query('SELECT access_key,xml_sha256,object_key FROM fagoo.received_invoice WHERE company_id=$1 AND id=$2',[actor.companyId,uuid(id)])));assert(invoice.object_key,'XML_NOT_AVAILABLE',409);const bytes=await storage.get(invoice.object_key);assert(bytes instanceof Uint8Array&&hash(bytes)===invoice.xml_sha256,'XML_INTEGRITY_FAILED',502);return{bytes,filename:`NFe-${invoice.access_key}.xml`};}
  };
}
