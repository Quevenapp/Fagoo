// Local filesystem preparation only: no database, HTTP, UUID generation or mutation payload.
import {readFile,open} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';

export const TEMPLATE_SHA256='fc857bba4672ed60ff640dd7b3739f1fa191dfd61ff2f4287ed8ced1d3216ebf';
export const BASELINE_CONTRACT='homologation-55-next-baseline-v1';
export const COMMERCIAL_ASSUMPTION=Object.freeze({kind:'sales_orders',original_order_number:'1',product_code:'345121',quantity:'1',unit:'CX',unit_price_from:'original_order_item',expected_total:'84.81',model:'55',environment:'2',series:'2'});
const UUID=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function capture(options){
 if(!options||typeof options!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(options)))throw Error('BASELINE_OPTIONS_INVALID');
 const descriptors=Object.getOwnPropertyDescriptors(options),keys=Reflect.ownKeys(descriptors);
 if(keys.some(key=>key!=='targetOrderId'||!Object.hasOwn(descriptors[key],'value')))throw Error('BASELINE_OPTIONS_INVALID');
 const value=descriptors.targetOrderId?.value??null;
 if(value!==null&&(typeof value!=='string'||!UUID.test(value)))throw Error('BASELINE_TARGET_UUID_INVALID');
 return value===null?null:value.toLowerCase();
}
export async function prepareFiscalHomologation55Baseline(options={}){
 const targetOrderId=capture(options);
 const template=await readFile(new URL('./fiscal_homologation_55_baseline.sql',import.meta.url),'utf8');
 if(sha(template)!==TEMPLATE_SHA256||template.split('__TARGET_ORDER_ID__').length!==2)throw Error('BASELINE_TEMPLATE_CHANGED');
 return template.replace('__TARGET_ORDER_ID__',targetOrderId===null?'NULL':`'${targetOrderId}'`);
}
export async function writeFiscalHomologation55Baseline(outputPath,options={}){
 if(typeof outputPath!=='string'||!isAbsolute(outputPath)||/[\x00-\x1f\x7f]/.test(outputPath))throw Error('BASELINE_OUTPUT_PATH_INVALID');
 const sql=await prepareFiscalHomologation55Baseline(options),file=await open(outputPath,'wx',0o600);
 try{await file.writeFile(sql);await file.sync();}finally{await file.close();}
 return Object.freeze({contract:BASELINE_CONTRACT,sql_sha256:sha(sql),size_bytes:Buffer.byteLength(sql),template_sha256:TEMPLATE_SHA256,mode:'600',database_executed:false,network_used:false,uuid_generated:false,mutation_payload_generated:false});
}
function cliOptions(args){
 const values={};
 for(let i=0;i<args.length;i+=2){const key=args[i];if(!['--output','--target-order'].includes(key)||Object.hasOwn(values,key)||typeof args[i+1]!=='string'||args[i+1].startsWith('--'))throw Error('BASELINE_CLI_INVALID');values[key]=args[i+1];}
 if(!values['--output'])throw Error('BASELINE_OUTPUT_REQUIRED');
 return {outputPath:values['--output'],options:values['--target-order']?{targetOrderId:values['--target-order']}:{}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const {outputPath,options}=cliOptions(process.argv.slice(2));
 console.log(JSON.stringify(await writeFiscalHomologation55Baseline(outputPath,options)));
}
