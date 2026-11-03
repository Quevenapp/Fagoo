// Explicit local visual fixtures: synthetic certificates/XML and in-memory ports only.
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {processedFixtures} from '../../fiscal-danfe-runtime/test/processed-fixtures.mjs';
import {createProcessedSource,disposeProcessedSource} from '../../fiscal-danfe-runtime/src/processed-source.mjs';
import {renderProcessedHtml} from '../src/processed-render.mjs';
import {candidateFixture,boundedLongHeader} from './fixtures.mjs';
const destination=resolve(process.argv[2]||'/Volumes/Dev/tmp/brufap-processed-danfe-qa');
await mkdir(destination,{recursive:true,mode:0o700});const f=await processedFixtures(),results=[];
try{
 for(const [name,options]of [
  ['processed-55',{model:'55',csosn:'500',count:4,quantity:'1.234500',unit_price:'12.1234567891'}],
  ['processed-65',{model:'65',count:4,quantity:'1.234500',unit_price:'12.1234567891'}],
  ['processed-55-250-items',{model:'55',count:250}],
  ['processed-55-long-header',{model:'55',transformUnsigned:boundedLongHeader}],
 ]){
  const candidate=await candidateFixture(options),x=f.create(options.model,'revalidation',{signedCandidate:candidate}),h=await createProcessedSource(x.ports)(x.input);
  try{const out=renderProcessedHtml(h),path=resolve(destination,name+'.html');await writeFile(path,out.html,{mode:0o600,flag:'wx'});results.push({path,model:options.model,sha256:out.sha256,page_count:out.page_count,bytes:Buffer.byteLength(out.html),synthetic:true,production_authorized:false});}
  finally{disposeProcessedSource(h);}
 }
 await writeFile(resolve(destination,'manifest.json'),JSON.stringify(results,null,2)+'\n',{mode:0o600,flag:'wx'});console.log(JSON.stringify({synthetic:true,files:results.length,destination}));
}finally{f.close();}
