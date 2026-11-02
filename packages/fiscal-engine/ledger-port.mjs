import {data,need,id,scope,AuthorizationServiceError} from '../fiscal-authorization/src/service-common.mjs';
const SQLSTATES=new Set(['22023','40001','42501','55000','P0002']);

/** Explicit local driver. No URL, service credential or network default. */
export function createLedgerPort({execute,actions,capture,project,prefix='',limit=262144,failure='FISCAL_LEDGER_UNAVAILABLE',attestedFailures}){
  need(typeof execute==='function','FISCAL_LEDGER_CONFIGURATION_INVALID');
  return async(action,raw,options={})=>{
    need(actions.includes(action),'FISCAL_LEDGER_ACTION_INVALID');const args=capture(action,raw);
    need(Buffer.byteLength(JSON.stringify(args))<=limit,'FISCAL_LEDGER_INPUT_LIMIT');const s=scope(options,30000);
    try{
      let result;
      try{result=await s.bounded(()=>execute(prefix+action,args,{signal:s.signal,deadline:s.deadline}));}
      catch(caught){
        s.check();const code=Object.getOwnPropertyDescriptor(caught??{},'code')?.value;
        const error=new AuthorizationServiceError(SQLSTATES.has(code)?code:failure);
        if(SQLSTATES.has(code))attestedFailures?.add(error);throw error;
      }
      s.check();const value=project(action,result,args);s.check();return value;
    }finally{s.close();}
  };
}

/** PostgreSQL bridge for explicitly installed JSONB ledger functions. It grants no missing SQL operation. */
export function createPostgresFiscalExecutor({pool,companyId,actorId,operations}){
  need(pool&&typeof pool.connect==='function'&&id(companyId)&&id(actorId)&&operations&&typeof operations==='object','FISCAL_LEDGER_CONFIGURATION_INVALID');
  const mapping=data(operations,[],Object.keys(operations));
  need(Object.keys(mapping).length>0&&Object.values(mapping).every(name=>typeof name==='string'&&/^fagoo_fiscal\.[a-z][a-z0-9_]{0,80}$/.test(name)),'FISCAL_LEDGER_CONFIGURATION_INVALID');
  return async(operation,args,{signal,deadline}={})=>{
    need(Object.hasOwn(mapping,operation),'FISCAL_LEDGER_ACTION_INVALID');need(args.p_user_id===actorId,'42501');
    need(!signal?.aborted&&Number.isSafeInteger(deadline)&&deadline>Date.now(),'FISCAL_LEDGER_DEADLINE');
    const client=await pool.connect();
    try{
      await client.query('BEGIN');
      await client.query("SELECT set_config('fagoo.company_id',$1,true),set_config('fagoo.actor_id',$2,true),set_config('statement_timeout',$3,true)",[companyId,actorId,String(Math.max(1,Math.min(deadline-Date.now(),30000)))]);
      need(!signal?.aborted&&deadline>Date.now(),'FISCAL_LEDGER_DEADLINE');
      const{rows}=await client.query(`SELECT ${mapping[operation]}($1::jsonb) AS result`,[JSON.stringify(args)]);
      need(rows.length===1&&Object.hasOwn(rows[0],'result'),'FISCAL_LEDGER_RESPONSE_INVALID');
      need(!signal?.aborted&&deadline>Date.now(),'FISCAL_LEDGER_DEADLINE');await client.query('COMMIT');return rows[0].result;
    }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}
    finally{client.release();}
  };
}
