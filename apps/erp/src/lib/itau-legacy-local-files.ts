import {ITAU_LEGACY_FILE_LIMITS} from '../../../../packages/cnab-core/src/itau-legacy-remittance.mjs';
import {inspectItau109LegacySample,disposeItau109LegacySample} from '../../../../packages/cnab-core/src/itau-legacy-sample.mjs';
export {ITAU_LEGACY_FILE_LIMITS};
const error=(code:string)=>Object.assign(new Error(code),{code});
export function captureItauLegacyFiles(input:Iterable<File>){const files=Array.from(input);if(!files.length||files.length>ITAU_LEGACY_FILE_LIMITS.files||files.some(f=>!(f instanceof File)||!Number.isSafeInteger(f.size)||f.size<1||f.size>ITAU_LEGACY_FILE_LIMITS.fileBytes)||files.reduce((n,f)=>n+f.size,0)>ITAU_LEGACY_FILE_LIMITS.totalBytes)throw error('ITAU_LEGACY_FILE_LIMIT');return Object.freeze(files);}
/** Selected File objects and year interpretation are captured before any await. No network port. */
export function readItauLegacyFiles(input:Iterable<File>,century:string,{signal,deadline}:{signal:AbortSignal;deadline:number}){
 const files=captureItauLegacyFiles(input);if(!['1900','2000','2100'].includes(century))throw error('ITAU_LEGACY_CENTURY_REQUIRED');
 const settings={signal,deadline,century:Number(century)};
 const check=()=>{if(signal.aborted||!Number.isFinite(deadline)||Date.now()>=deadline)throw error('CNAB_LEGACY_READ_ABORTED');};
 return(async()=>{const copies:Uint8Array[]=[];try{
  for(const file of files){check();let accepted=false,closed=false,timer:ReturnType<typeof setTimeout>|undefined,rejectStop:(e:Error)=>void=()=>{};
   const cancel=()=>rejectStop(error('CNAB_LEGACY_READ_ABORTED'));
   const pending=Promise.resolve().then(()=>{check();return file.arrayBuffer();}).then(raw=>{const bytes=new Uint8Array(raw);if(closed||signal.aborted||Date.now()>=deadline){bytes.fill(0);throw error('CNAB_LEGACY_READ_ABORTED');}if(bytes.byteLength!==file.size){bytes.fill(0);throw error('ITAU_LEGACY_FILE_LIMIT');}accepted=true;copies.push(bytes);return bytes;});
   try{await Promise.race([pending,new Promise<never>((_,reject)=>{rejectStop=reject;timer=setTimeout(cancel,Math.max(0,deadline-Date.now()));signal.addEventListener('abort',cancel,{once:true});})]);check();}finally{closed=true;clearTimeout(timer);signal.removeEventListener('abort',cancel);if(!accepted)void pending.catch(()=>{});}
  }
  const sample=await inspectItau109LegacySample(copies,settings);try{check();return sample;}catch(e){disposeItau109LegacySample(sample);throw e;}
 }finally{copies.forEach(b=>b.fill(0));}})();
}
