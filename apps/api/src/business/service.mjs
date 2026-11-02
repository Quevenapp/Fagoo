import { randomUUID, createHash } from 'node:crypto';
import { BusinessError, assert, scaled, formatted, quantity, price, money, lineTotal, baseQuantity, uuid, text, date, version, object } from '../../../../packages/domain/decimal.mjs';

const json = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v);
const canonical = value => value === null || typeof value !== 'object' ? json(value) : Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : `{${Object.keys(value).sort().map(k => `${json(k)}:${canonical(value[k])}`).join(',')}}`;
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
const count = value => { const n = Number(value); assert(Number.isSafeInteger(n) && n >= 0, 'COUNT_OUT_OF_RANGE', 500); return n; };
const first = result => result.rows[0];
function permission(actor, scope) {
  assert(actor && typeof actor.id === 'string' && actor.id.length > 0 && Array.isArray(actor.scopes), 'AUTH_REQUIRED', 401);
  uuid(actor.companyId);
  assert(actor.scopes.includes('*') || actor.scopes.includes(scope), 'FORBIDDEN', 403);
}
function resource(row) { assert(row, 'NOT_FOUND', 404); return row; }
function expected(row, value) { assert(row.version === version(value), 'VERSION_CONFLICT', 409, { current_version: row.version }); }
function safeDatabaseError(error) {
  if (error instanceof BusinessError) return error;
  if (error.code === '23505') return new BusinessError(409, 'ALREADY_EXISTS');
  if (['23503', '23514', '22003'].includes(error.code)) return new BusinessError(400, 'CONSTRAINT_VIOLATION');
  return error;
}
export function createBusinessService(pool) {
  const query = (sql, args = []) => pool.query(sql, args);
  async function transaction(fn) {
    const client = pool.connect ? await pool.connect() : pool;
    try { await client.query('BEGIN'); const value = await fn(client); await client.query('COMMIT'); return value; }
    catch (error) { await client.query('ROLLBACK').catch(() => {}); throw safeDatabaseError(error); }
    finally { client.release?.(); }
  }
  async function command(actor, scope, action, input, run) {
    permission(actor, scope); const commandId = uuid(input.command_id); const hash = digest(input);
    return transaction(async client => {
      // Sequence allocation must follow commit order within a company's feed.
      // Acquire before command/resource locks; other companies remain independent.
      resource(first(await client.query('SELECT id FROM fagoo.company WHERE id=$1 FOR NO KEY UPDATE', [actor.companyId])));
      await client.query('INSERT INTO fagoo.command(company_id,id,actor_id,action,request_hash) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING', [actor.companyId, commandId, actor.id, action, hash]);
      const prior = first(await client.query('SELECT * FROM fagoo.command WHERE company_id=$1 AND id=$2 FOR UPDATE', [actor.companyId, commandId]));
      assert(prior.actor_id === actor.id && prior.action === action && prior.request_hash === hash, 'COMMAND_REUSED', 409);
      if (prior.result !== null) return { ...prior.result, replayed: true };
      const value = await run(client); const result = { ...value, command_id: commandId, replayed: false };
      await client.query('UPDATE fagoo.command SET result=$3::jsonb WHERE company_id=$1 AND id=$2', [actor.companyId, commandId, json(result)]);
      await client.query('INSERT INTO fagoo.audit(company_id,actor_id,command_id,action,resource_id) VALUES($1,$2,$3,$4,$5)', [actor.companyId, actor.id, commandId, action, value.resource_id ?? null]);
      return result;
    });
  }
  async function emit(client, actor, type, id, payload = {}) {
    await client.query('INSERT INTO fagoo.event(company_id,type,resource_id,payload) VALUES($1,$2,$3,$4::jsonb)', [actor.companyId, type, id, json(payload)]);
  }
  async function pagination(params = {}, filter = {}) {
    const limit = params.limit === undefined ? 100 : Number(params.limit);
    assert(Number.isSafeInteger(limit) && limit >= 1 && limit <= 1000, 'LIMIT_INVALID');
    const filterHash = digest(filter); let offset = 0; let asOf = new Date(first(await query('SELECT clock_timestamp() AS time')).time).toISOString();
    if (params.cursor) {
      assert(typeof params.cursor === 'string' && params.cursor.length < 1024, 'CURSOR_INVALID');
      let decoded; try { decoded = JSON.parse(Buffer.from(params.cursor, 'base64url').toString()); } catch { throw new BusinessError(400, 'CURSOR_INVALID'); }
      assert(decoded.filter === filterHash && Number.isSafeInteger(decoded.offset) && decoded.offset >= 0 && decoded.offset <= 10_000_000 && Number.isFinite(Date.parse(decoded.as_of)), 'CURSOR_INVALID');
      offset = decoded.offset; asOf = decoded.as_of;
    }
    return { limit, offset, asOf, filterHash };
  }
  async function page(sql, args, p, { consistency = 'live' } = {}) {
    const result = await query(`${sql} LIMIT $${args.length + 1} OFFSET $${args.length + 2}`, [...args, p.limit + 1, p.offset]);
    const hasMore = result.rows.length > p.limit; const rows = result.rows.slice(0, p.limit);
    const total = rows.length ? count(rows[0]._total) : 0;
    return { items: rows.map(({ _total, ...row }) => row), total, has_more: hasMore,
      next_cursor: hasMore ? Buffer.from(json({ offset: p.offset + p.limit, as_of: p.asOf, filter: p.filterHash })).toString('base64url') : null,
      as_of: p.asOf, consistency, coverage: { partial: false, paginated: true } };
  }
  async function getOrder(client, actor, id, lock = false) {
    return resource(first(await client.query(`SELECT * FROM fagoo.orders WHERE company_id=$1 AND id=$2${lock ? ' FOR UPDATE' : ''}`, [actor.companyId, uuid(id)])));
  }
  const itemsFor = async (client, actor, id) => (await client.query('SELECT * FROM fagoo.order_item WHERE company_id=$1 AND order_id=$2 ORDER BY position', [actor.companyId, id])).rows;
  async function stockLock(client, actor, warehouse, product) {
    await client.query('INSERT INTO fagoo.stock_balance(company_id,warehouse_id,product_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [actor.companyId, warehouse, product]);
    return first(await client.query('SELECT * FROM fagoo.stock_balance WHERE company_id=$1 AND warehouse_id=$2 AND product_id=$3 FOR UPDATE', [actor.companyId, warehouse, product]));
  }
  async function movement(client, actor, warehouse, product, delta, kind, reference, reason = null) {
    await client.query('INSERT INTO fagoo.stock_movement(company_id,id,warehouse_id,product_id,delta,kind,reference_id,actor_id,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)', [actor.companyId, randomUUID(), warehouse, product, delta, kind, reference, actor.id, reason]);
  }
  async function resolvePrice(client, actor, product, contactId, q, terms) {
    const rows=(await client.query(`SELECT *,CASE WHEN contact_id IS NOT NULL THEN 1 ELSE 0 END AS contact_specific,CASE WHEN payment_terms IS NOT NULL THEN 1 ELSE 0 END AS payment_specific FROM fagoo.price_rule WHERE company_id=$1 AND product_id=$2 AND active=true AND (contact_id IS NULL OR contact_id=$3) AND (payment_terms IS NULL OR payment_terms=$5) AND minimum_quantity<=$4::numeric AND (valid_from IS NULL OR valid_from<=(now() AT TIME ZONE 'America/Sao_Paulo')::date) AND (valid_until IS NULL OR valid_until>=(now() AT TIME ZONE 'America/Sao_Paulo')::date) ORDER BY contact_specific DESC,payment_specific DESC,priority DESC,minimum_quantity DESC,id LIMIT 2`,[actor.companyId,product.id,contactId,q,terms])).rows;
    const rule=rows[0],other=rows[1];
    if(rule&&other&&rule.contact_specific===other.contact_specific&&rule.payment_specific===other.payment_specific&&rule.priority===other.priority&&rule.minimum_quantity===other.minimum_quantity&&rule.unit_price!==other.unit_price)throw new BusinessError(409,'PRICE_RULE_AMBIGUOUS',{product_id:product.id});
    return{unit_price:price(rule?.unit_price??product.sale_price),source:rule?'price_rule':'product_catalog',rule_id:rule?.id??null,rule_version:rule?.version??null};
  }
  const service = {
    async products(actor, params = {}) {
      permission(actor, 'catalog:read'); const q = params.q ? text(params.q, 120) : ''; const p = await pagination(params, { resource: 'products', q });
      return page('SELECT p.*,count(*) OVER() AS _total FROM fagoo.product p WHERE company_id=$1 AND created_at<=$2 AND ($3=\'\' OR name ILIKE $4 OR code ILIKE $4 OR gtin=$3) ORDER BY name,id', [actor.companyId, p.asOf, q, `%${q}%`], p);
    },
    async product(actor, id) { permission(actor, 'catalog:read'); return { product: resource(first(await query('SELECT * FROM fagoo.product WHERE company_id=$1 AND id=$2', [actor.companyId, uuid(id)]))), suppliers:(await query('SELECT s.*,c.name AS supplier_name FROM fagoo.product_supplier s JOIN fagoo.contact c ON c.company_id=s.company_id AND c.id=s.supplier_id WHERE s.company_id=$1 AND s.product_id=$2 ORDER BY c.name,s.supplier_id',[actor.companyId,id])).rows }; },
    async saveProduct(actor, input, id = null) {
      const fields = ['command_id','expected_version','code','name','unit','gtin','ncm','sale_price','cost_price','stock_min','stock_max','lead_days','pack_quantity','active']; object(input, fields);
      return command(actor, 'catalog:write', id ? `product.update:${uuid(id)}` : 'product.create', input, async client => {
        let old = {}; if (id) { old = resource(first(await client.query('SELECT * FROM fagoo.product WHERE company_id=$1 AND id=$2 FOR UPDATE', [actor.companyId, id]))); expected(old, input.expected_version); }
        const value = { ...old, ...input }; const code = text(value.code, 60), name = text(value.name), unit = text(value.unit ?? 'UN', 16);
        const minimum = quantity(value.stock_min ?? '0'), maximum = quantity(value.stock_max ?? '0'); assert(scaled(minimum) <= scaled(maximum), 'STOCK_RANGE_INVALID');
        const ncm = value.ncm ?? null; assert(ncm === null || typeof ncm === 'string' && /^\d{8}$/.test(ncm), 'NCM_INVALID');
        const gtin = value.gtin ?? null; assert(gtin === null || typeof gtin === 'string' && /^(?:\d{8}|\d{12,14})$/.test(gtin), 'GTIN_INVALID');
        const lead = value.lead_days ?? null; assert(lead === null || Number.isSafeInteger(lead) && lead >= 0 && lead <= 3650, 'LEAD_DAYS_INVALID');
        const active = value.active ?? true; assert(typeof active === 'boolean', 'ACTIVE_INVALID'); const productId = id ?? randomUUID();
        const values = [actor.companyId, productId, code, name, unit, gtin, ncm, price(value.sale_price ?? '0'), price(value.cost_price ?? '0'), minimum, maximum, lead, quantity(value.pack_quantity ?? '1', true), active];
        const product = first(await client.query(id ? 'UPDATE fagoo.product SET code=$3,name=$4,unit=$5,gtin=$6,ncm=$7,sale_price=$8,cost_price=$9,stock_min=$10,stock_max=$11,lead_days=$12,pack_quantity=$13,active=$14,version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2 RETURNING *' : 'INSERT INTO fagoo.product(company_id,id,code,name,unit,gtin,ncm,sale_price,cost_price,stock_min,stock_max,lead_days,pack_quantity,active) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *', values));
        await emit(client, actor, 'product.changed', productId); return { product, resource_id: productId };
      });
    },
    async supplierProduct(actor, productId, input) {
      object(input, ['command_id','expected_version','supplier_id','code','description','unit_factor','price','lead_days']); productId = uuid(productId);
      return command(actor, 'catalog:write', `product.supplier:${productId}`, input, async client => {
        const product = resource(first(await client.query('SELECT * FROM fagoo.product WHERE company_id=$1 AND id=$2 FOR UPDATE', [actor.companyId, productId]))); expected(product, input.expected_version);
        const supplier = resource(first(await client.query('SELECT kind FROM fagoo.contact WHERE company_id=$1 AND id=$2', [actor.companyId, uuid(input.supplier_id)]))); assert(['supplier','both'].includes(supplier.kind), 'SUPPLIER_REQUIRED');
        const lead = input.lead_days ?? null; assert(lead === null || Number.isSafeInteger(lead) && lead >= 0 && lead <= 3650, 'LEAD_DAYS_INVALID');
        const link = first(await client.query('INSERT INTO fagoo.product_supplier(company_id,product_id,supplier_id,code,description,unit_factor,price,lead_days) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(company_id,product_id,supplier_id) DO UPDATE SET code=excluded.code,description=excluded.description,unit_factor=excluded.unit_factor,price=excluded.price,lead_days=excluded.lead_days RETURNING *', [actor.companyId, productId, input.supplier_id, text(input.code,60,true),text(input.description,200,true),quantity(input.unit_factor ?? '1',true),input.price === undefined ? null : price(input.price), lead]));
        await client.query('UPDATE fagoo.product SET version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2',[actor.companyId,productId]);
        return { supplier_product: link, version: product.version + 1, resource_id: productId };
      });
    },
    async contacts(actor, params = {}) {
      permission(actor, 'catalog:read'); const q = params.q ? text(params.q,120) : ''; const kind = params.kind ?? ''; assert(['','customer','supplier','both'].includes(kind),'CONTACT_KIND_INVALID'); const p = await pagination(params, { resource:'contacts', q, kind });
      return page('SELECT c.*,count(*) OVER() AS _total FROM fagoo.contact c WHERE company_id=$1 AND created_at<=$2 AND ($3=\'\' OR name ILIKE $4 OR document=$3) AND ($5=\'\' OR kind=$5 OR kind=\'both\') ORDER BY name,id', [actor.companyId,p.asOf,q,`%${q}%`,kind],p);
    },
    async saveContact(actor,input,id=null) {
      object(input,['command_id','expected_version','name','kind','document','payment_terms']);
      return command(actor,'catalog:write',id ? `contact.update:${uuid(id)}` : 'contact.create',input,async client=>{
        let old={};if(id){old=resource(first(await client.query('SELECT * FROM fagoo.contact WHERE company_id=$1 AND id=$2 FOR UPDATE',[actor.companyId,id])));expected(old,input.expected_version);}
        const value={...old,...input}; assert(['customer','supplier','both'].includes(value.kind),'CONTACT_KIND_INVALID'); const contactId=id??randomUUID();
        const contact=first(await client.query(id ? 'UPDATE fagoo.contact SET name=$3,kind=$4,document=$5,payment_terms=$6,version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2 RETURNING *' : 'INSERT INTO fagoo.contact(company_id,id,name,kind,document,payment_terms) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[actor.companyId,contactId,text(value.name),value.kind,text(value.document,30,true),text(value.payment_terms,200,true)]));
        return {contact,resource_id:contactId};
      });
    },
    async warehouses(actor) { permission(actor,'stock:read'); const rows=(await query('SELECT id,name,active FROM fagoo.warehouse WHERE company_id=$1 ORDER BY name,id',[actor.companyId])).rows;return {items:rows,total:rows.length,has_more:false,next_cursor:null,as_of:new Date().toISOString()}; },
    async createWarehouse(actor,input) {object(input,['command_id','name']);return command(actor,'stock:write','warehouse.create',input,async client=>{const id=randomUUID();const warehouse=first(await client.query('INSERT INTO fagoo.warehouse(company_id,id,name) VALUES($1,$2,$3) RETURNING *',[actor.companyId,id,text(input.name)]));return{warehouse,resource_id:id};});},
    async priceRules(actor,params={}) {permission(actor,'catalog:read');const p=await pagination(params,{resource:'price_rules'});return page('SELECT r.*,p.name AS product_name,c.name AS contact_name,count(*) OVER() AS _total FROM fagoo.price_rule r JOIN fagoo.product p ON p.company_id=r.company_id AND p.id=r.product_id LEFT JOIN fagoo.contact c ON c.company_id=r.company_id AND c.id=r.contact_id WHERE r.company_id=$1 AND r.created_at<=$2 ORDER BY r.name,r.id',[actor.companyId,p.asOf],p);},
    async savePriceRule(actor,input,id=null) {
      object(input,['command_id','expected_version','name','product_id','contact_id','payment_terms','unit_price','minimum_quantity','valid_from','valid_until','priority','active']);
      return command(actor,'pricing:write',id?`price_rule.update:${uuid(id)}`:'price_rule.create',input,async client=>{
        let old={};if(id){old=resource(first(await client.query('SELECT * FROM fagoo.price_rule WHERE company_id=$1 AND id=$2 FOR UPDATE',[actor.companyId,id])));expected(old,input.expected_version);}
        const value={...old,...input};const productId=uuid(value.product_id),contactId=value.contact_id?uuid(value.contact_id):null;resource(first(await client.query('SELECT id FROM fagoo.product WHERE company_id=$1 AND id=$2',[actor.companyId,productId])));
        if(contactId){const contact=resource(first(await client.query('SELECT kind FROM fagoo.contact WHERE company_id=$1 AND id=$2',[actor.companyId,contactId])));assert(['customer','both'].includes(contact.kind),'CUSTOMER_REQUIRED');}
        const from=value.valid_from?date(value.valid_from):null,until=value.valid_until?date(value.valid_until):null;assert(!from||!until||from<=until,'DATE_RANGE_INVALID');const priority=value.priority??0;assert(Number.isSafeInteger(priority)&&priority>=0&&priority<=1000,'PRIORITY_INVALID');const active=value.active??true;assert(typeof active==='boolean','ACTIVE_INVALID');const ruleId=id??randomUUID();
        const fields=[actor.companyId,ruleId,text(value.name),productId,contactId,text(value.payment_terms,200,true),price(value.unit_price),quantity(value.minimum_quantity??'1',true),from,until,priority,active];
        const priceRule=first(await client.query(id?'UPDATE fagoo.price_rule SET name=$3,product_id=$4,contact_id=$5,payment_terms=$6,unit_price=$7,minimum_quantity=$8,valid_from=$9,valid_until=$10,priority=$11,active=$12,version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2 RETURNING *':'INSERT INTO fagoo.price_rule(company_id,id,name,product_id,contact_id,payment_terms,unit_price,minimum_quantity,valid_from,valid_until,priority,active) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *',fields));
        await emit(client,actor,'pricing.changed',ruleId);return{price_rule:priceRule,resource_id:ruleId};
      });
    },
    async orders(actor,params={}) {
      permission(actor,'orders:read');const kind=params.kind??'';assert(['','sale','purchase'].includes(kind),'ORDER_KIND_INVALID');const p=await pagination(params,{resource:'orders',kind});
      return page('SELECT o.*,c.name AS contact_name,count(*) OVER() AS _total FROM fagoo.orders o JOIN fagoo.contact c ON c.company_id=o.company_id AND c.id=o.contact_id WHERE o.company_id=$1 AND o.created_at<=$2 AND ($3=\'\' OR o.kind=$3) ORDER BY o.created_at DESC,o.id',[actor.companyId,p.asOf,kind],p);
    },
    async order(actor,id) {permission(actor,'orders:read');const order=await getOrder(pool,actor,id);const labels=first(await query('SELECT c.name AS contact_name,w.name AS warehouse_name FROM fagoo.contact c JOIN fagoo.warehouse w ON w.company_id=c.company_id WHERE c.company_id=$1 AND c.id=$2 AND w.id=$3',[actor.companyId,order.contact_id,order.warehouse_id]));const receipts=(await query('SELECT id,created_at,reversed_at,reversal_reason FROM fagoo.receipt WHERE company_id=$1 AND order_id=$2 ORDER BY created_at,id',[actor.companyId,id])).rows;const finance=actor.scopes.includes('*')||actor.scopes.includes('finance:read')?(await query('SELECT * FROM fagoo.finance_posting WHERE company_id=$1 AND order_id=$2 ORDER BY created_at,id',[actor.companyId,id])).rows:undefined;return {order:{...order,...labels},items:await itemsFor(pool,actor,id),receipts,...(finance?{finance}: {})};},
    async createOrder(actor,input) {
      object(input,['command_id','kind','contact_id','warehouse_id','items','payment_terms','expected_on']);
      assert(['sale','purchase'].includes(input.kind),'ORDER_KIND_INVALID');assert(Array.isArray(input.items)&&input.items.length>0&&input.items.length<=250,'ORDER_ITEMS_INVALID');
      return command(actor,'orders:write','order.create',input,async client=>{
        const contact=resource(first(await client.query('SELECT * FROM fagoo.contact WHERE company_id=$1 AND id=$2',[actor.companyId,uuid(input.contact_id)])));assert(contact.kind==='both'||contact.kind===(input.kind==='sale'?'customer':'supplier'),'CONTACT_KIND_INVALID');
        resource(first(await client.query('SELECT id FROM fagoo.warehouse WHERE company_id=$1 AND id=$2 AND active=true',[actor.companyId,uuid(input.warehouse_id)])));
        const id=randomUUID(),items=[];let total=0n;const seen=new Set();const paymentTerms=text(input.payment_terms??contact.payment_terms,200,true);
        for(const [index,row]of input.items.entries()){
          object(row,['product_id','quantity','unit_price','unit_factor']);const productId=uuid(row.product_id);assert(!seen.has(productId),'DUPLICATE_PRODUCT');seen.add(productId);
          const product=resource(first(await client.query('SELECT * FROM fagoo.product WHERE company_id=$1 AND id=$2 AND active=true',[actor.companyId,productId])));
          const factor=quantity(row.unit_factor??'1',true);assert(input.kind==='purchase'||scaled(factor)===1_000_000n,'SALE_BASE_UNIT_REQUIRED');
          assert(input.kind!=='purchase'||scaled(factor)===1_000_000n||typeof row.unit_price==='string','PURCHASE_PACKAGE_PRICE_REQUIRED');
          const q=quantity(row.quantity,true);baseQuantity(q,factor);const resolved=input.kind==='sale'?await resolvePrice(client,actor,product,contact.id,q,paymentTerms):{unit_price:price(product.cost_price),rule_id:null,rule_version:null};const unitPrice=price(row.unit_price??resolved.unit_price);
          if(input.kind==='sale'&&unitPrice!==resolved.unit_price)permission(actor,'pricing:override');
          const amount=lineTotal(q,unitPrice);total+=scaled(amount,2,{digits:14});items.push({id:randomUUID(),position:index+1,product_id:productId,description:product.name,code:product.code,unit:product.unit,quantity:q,unit_factor:factor,unit_price:unitPrice,total:amount,price_rule_id:resolved.rule_id,price_rule_version:resolved.rule_version});
        }
        money(formatted(total,2));const order=first(await client.query('INSERT INTO fagoo.orders(company_id,id,kind,contact_id,warehouse_id,total,payment_terms,expected_on) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',[actor.companyId,id,input.kind,input.contact_id,input.warehouse_id,formatted(total,2),text(input.payment_terms??contact.payment_terms,200,true),input.expected_on?date(input.expected_on):null]));
        for(const item of items)await client.query('INSERT INTO fagoo.order_item(company_id,order_id,id,position,product_id,description,code,unit,quantity,unit_factor,unit_price,total,price_rule_id,price_rule_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)',[actor.companyId,id,item.id,item.position,item.product_id,item.description,item.code,item.unit,item.quantity,item.unit_factor,item.unit_price,item.total,item.price_rule_id,item.price_rule_version]);
        await emit(client,actor,'order.created',id,{kind:input.kind});return{order,items,resource_id:id};
      });
    },
    async confirmOrder(actor,id,input) {
      object(input,['command_id','expected_version']);id=uuid(id);
      return command(actor,'orders:write',`order.confirm:${id}`,input,async client=>{
        const order=await getOrder(client,actor,id,true);expected(order,input.expected_version);assert(order.status==='draft','ORDER_NOT_DRAFT',409);const items=await itemsFor(client,actor,id);
        if(order.kind==='sale'){
          permission(actor,'stock:write');
          for(const item of [...items].sort((a,b)=>a.product_id.localeCompare(b.product_id))){
            const product=resource(first(await client.query('SELECT id,sale_price,active FROM fagoo.product WHERE company_id=$1 AND id=$2',[actor.companyId,item.product_id])));assert(product.active,'PRODUCT_INACTIVE',409);const resolved=await resolvePrice(client,actor,product,order.contact_id,item.quantity,order.payment_terms);
            if(price(item.unit_price)!==resolved.unit_price&&!actor.scopes.includes('*')&&!actor.scopes.includes('pricing:override'))throw new BusinessError(409,'PRICE_CHANGED',{product_id:item.product_id,current_price:resolved.unit_price});
            const balance=await stockLock(client,actor,order.warehouse_id,item.product_id);assert(scaled(balance.quantity)-scaled(balance.reserved)>=scaled(item.quantity),'INSUFFICIENT_STOCK',409,{product_id:item.product_id});
            await client.query('UPDATE fagoo.stock_balance SET reserved=reserved+$4,version=version+1 WHERE company_id=$1 AND warehouse_id=$2 AND product_id=$3',[actor.companyId,order.warehouse_id,item.product_id,item.quantity]);
          }
        }
        const result=first(await client.query("UPDATE fagoo.orders SET status='confirmed',confirmed_at=now(),version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2 RETURNING *",[actor.companyId,id]));await emit(client,actor,'order.confirmed',id,{kind:order.kind});return{order:result,resource_id:id};
      });
    },
    async fulfillOrder(actor,id,input) {
      object(input,['command_id','expected_version','confirmed']);assert(input.confirmed===true,'CONFIRMATION_REQUIRED');id=uuid(id);
      return command(actor,'stock:write',`order.fulfill:${id}`,input,async client=>{
        permission(actor,'orders:write');const order=await getOrder(client,actor,id,true);expected(order,input.expected_version);assert(order.kind==='sale'&&order.status==='confirmed','ORDER_NOT_FULFILLABLE',409);const items=await itemsFor(client,actor,id);
        for(const item of [...items].sort((a,b)=>a.product_id.localeCompare(b.product_id))){const balance=await stockLock(client,actor,order.warehouse_id,item.product_id);assert(scaled(balance.reserved)>=scaled(item.quantity),'RESERVATION_MISSING',409);await client.query('UPDATE fagoo.stock_balance SET quantity=quantity-$4,reserved=reserved-$4,version=version+1 WHERE company_id=$1 AND warehouse_id=$2 AND product_id=$3',[actor.companyId,order.warehouse_id,item.product_id,item.quantity]);await movement(client,actor,order.warehouse_id,item.product_id,formatted(-scaled(item.quantity)),'sale',id);}
        const result=first(await client.query("UPDATE fagoo.orders SET status='completed',completed_at=now(),version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2 RETURNING *",[actor.companyId,id]));await emit(client,actor,'sale.completed',id);return{order:result,resource_id:id};
      });
    },
    async receiveOrder(actor,id,input) {
      object(input,['command_id','expected_version','confirmed','items']);assert(input.confirmed===true,'PHYSICAL_CONFIRMATION_REQUIRED');assert(Array.isArray(input.items)&&input.items.length>0&&input.items.length<=250,'RECEIPT_ITEMS_INVALID');id=uuid(id);
      return command(actor,'stock:write',`order.receive:${id}`,input,async client=>{
        const order=await getOrder(client,actor,id,true);expected(order,input.expected_version);assert(order.kind==='purchase'&&['confirmed','partial'].includes(order.status),'ORDER_NOT_RECEIVABLE',409);const all=await itemsFor(client,actor,id);const seen=new Set(),changes=[];
        for(const row of input.items){object(row,['item_id','quantity']);const itemId=uuid(row.item_id);assert(!seen.has(itemId),'DUPLICATE_ITEM');seen.add(itemId);const item=resource(all.find(i=>i.id===itemId));const q=quantity(row.quantity,true);assert(scaled(item.received)+scaled(q)<=scaled(item.quantity),'RECEIPT_EXCEEDS_ORDER',409);changes.push({item,quantity:q,base_quantity:baseQuantity(q,item.unit_factor)});}
        const receiptId=randomUUID();await client.query('INSERT INTO fagoo.receipt(company_id,id,order_id,actor_id) VALUES($1,$2,$3,$4)',[actor.companyId,receiptId,id,actor.id]);
        for(const change of changes.sort((a,b)=>a.item.product_id.localeCompare(b.item.product_id))){const item=change.item;await stockLock(client,actor,order.warehouse_id,item.product_id);await client.query('UPDATE fagoo.stock_balance SET quantity=quantity+$4,version=version+1 WHERE company_id=$1 AND warehouse_id=$2 AND product_id=$3',[actor.companyId,order.warehouse_id,item.product_id,change.base_quantity]);await client.query('UPDATE fagoo.order_item SET received=received+$3 WHERE company_id=$1 AND id=$2',[actor.companyId,item.id,change.quantity]);await client.query('INSERT INTO fagoo.receipt_item(company_id,receipt_id,order_item_id,quantity,base_quantity) VALUES($1,$2,$3,$4,$5)',[actor.companyId,receiptId,item.id,change.quantity,change.base_quantity]);await movement(client,actor,order.warehouse_id,item.product_id,change.base_quantity,'purchase_receipt',receiptId);item.received=formatted(scaled(item.received)+scaled(change.quantity));}
        const complete=all.every(item=>scaled(item.received)===scaled(item.quantity));const result=first(await client.query("UPDATE fagoo.orders SET status=$3,version=version+1,updated_at=now(),completed_at=CASE WHEN $3='completed' THEN now() ELSE NULL END WHERE company_id=$1 AND id=$2 RETURNING *",[actor.companyId,id,complete?'completed':'partial']));
        await emit(client,actor,'purchase.received',id,{receipt_id:receiptId,complete});return{order:result,receipt:{id:receiptId,items:changes.map(({item,...rest})=>({item_id:item.id,...rest}))},resource_id:receiptId};
      });
    },
    async postFinance(actor,id,input) {
      object(input,['command_id','expected_version','installments']);assert(Array.isArray(input.installments)&&input.installments.length>0&&input.installments.length<=120,'INSTALLMENTS_INVALID');id=uuid(id);
      return command(actor,'finance:write',`order.finance:${id}`,input,async client=>{
        const order=await getOrder(client,actor,id,true);expected(order,input.expected_version);assert(!['draft','cancelled'].includes(order.status),'ORDER_NOT_CONFIRMED',409);
        assert(!first(await client.query("SELECT id FROM fagoo.finance_posting WHERE company_id=$1 AND order_id=$2 AND status='active'",[actor.companyId,id])),'FINANCE_ALREADY_POSTED',409);
        let total=0n;const installments=input.installments.map((part,index)=>{object(part,['due_on','amount']);const amount=money(part.amount,true);total+=scaled(amount,2,{digits:14});return{id:randomUUID(),installment:index+1,due_on:date(part.due_on),amount};});assert(total===scaled(order.total,2,{digits:14}),'INSTALLMENTS_TOTAL_MISMATCH');
        const postingId=randomUUID(),direction=order.kind==='purchase'?'payable':'receivable';await client.query('INSERT INTO fagoo.finance_posting(company_id,id,order_id,direction,total,actor_id) VALUES($1,$2,$3,$4,$5,$6)',[actor.companyId,postingId,id,direction,order.total,actor.id]);
        for(const part of installments)await client.query('INSERT INTO fagoo.finance_title(company_id,id,posting_id,installment,due_on,amount) VALUES($1,$2,$3,$4,$5,$6)',[actor.companyId,part.id,postingId,part.installment,part.due_on,part.amount]);
        const result=first(await client.query('UPDATE fagoo.orders SET version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2 RETURNING *',[actor.companyId,id]));await emit(client,actor,'finance.posted',postingId,{order_id:id,direction});return{posting:{id:postingId,order_id:id,direction,total:order.total,installments},order:result,cash_movement_performed:false,resource_id:postingId};
      });
    },
    async reverseReceipt(actor,id,receiptId,input) {
      object(input,['command_id','expected_version','confirmed','reason']);assert(input.confirmed===true,'PHYSICAL_CONFIRMATION_REQUIRED');id=uuid(id);receiptId=uuid(receiptId);
      return command(actor,'stock:write',`receipt.reverse:${receiptId}`,input,async client=>{
        const order=await getOrder(client,actor,id,true);expected(order,input.expected_version);assert(order.kind==='purchase'&&['partial','completed'].includes(order.status),'ORDER_NOT_REVERSIBLE',409);
        const receipt=resource(first(await client.query('SELECT * FROM fagoo.receipt WHERE company_id=$1 AND id=$2 AND order_id=$3 FOR UPDATE',[actor.companyId,receiptId,id])));assert(!receipt.reversed_at,'RECEIPT_ALREADY_REVERSED',409);const reason=text(input.reason,500);
        const rows=(await client.query('SELECT r.*,i.product_id FROM fagoo.receipt_item r JOIN fagoo.order_item i ON i.company_id=r.company_id AND i.id=r.order_item_id WHERE r.company_id=$1 AND r.receipt_id=$2 ORDER BY i.product_id',[actor.companyId,receiptId])).rows;
        for(const row of rows){const balance=await stockLock(client,actor,order.warehouse_id,row.product_id);assert(scaled(balance.quantity)-scaled(balance.reserved)>=scaled(row.base_quantity),'INSUFFICIENT_STOCK_FOR_REVERSAL',409,{product_id:row.product_id});await client.query('UPDATE fagoo.stock_balance SET quantity=quantity-$4,version=version+1 WHERE company_id=$1 AND warehouse_id=$2 AND product_id=$3',[actor.companyId,order.warehouse_id,row.product_id,row.base_quantity]);await client.query('UPDATE fagoo.order_item SET received=received-$3 WHERE company_id=$1 AND id=$2',[actor.companyId,row.order_item_id,row.quantity]);await movement(client,actor,order.warehouse_id,row.product_id,formatted(-scaled(row.base_quantity)),'receipt_reversal',receiptId,reason);}
        await client.query('UPDATE fagoo.receipt SET reversed_at=now(),reversal_reason=$3 WHERE company_id=$1 AND id=$2',[actor.companyId,receiptId,reason]);
        const remaining=await itemsFor(client,actor,id);const status=remaining.some(row=>scaled(row.received)>0n)?'partial':'confirmed';const result=first(await client.query('UPDATE fagoo.orders SET status=$3,completed_at=NULL,version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2 RETURNING *',[actor.companyId,id,status]));await emit(client,actor,'purchase.receipt_reversed',id,{receipt_id:receiptId});return{order:result,receipt_id:receiptId,financial_effects_performed:false,resource_id:receiptId};
      });
    },
    async reverseFinance(actor,id,postingId,input) {
      object(input,['command_id','expected_version','expected_posting_version','confirmed','reason']);assert(input.confirmed===true,'CONFIRMATION_REQUIRED');id=uuid(id);postingId=uuid(postingId);
      return command(actor,'finance:write',`finance.reverse:${postingId}`,input,async client=>{
        const order=await getOrder(client,actor,id,true);expected(order,input.expected_version);const posting=resource(first(await client.query('SELECT * FROM fagoo.finance_posting WHERE company_id=$1 AND id=$2 AND order_id=$3 FOR UPDATE',[actor.companyId,postingId,id])));expected(posting,input.expected_posting_version);assert(posting.status==='active','FINANCE_ALREADY_REVERSED',409);
        const titles=(await client.query('SELECT id,status FROM fagoo.finance_title WHERE company_id=$1 AND posting_id=$2 ORDER BY id FOR UPDATE',[actor.companyId,postingId])).rows;assert(titles.length>0&&titles.every(t=>t.status==='open'),'FINANCE_HAS_SETTLEMENT',409);const reason=text(input.reason,500);
        await client.query("UPDATE fagoo.finance_title SET status='cancelled' WHERE company_id=$1 AND posting_id=$2",[actor.companyId,postingId]);const changed=first(await client.query("UPDATE fagoo.finance_posting SET status='reversed',version=version+1,reversed_at=now(),reversal_reason=$3 WHERE company_id=$1 AND id=$2 RETURNING *",[actor.companyId,postingId,reason]));const changedOrder=first(await client.query('UPDATE fagoo.orders SET version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2 RETURNING *',[actor.companyId,id]));await emit(client,actor,'finance.reversed',postingId,{order_id:id});return{order:changedOrder,posting:changed,cash_movement_performed:false,resource_id:postingId};
      });
    },
    async cancelOrder(actor,id,input) {
      object(input,['command_id','expected_version','reason']);id=uuid(id);
      return command(actor,'orders:write',`order.cancel:${id}`,input,async client=>{
        const order=await getOrder(client,actor,id,true);expected(order,input.expected_version);assert(['draft','confirmed'].includes(order.status),'ORDER_HAS_PHYSICAL_EFFECTS',409);const reason=text(input.reason,500);
        assert(!first(await client.query("SELECT id FROM fagoo.finance_posting WHERE company_id=$1 AND order_id=$2 AND status='active'",[actor.companyId,id])),'FINANCE_REVERSAL_REQUIRED',409);
        if(order.kind==='sale'&&order.status==='confirmed'){permission(actor,'stock:write');for(const item of (await itemsFor(client,actor,id)).sort((a,b)=>a.product_id.localeCompare(b.product_id))){const balance=await stockLock(client,actor,order.warehouse_id,item.product_id);assert(scaled(balance.reserved)>=scaled(item.quantity),'RESERVATION_MISSING',409);await client.query('UPDATE fagoo.stock_balance SET reserved=reserved-$4,version=version+1 WHERE company_id=$1 AND warehouse_id=$2 AND product_id=$3',[actor.companyId,order.warehouse_id,item.product_id,item.quantity]);}}
        const result=first(await client.query("UPDATE fagoo.orders SET status='cancelled',version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2 RETURNING *",[actor.companyId,id]));await emit(client,actor,'order.cancelled',id,{reason});return{order:result,resource_id:id};
      });
    },
    async reverseFulfillment(actor,id,input) {
      object(input,['command_id','expected_version','confirmed','reason']);assert(input.confirmed===true,'PHYSICAL_CONFIRMATION_REQUIRED');id=uuid(id);
      return command(actor,'stock:write',`sale.reverse:${id}`,input,async client=>{
        permission(actor,'orders:write');const order=await getOrder(client,actor,id,true);expected(order,input.expected_version);assert(order.kind==='sale'&&order.status==='completed','SALE_NOT_COMPLETED',409);const reason=text(input.reason,500);
        assert(!first(await client.query("SELECT id FROM fagoo.finance_posting WHERE company_id=$1 AND order_id=$2 AND status='active'",[actor.companyId,id])),'FINANCE_REVERSAL_REQUIRED',409);
        for(const item of (await itemsFor(client,actor,id)).sort((a,b)=>a.product_id.localeCompare(b.product_id))){await stockLock(client,actor,order.warehouse_id,item.product_id);await client.query('UPDATE fagoo.stock_balance SET quantity=quantity+$4,version=version+1 WHERE company_id=$1 AND warehouse_id=$2 AND product_id=$3',[actor.companyId,order.warehouse_id,item.product_id,item.quantity]);await movement(client,actor,order.warehouse_id,item.product_id,item.quantity,'sale_reversal',id,reason);}
        const result=first(await client.query("UPDATE fagoo.orders SET status='cancelled',version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2 RETURNING *",[actor.companyId,id]));await emit(client,actor,'sale.reversed',id);return{order:result,resource_id:id};
      });
    },
    async stock(actor,params={}) {
      permission(actor,'stock:read');const warehouse=params.warehouse_id?uuid(params.warehouse_id):null;const productId=params.product_id?uuid(params.product_id):null;const p=await pagination(params,{resource:'stock',warehouse,productId});
      if(warehouse)resource(first(await query('SELECT id FROM fagoo.warehouse WHERE company_id=$1 AND id=$2',[actor.companyId,warehouse])));
      return page('SELECT p.id AS product_id,p.code,p.name,p.unit,p.stock_min,p.stock_max,coalesce(sum(s.quantity),0)::numeric(18,6)::text AS quantity,coalesce(sum(s.reserved),0)::numeric(18,6)::text AS reserved,(coalesce(sum(s.quantity),0)-coalesce(sum(s.reserved),0))::numeric(18,6)::text AS available,CASE WHEN $2::uuid IS NOT NULL THEN coalesce(max(s.version),0) ELSE NULL END AS version,count(*) OVER() AS _total FROM fagoo.product p LEFT JOIN fagoo.stock_balance s ON s.company_id=p.company_id AND s.product_id=p.id AND ($2::uuid IS NULL OR s.warehouse_id=$2) WHERE p.company_id=$1 AND p.created_at<=$3 AND ($4::uuid IS NULL OR p.id=$4) GROUP BY p.company_id,p.id ORDER BY p.name,p.id',[actor.companyId,warehouse,p.asOf,productId],p);
    },
    async adjustStock(actor,input) {
      object(input,['command_id','warehouse_id','product_id','quantity','reason','expected_version']);assert(Number.isSafeInteger(input.expected_version)&&input.expected_version>=0,'VERSION_REQUIRED');const delta=scaled(input.quantity,6,{signed:true});assert(delta!==0n,'ZERO_ADJUSTMENT');
      return command(actor,'stock:write','stock.adjust',input,async client=>{
        const warehouse=uuid(input.warehouse_id),product=uuid(input.product_id);resource(first(await client.query('SELECT id FROM fagoo.warehouse WHERE company_id=$1 AND id=$2 AND active=true',[actor.companyId,warehouse])));resource(first(await client.query('SELECT id FROM fagoo.product WHERE company_id=$1 AND id=$2',[actor.companyId,product])));
        const existing=first(await client.query('SELECT version FROM fagoo.stock_balance WHERE company_id=$1 AND warehouse_id=$2 AND product_id=$3',[actor.companyId,warehouse,product]));const balance=await stockLock(client,actor,warehouse,product);assert((existing||balance.version!==1?balance.version:0)===input.expected_version,'VERSION_CONFLICT',409);assert(scaled(balance.quantity)+delta>=scaled(balance.reserved),'INSUFFICIENT_STOCK',409);
        const result=first(await client.query('UPDATE fagoo.stock_balance SET quantity=quantity+$4,version=version+1 WHERE company_id=$1 AND warehouse_id=$2 AND product_id=$3 RETURNING *',[actor.companyId,warehouse,product,formatted(delta)]));const movementId=randomUUID();await movement(client,actor,warehouse,product,formatted(delta),'adjustment',movementId,text(input.reason,500));await emit(client,actor,'stock.adjusted',product);return{balance:result,resource_id:movementId};
      });
    },
    async stockMovements(actor,params={}) {
      permission(actor,'stock:read');const productId=params.product_id?uuid(params.product_id):null,warehouseId=params.warehouse_id?uuid(params.warehouse_id):null,from=params.from?date(params.from):'1900-01-01',to=params.to?date(params.to):'9999-12-31';assert(from<=to,'DATE_RANGE_INVALID');const p=await pagination(params,{resource:'stock_movements',productId,warehouseId,from,to});
      return page(`SELECT m.*,r.order_id,i.unit_price AS purchase_unit_price,i.unit_factor AS purchase_unit_factor,count(*) OVER() AS _total FROM fagoo.stock_movement m LEFT JOIN fagoo.receipt r ON r.company_id=m.company_id AND r.id=m.reference_id AND m.kind IN ('purchase_receipt','receipt_reversal') LEFT JOIN fagoo.order_item i ON i.company_id=r.company_id AND i.order_id=r.order_id AND i.product_id=m.product_id WHERE m.company_id=$1 AND ($2::uuid IS NULL OR m.product_id=$2) AND ($3::uuid IS NULL OR m.warehouse_id=$3) AND (m.created_at AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN $4::date AND $5::date AND m.created_at<=$6 ORDER BY m.created_at,m.id`,[actor.companyId,productId,warehouseId,from,to,p.asOf],p,{consistency:'immutable_movements_cutoff'});
    },
    async finance(actor,params={},direction='payable') {
      permission(actor,'finance:read');const p=await pagination(params,{resource:'finance',direction});
      return page('SELECT t.*,p.order_id,p.direction,c.name AS contact_name,count(*) OVER() AS _total FROM fagoo.finance_title t JOIN fagoo.finance_posting p ON p.company_id=t.company_id AND p.id=t.posting_id JOIN fagoo.orders o ON o.company_id=p.company_id AND o.id=p.order_id JOIN fagoo.contact c ON c.company_id=o.company_id AND c.id=o.contact_id WHERE t.company_id=$1 AND p.direction=$2 AND t.created_at<=$3 ORDER BY t.due_on,t.id',[actor.companyId,direction,p.asOf],p);
    },
    async commercialContext(actor,contactId,productId,params={}) {
      permission(actor,'orders:read');permission(actor,'catalog:read');const contact=resource(first(await query('SELECT id,name,payment_terms FROM fagoo.contact WHERE company_id=$1 AND id=$2',[actor.companyId,uuid(contactId)])));const product=resource(first(await query('SELECT id,code,name,unit,sale_price,version,active FROM fagoo.product WHERE company_id=$1 AND id=$2',[actor.companyId,uuid(productId)])));
      const resolved=await resolvePrice(pool,actor,product,contactId,quantity(params.quantity??'1',true),text(params.payment_terms??contact.payment_terms,200,true));
      const last=first(await query("SELECT o.id AS order_id,o.completed_at,o.payment_terms,i.quantity,i.unit_price FROM fagoo.orders o JOIN fagoo.order_item i ON i.company_id=o.company_id AND i.order_id=o.id WHERE o.company_id=$1 AND o.contact_id=$2 AND i.product_id=$3 AND o.kind='sale' AND o.status='completed' ORDER BY o.completed_at DESC,o.id DESC LIMIT 1",[actor.companyId,contactId,productId]));return{contact,product,last_purchase:last??null,current_price:resolved.unit_price,price_source:resolved.source,price_rule_id:resolved.rule_id,price_rule_version:resolved.rule_version,as_of:new Date().toISOString()};
    },
    async salesSeries(actor,params={}) {
      permission(actor,'analytics:read');const from=date(params.from),to=date(params.to);assert(from<=to,'DATE_RANGE_INVALID');const group=params.group??'product_day';assert(['product_day','customer_product_month'].includes(group),'GROUP_INVALID');const p=await pagination(params,{resource:'sales_series',from,to,group});
      const bucket=group==='product_day'?"to_char(o.completed_at AT TIME ZONE 'America/Sao_Paulo','YYYY-MM-DD')":"to_char(o.completed_at AT TIME ZONE 'America/Sao_Paulo','YYYY-MM')";const contact=group==='customer_product_month'?'o.contact_id':'NULL::uuid';
      return page(`SELECT ${bucket} AS period,${contact} AS contact_id,i.product_id,sum(i.quantity)::numeric(24,6)::text AS quantity,sum(i.total)::numeric(24,2)::text AS revenue,count(DISTINCT o.id)::integer AS orders,count(*) OVER() AS _total FROM fagoo.orders o JOIN fagoo.order_item i ON i.company_id=o.company_id AND i.order_id=o.id WHERE o.company_id=$1 AND o.kind='sale' AND o.status='completed' AND (o.completed_at AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN $2::date AND $3::date AND o.completed_at<=$4 GROUP BY ${bucket},${contact},i.product_id ORDER BY period,contact_id,i.product_id`,[actor.companyId,from,to,p.asOf],p,{consistency:'completed_sales_cutoff'});
    },
    async replenishment(actor,params={}) {
      permission(actor,'analytics:read');permission(actor,'stock:read');const from=date(params.from),to=date(params.to);assert(from<=to,'DATE_RANGE_INVALID');const p=await pagination(params,{resource:'replenishment',from,to});
      const sql=`WITH balances AS (SELECT product_id,sum(quantity) quantity,sum(reserved) reserved FROM fagoo.stock_balance WHERE company_id=$1 GROUP BY product_id), sold AS (SELECT i.product_id,sum(i.quantity) quantity FROM fagoo.orders o JOIN fagoo.order_item i ON i.company_id=o.company_id AND i.order_id=o.id WHERE o.company_id=$1 AND o.kind='sale' AND o.status='completed' AND (o.completed_at AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN $2::date AND $3::date AND o.completed_at<=$4 GROUP BY i.product_id), incoming AS (SELECT i.product_id,sum((i.quantity-i.received)*i.unit_factor) quantity,min(o.expected_on) expected_on FROM fagoo.orders o JOIN fagoo.order_item i ON i.company_id=o.company_id AND i.order_id=o.id WHERE o.company_id=$1 AND o.kind='purchase' AND o.status IN ('confirmed','partial') GROUP BY i.product_id) SELECT p.id AS product_id,p.code,p.name,p.unit,p.stock_min,p.stock_max,p.cost_price,p.sale_price,p.lead_days,p.pack_quantity,p.version,coalesce(b.quantity,0)::numeric(24,6)::text AS stock,coalesce(b.reserved,0)::numeric(24,6)::text AS reserved,coalesce(s.quantity,0)::numeric(24,6)::text AS sold,coalesce(n.quantity,0)::numeric(24,6)::text AS incoming,n.expected_on,count(*) OVER() AS _total FROM fagoo.product p LEFT JOIN balances b ON b.product_id=p.id LEFT JOIN sold s ON s.product_id=p.id LEFT JOIN incoming n ON n.product_id=p.id WHERE p.company_id=$1 AND p.active=true AND p.created_at<=$4 ORDER BY p.name,p.id`;
      return {...await page(sql,[actor.companyId,from,to,p.asOf],p),from,to,forecast_method:null,cost_scope:'catalog_excludes_unconfigured_freight_and_taxes'};
    },
    async overview(actor) {
      permission(actor,'analytics:read');permission(actor,'finance:read');permission(actor,'stock:read');
      const row=first(await query(`SELECT (SELECT count(*) FROM fagoo.product WHERE company_id=$1) products,(SELECT count(*) FROM fagoo.contact WHERE company_id=$1 AND kind IN ('customer','both')) customers,(SELECT count(*) FROM fagoo.contact WHERE company_id=$1 AND kind IN ('supplier','both')) suppliers,(SELECT count(*) FROM fagoo.orders WHERE company_id=$1 AND kind='purchase' AND status IN ('draft','confirmed','partial')) open_purchase_orders,(SELECT count(*) FROM fagoo.orders WHERE company_id=$1 AND kind='sale' AND status IN ('draft','confirmed')) open_sales_orders,(SELECT coalesce(sum(t.amount),0)::numeric(24,2)::text FROM fagoo.finance_title t JOIN fagoo.finance_posting p ON p.company_id=t.company_id AND p.id=t.posting_id WHERE t.company_id=$1 AND t.status='open' AND p.direction='payable') payables_open,(SELECT coalesce(sum(t.amount),0)::numeric(24,2)::text FROM fagoo.finance_title t JOIN fagoo.finance_posting p ON p.company_id=t.company_id AND p.id=t.posting_id WHERE t.company_id=$1 AND t.status='open' AND p.direction='receivable') receivables_open,(SELECT count(*) FROM fagoo.product p WHERE p.company_id=$1 AND coalesce((SELECT sum(s.quantity-s.reserved) FROM fagoo.stock_balance s WHERE s.company_id=p.company_id AND s.product_id=p.id),0)<p.stock_min) stock_below_minimum`,[actor.companyId]));
      for(const key of ['products','customers','suppliers','open_purchase_orders','open_sales_orders','stock_below_minimum'])row[key]=count(row[key]);return{...row,as_of:new Date().toISOString()};
    },
    async receivedInvoices(actor,params={}) {
      permission(actor,'fiscal:read');const p=await pagination(params,{resource:'received_invoices'});return page("SELECT id,access_key,supplier_document,normalized#>>'{supplier,name}' AS issuer_name,number,issued_on,total,document_state,tax_review,validation,xml_sha256,created_at,count(*) OVER() AS _total FROM fagoo.received_invoice WHERE company_id=$1 AND created_at<=$2 ORDER BY created_at DESC,id",[actor.companyId,p.asOf],p);
    },
    async events(actor,params={}) {
      permission(actor,'events:read');const acknowledged=first(await query('SELECT sequence::text FROM fagoo.event_ack WHERE company_id=$1 AND consumer_id=$2',[actor.companyId,actor.id]))?.sequence??'0';const after=params.after??acknowledged;assert(typeof after==='string'&&/^\d{1,18}$/.test(after),'CURSOR_INVALID');const limit=params.limit===undefined?100:Number(params.limit);assert(Number.isSafeInteger(limit)&&limit>0&&limit<=1000,'LIMIT_INVALID');
      const result=(await query('SELECT sequence::text,type,resource_id,payload,created_at FROM fagoo.event WHERE company_id=$1 AND sequence>$2::bigint ORDER BY sequence LIMIT $3',[actor.companyId,after,limit+1])).rows;const items=result.slice(0,limit);return{items,has_more:result.length>limit,next_cursor:items.at(-1)?.sequence??after,next_after:items.at(-1)?.sequence??after,as_of:new Date().toISOString()};
    },
    async acknowledgeEvents(actor,input) {
      object(input,['command_id','sequence']);assert(typeof input.sequence==='string'&&/^\d{1,18}$/.test(input.sequence),'CURSOR_INVALID');
      return command(actor,'events:write','events.ack',input,async client=>{
        const maximum=first(await client.query('SELECT coalesce(max(sequence),0)::text AS sequence FROM fagoo.event WHERE company_id=$1',[actor.companyId])).sequence;assert(BigInt(input.sequence)<=BigInt(maximum),'EVENT_CURSOR_AHEAD');
        const result=first(await client.query('INSERT INTO fagoo.event_ack(company_id,consumer_id,sequence) VALUES($1,$2,$3) ON CONFLICT(company_id,consumer_id) DO UPDATE SET sequence=greatest(fagoo.event_ack.sequence,excluded.sequence),updated_at=now() RETURNING sequence::text',[actor.companyId,actor.id,input.sequence]));return{acknowledged:result.sequence};
      });
    },
    async commandResult(actor,id) {permission(actor,'orders:read');const result=resource(first(await query('SELECT result FROM fagoo.command WHERE company_id=$1 AND id=$2 AND actor_id=$3',[actor.companyId,uuid(id),actor.id])));return{...result.result,replayed:true};}
  };
  return Object.freeze(service);
}
