/** Versioned local parser identity. Pins are release metadata, not session or TLS authorization. */
import {createHash} from 'node:crypto';
export const STORED_RESPONSE_MANIFEST=Object.freeze({
 profile:'authorization-stored-response-utf8-v1',
 files:Object.freeze([
  Object.freeze({path:'packages/fiscal-xml/src/xml.mjs',sha256:'e0ceb379b62c90f473cb761328c84884f7b5f0e98b79ac615d1ca6c46afa5ea9'}),
  Object.freeze({path:'packages/fiscal-authorization/src/index.mjs',sha256:'f26873d907090c526ccd5ae529b51220d6b98f2faf2d84fecba1de238be0e52d'}),
 ]),
});
export const STORED_RESPONSE_MANIFEST_HASH=createHash('sha256').update(JSON.stringify(STORED_RESPONSE_MANIFEST)).digest('hex');
