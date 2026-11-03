// Standalone synthetic visual artifacts. No real XML, certificate, credentials or API.
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {candidateFixture,maximalHeader,boundedLongHeader} from './fixtures.mjs';
import {extractCandidatePreview,renderCandidateHtml} from '../src/index.mjs';
const destination=resolve(process.argv[2]||'/Volumes/Dev/tmp/brufap-danfe-qa');await mkdir(destination,{recursive:true});
const outputs=[];
for(const[name,options]of[
 ['preview-55',{model:'55',csosn:'500',count:4,quantity:'1.234500',unit_price:'12.1234567891'}],
 ['preview-65',{model:'65',count:4,quantity:'1.234500',unit_price:'12.1234567891'}],
 ['preview-55-250-items',{model:'55',count:250}],
 ['preview-55-long-header',{model:'55',transformUnsigned:boundedLongHeader}],
]){
 const f=await candidateFixture(options),data=extractCandidatePreview(f.bytes,f.context),render=renderCandidateHtml(data),path=resolve(destination,name+'.html');
 await writeFile(path,render.html,{flag:'w'});outputs.push({path,model:data.model,items:data.items.length,page_count:render.page_count,sha256:render.sha256,source_sha256:render.source_sha256,synthetic:true,authorized:false});
}
await writeFile(resolve(destination,'manifest.json'),JSON.stringify(outputs,null,2)+'\n');console.log(JSON.stringify(outputs,null,2));
const extreme=await candidateFixture({transformUnsigned:maximalHeader}),projection=extractCandidatePreview(extreme.bytes,extreme.context);
let rejection;try{renderCandidateHtml(projection);throw Error('Expected layout rejection');}catch(error){if(error.code!=='PRINT_HEADER_TOO_LARGE')throw error;rejection={synthetic:true,issuer_name:120,address_limits:[120,60,120,120,120],payments:25,code:error.code,html_produced:false};}
await writeFile(resolve(destination,'header-limit-result.json'),JSON.stringify(rejection,null,2)+'\n');
