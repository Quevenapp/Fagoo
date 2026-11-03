/** Versioned source/query verification identity. Release pins are not session or TLS authority. */
import {createHash} from 'node:crypto';
export const RECEIPT_QUERY_SOURCE_MANIFEST=Object.freeze({profile:'receipt-query-source-089-v1',files:Object.freeze([
  Object.freeze({path:'packages/fiscal-xml/src/xml.mjs',sha256:'e0ceb379b62c90f473cb761328c84884f7b5f0e98b79ac615d1ca6c46afa5ea9'}),
  Object.freeze({path:'packages/fiscal-authorization/src/index.mjs',sha256:'f26873d907090c526ccd5ae529b51220d6b98f2faf2d84fecba1de238be0e52d'}),
  Object.freeze({path:'packages/fiscal-authorization/src/receipt-core.mjs',sha256:'4582a51c12a359e97d0ec5de148f797555c5ea215d272e13f1aa3d714a230f48'}),
  Object.freeze({path:'packages/fiscal-authorization/src/receipt-query-evidence.mjs',sha256:'14dd0e884d56533b71193e9751012ee030a2421adb6fc3aee702f0c66d372d1e'}),
  Object.freeze({path:'packages/fiscal-authorization/src/receipt-query-receipt.mjs',sha256:'7a116d143d099f75b43628da6e0cd8545088fdb2bd61da83a32bcf89abd0ab5d'}),
  Object.freeze({path:'packages/fiscal-authorization/src/receipt-query-source.mjs',sha256:'828746907bf174adf4032a2a159f62a340c945cc0eed92df4ad8a58cafc6dd48'}),
  Object.freeze({path:'packages/fiscal-authorization/src/receipt-query-processed.mjs',sha256:'5e9128ad8787a03bbe4036c0466ef304b76fee273262db058cf54c44efa647d3'}),
  Object.freeze({path:'packages/fiscal-authorization/src/receipt-soap-binding.mjs',sha256:'f0e13acad5951a28793acfd89cbf7edb6829ffc290248c5350c7d5fe89977722'}),
  Object.freeze({path:'packages/fiscal-authorization/src/receipt-validator.mjs',sha256:'404545f5a34637351ab62c99860999c10ee669032e85ca5a9440a906284cceb5'}),
  Object.freeze({path:'packages/fiscal-authorization/src/receipt-manifest.mjs',sha256:'0a6c08e1ea3c7219cb1993ec3bda35902fec99594781731a8d3149895722dfcc'}),
  Object.freeze({path:'packages/fiscal-authorization/src/receipt-processed.mjs',sha256:'a13bc842cf974ee086f78707e328853875a6f30610acdc5c14e63fc6abcdad6f'}),
  Object.freeze({path:'packages/fiscal-authorization/src/authorization-soap-binding.mjs',sha256:'427e8417246f3a932515448007fd46dccc55cbf63ebff1500cdd0d164ad4c45d'}),
  Object.freeze({path:'packages/fiscal-authorization/src/authorization-soap-manifest.mjs',sha256:'d08f63c2b65418498fc400c74d4c9bd984bff0d7e2a89297bc6d094862af2bf2'}),
  Object.freeze({path:'packages/fiscal-authorization/src/validator.mjs',sha256:'5af4587d0f17cc4fe2898694bf98438ccff62f5aababde8b3b987be1cf01bb00'}),
  Object.freeze({path:'packages/fiscal-authorization/src/pinned-certificate.mjs',sha256:'6c5febbed150a34c8f559b28bc40b81ebb6e97732051115432b5ea06c644c9c8'}),
  Object.freeze({path:'packages/fiscal-authorization/validator.py',sha256:'98453faa968544a8a19d9ae10a29dbbed3015f7e8898062be33bed37b21ad612'}),
  Object.freeze({path:'packages/fiscal-authorization/receipt-validator.py',sha256:'13773b14382b10d559b8a8d5c6d13d03c01f317ce7173e238955996c408662a0'}),
])});
export const RECEIPT_QUERY_SOURCE_MANIFEST_HASH=createHash('sha256').update(JSON.stringify(RECEIPT_QUERY_SOURCE_MANIFEST)).digest('hex');
