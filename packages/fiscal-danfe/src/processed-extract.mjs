/** Only the historical reader's opaque handle can enter this projection.
 * A signed candidate or a user-supplied protocol never confers this capability. */
import {createHash} from 'node:crypto';
import {processedSource} from '../../fiscal-danfe-runtime/src/processed-source.mjs';
import {processedMetadata} from '../../fiscal-danfe-runtime/src/processed-dto.mjs';
import {extractCandidatePreview,need} from './extract.mjs';
const projections=new WeakMap();
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');

export function extractProcessedDocument(handle){
 const {metadata,signedBytes,processedBytes}=processedSource(handle);
 try{
  const source=processedMetadata(metadata);
  need(signedBytes.length===source.signed_size&&hash(signedBytes)===source.signed_hash
   &&processedBytes.length===source.processed_size&&hash(processedBytes)===source.processed_hash,'PRINT_ARTIFACT_MISMATCH');
  const preview=extractCandidatePreview(signedBytes,{candidate_id:source.candidate_id,sha256:source.signed_hash,size_bytes:source.signed_size,model:source.model,environment:'2'});
  const profile=source.model==='55'?'processed-danfe55-moc7-v1':'processed-danfe65-manual6-v1';
  const result=Object.freeze({profile,source});
  projections.set(result,Object.freeze({preview,source,profile}));return result;
 }finally{signedBytes.fill(0);processedBytes.fill(0);}
}

/** Private renderer entry point, rejecting cloned or fabricated projections. */
export function assertProcessedDocument(value){
 need(projections.has(value),'PRINT_UNTRUSTED_PROJECTION');return projections.get(value);
}
