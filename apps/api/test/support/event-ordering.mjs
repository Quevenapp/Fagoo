import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {randomUUID} from 'node:crypto';
import {createBusinessService} from '../../src/business/service.mjs';

const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
async function within(promise,message){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(message)),4000);})]);}finally{clearTimeout(timer);}}

/** Uses actual independent PostgreSQL connections; does not simulate row locks. */
export async function assertCommittedEventOrdering({pool,actor,startEarlier,startLater}){
  const business=createBusinessService(pool),baseline=(await business.events(actor,{after:'0'})).next_after;
  const inserted=deferred(),releaseEarlier=deferred(),laterAttempt=deferred();let earlier,later;
  const wrap=mode=>({query:(...args)=>pool.query(...args),async connect(){
    const client=await pool.connect();return{release:()=>client.release(),async query(sql,args){
      const pending=client.query(sql,args);
      if(mode==='later'&&sql.includes('FOR NO KEY UPDATE'))laterAttempt.resolve(client.processID);
      const result=await pending;
      if(mode==='earlier'&&sql.startsWith('INSERT INTO fagoo.event(')){
        inserted.resolve();await releaseEarlier.promise;
      }
      return result;
    }};
  }});
  try{
    earlier=startEarlier(wrap('earlier'));earlier.catch(()=>{});
    await within(inserted.promise,'Earlier transaction did not reach event insertion');
    later=startLater(wrap('later'));later.catch(()=>{});
    const pid=await within(laterAttempt.promise,'Later transaction did not acquire the company lock before writing');
    await (async()=>{
      const deadline=Date.now()+3000;
      while(Date.now()<deadline){
        const row=(await pool.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1',[pid])).rows[0];
        if(row?.wait_event_type==='Lock')return;
        await delay(10);
      }
      throw new Error('Later transaction was not blocked by the earlier company command');
    })();
    assert.deepEqual((await business.events(actor,{after:baseline})).items,[],'No later event may become visible while the earlier transaction is uncommitted');

    // A global BIGSERIAL may have gaps from another company; this must not block it.
    const other={...actor,companyId:randomUUID()};
    await pool.query('INSERT INTO fagoo.company(id,name) VALUES($1,$2)',[other.companyId,'Independent synthetic company']);
    await within(business.saveProduct(other,{command_id:randomUUID(),code:'OTHER',name:'Independent product'}),'Another company was unnecessarily blocked');

    releaseEarlier.resolve();
    const [first,second]=await Promise.all([earlier,later]);
    const firstId=first.product?.id??first.invoice?.id,secondId=second.product?.id??second.invoice?.id;
    const firstPage=await business.events(actor,{after:baseline,limit:'1'});
    assert.equal(firstPage.items.length,1);assert.equal(firstPage.items[0].resource_id,firstId);assert.equal(firstPage.has_more,true);
    await business.acknowledgeEvents(actor,{command_id:randomUUID(),sequence:firstPage.next_after});
    const nextPage=await business.events(actor,{limit:'1'});
    assert.equal(nextPage.items.length,1);assert.equal(nextPage.items[0].resource_id,secondId);assert(BigInt(nextPage.next_after)>BigInt(firstPage.next_after));
    await business.acknowledgeEvents(actor,{command_id:randomUUID(),sequence:nextPage.next_after});
    assert.deepEqual((await business.events(actor)).items,[]);
  }finally{
    releaseEarlier.resolve();await Promise.allSettled([earlier,later].filter(Boolean));
  }
}
