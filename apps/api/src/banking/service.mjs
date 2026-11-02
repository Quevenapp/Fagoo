import {createHash,randomUUID} from 'node:crypto';
import {CnabError,LAYOUTS,validateProfile,accountScope,generateRemittance,parseReturn} from '../../../../packages/cnab/index.mjs';
import {alpha} from '../../../../packages/cnab/primitives.mjs';
import {assert,BusinessError,object,text,uuid,version} from '../../../../packages/domain/decimal.mjs';

const first=result=>result.rows[0];
const canonical=value=>value===null||typeof value!=='object'?JSON.stringify(value):Array.isArray(value)?`[${value.map(canonical).join(',')}]`:`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
const hash=value=>createHash('sha256').update(value).digest('hex');
function permit(actor,scope){assert(actor&&typeof actor.id==='string'&&actor.id&&Array.isArray(actor.scopes),'AUTH_REQUIRED',401);uuid(actor.companyId);assert(actor.scopes.includes('*')||actor.scopes.includes(scope),'FORBIDDEN',403);}
function found(row){assert(row,'NOT_FOUND',404);return row;}
const capabilities={profile_configuration:true,remittance_preview:true,return_preview:true,operational_remittance:false,bank_transmission:false,automatic_settlement:false,supplier_payments:false};
const supported=[{bank:'341',layout:LAYOUTS['341'],wallets:['109']},{bank:'077',layout:LAYOUTS['077'],wallets:['110','112']}];
function configuration(input){
  object(input,['bank','layout','agency','account','accountDigit','wallet','cnpj','accountId','companyName','contractVerified','agreementReference','simpleCollectionPolicyVerified','reservedRange']);
  validateProfile(input);alpha(input.companyName,30,true);
  for(const key of ['contractVerified','simpleCollectionPolicyVerified'])assert(typeof input[key]==='boolean','BOOLEAN_REQUIRED');
  if(input.agreementReference!==undefined&&input.agreementReference!==null)text(input.agreementReference,200);
  if(input.contractVerified)assert(typeof input.agreementReference==='string'&&input.agreementReference.trim(),'CNAB_BANK_AGREEMENT_UNCONFIRMED');
  if(input.reservedRange!==undefined){object(input.reservedRange,['verified','start','end']);assert(typeof input.reservedRange.verified==='boolean'&&/^[0-9]{10}$/.test(input.reservedRange.start)&&/^[0-9]{10}$/.test(input.reservedRange.end)&&BigInt(input.reservedRange.start)<=BigInt(input.reservedRange.end),'CNAB_INTER_RESERVED_RANGE_REQUIRED');}
  return structuredClone(input);
}

export function createBankingService({pool}){
  async function run(actor,scope,action,input,operation){
    permit(actor,scope);const command=uuid(input.command_id),requestHash=hash(canonical(input)),client=pool.connect?await pool.connect():pool;
    try{
      await client.query('BEGIN');
      await client.query('INSERT INTO fagoo.command(company_id,id,actor_id,action,request_hash) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',[actor.companyId,command,actor.id,action,requestHash]);
      const old=first(await client.query('SELECT * FROM fagoo.command WHERE company_id=$1 AND id=$2 FOR UPDATE',[actor.companyId,command]));
      assert(old.actor_id===actor.id&&old.action===action&&old.request_hash===requestHash,'COMMAND_REUSED',409);
      if(old.result!==null){await client.query('COMMIT');return{...old.result,replayed:true};}
      const result={...await operation(client),command_id:command,replayed:false};
      await client.query('UPDATE fagoo.command SET result=$3::jsonb WHERE company_id=$1 AND id=$2',[actor.companyId,command,JSON.stringify(result)]);
      await client.query('INSERT INTO fagoo.audit(company_id,actor_id,command_id,action,resource_id) VALUES($1,$2,$3,$4,$5)',[actor.companyId,actor.id,command,action,result.profile?.id??result.profile_id??null]);
      await client.query('COMMIT');return result;
    }catch(error){await client.query('ROLLBACK').catch(()=>{});if(error.code==='23505')throw new BusinessError(409,'ALREADY_EXISTS');throw error;}
    finally{client.release?.();}
  }
  async function profile(actor,id,client=pool,lock=''){return found(first(await client.query(`SELECT * FROM fagoo.cnab_profile WHERE company_id=$1 AND id=$2 ${lock}`,[actor.companyId,uuid(id)])));}
  return{
    async list(actor){permit(actor,'finance:read');return{items:(await pool.query('SELECT * FROM fagoo.cnab_profile WHERE company_id=$1 ORDER BY name,id',[actor.companyId])).rows,capabilities,supported};},
    async save(actor,input,id){
      object(input,['command_id','expected_version','name','configuration','active']);const name=text(input.name,120),config=configuration(input.configuration);assert(input.active===undefined||typeof input.active==='boolean','BOOLEAN_REQUIRED');
      if(id)uuid(id);else assert(input.expected_version===undefined,'UNEXPECTED_VERSION');
      return run(actor,'system:write',id?`cnab.profile.update:${id}`:'cnab.profile.create',input,async client=>{
        const company=found(first(await client.query('SELECT document FROM fagoo.company WHERE id=$1 FOR SHARE',[actor.companyId])));assert(company.document&&company.document===config.cnpj,'CNAB_COMPANY_DOCUMENT_MISMATCH',409);
        let saved;
        if(id){const old=await profile(actor,id,client,'FOR UPDATE');assert(old.version===version(input.expected_version),'VERSION_CONFLICT',409);saved=first(await client.query('UPDATE fagoo.cnab_profile SET name=$3,account_scope=$4,configuration=$5::jsonb,active=$6,version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2 RETURNING *',[actor.companyId,id,name,accountScope(config),JSON.stringify(config),input.active??old.active]));}
        else saved=first(await client.query('INSERT INTO fagoo.cnab_profile(company_id,id,name,account_scope,configuration,active) VALUES($1,$2,$3,$4,$5::jsonb,$6) RETURNING *',[actor.companyId,randomUUID(),name,accountScope(config),JSON.stringify(config),input.active??true]));
        return{profile:saved,capabilities};
      });
    },
    async remittancePreview(actor,id,input){
      object(input,['command_id','expected_version','generated_on','remittance_sequence','titles']);uuid(id);
      return run(actor,'finance:write',`cnab.remittance.preview:${id}`,input,async client=>{
        const row=await profile(actor,id,client,'FOR SHARE');assert(row.active,'CNAB_PROFILE_INACTIVE',409);assert(row.version===version(input.expected_version),'VERSION_CONFLICT',409);
        const company=found(first(await client.query('SELECT document FROM fagoo.company WHERE id=$1 FOR SHARE',[actor.companyId])));assert(company.document===row.configuration.cnpj,'CNAB_COMPANY_DOCUMENT_MISMATCH',409);
        const generated=await generateRemittance({profile:row.configuration,titles:input.titles,generatedOn:input.generated_on,remittanceSequence:input.remittance_sequence,purpose:'homologation'});
        const{bytes,...artifact}=generated;
        return{profile_id:row.id,profile_version:row.version,artifact:{...artifact,bytes_base64:Buffer.from(bytes).toString('base64'),bankTransmissionPerformed:false,financialMutationPerformed:false},capabilities};
      });
    },
    async returnPreview(actor,id,input){
      permit(actor,'finance:read');object(input,['expected_version','bytes_base64','century']);
      const row=await profile(actor,id);assert(row.version===version(input.expected_version),'VERSION_CONFLICT',409);
      assert(typeof input.bytes_base64==='string'&&input.bytes_base64.length<=5_360_000&&input.bytes_base64.length%4===0&&/^[A-Za-z0-9+/]*={0,2}$/.test(input.bytes_base64),'CNAB_BASE64_INVALID');
      const bytes=Buffer.from(input.bytes_base64,'base64');assert(bytes.toString('base64')===input.bytes_base64,'CNAB_BASE64_INVALID');assert(bytes.length>0&&bytes.length<=4_020_000,'CNAB_FILE_SIZE_INVALID');
      const result=await parseReturn(bytes,{profile:row.configuration,...(input.century!==undefined?{century:input.century}:{})});
      return{profile_id:row.id,profile_version:row.version,parsed:result,capabilities};
    }
  };
}

export function bankingError(error){
  if(error instanceof CnabError)return new BusinessError(400,error.code,{...(error.line?{line:error.line}:{}),...(error.field?{field:error.field}:{})});
  return error;
}
