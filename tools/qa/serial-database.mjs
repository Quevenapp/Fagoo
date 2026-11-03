/** A PGlite connection has one session role. Keep each QA session operation indivisible. */
export function createQaDatabaseQueue(){
 let tail=Promise.resolve();
 const enqueue=operation=>{
  if(typeof operation!=='function')throw new TypeError('QA_DATABASE_OPERATION_REQUIRED');
  const result=tail.then(operation,operation);
  tail=result.then(()=>undefined,()=>undefined);
  return result;
 };
 enqueue.drain=()=>tail;
 return enqueue;
}
