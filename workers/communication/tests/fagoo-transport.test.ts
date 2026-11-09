import {it,expect} from 'vitest';
import {communicationPath,rawCommunicationOptions} from '../web/fagoo-transport';
it('uses the full canonical Fagoo prefix and never lets embedded UI change unit',()=>{
 const unit='11111111-1111-1111-1111-111111111111';
 expect(communicationPath(`v1/profiles/${unit}/conversations?limit=5`,unit)).toBe(`/v1/communication/units/${unit}/conversations?limit=5`);
 expect(communicationPath('v1/applications',unit)).toBe(`/v1/communication/units/${unit}/applications`);
 expect(()=>communicationPath('v1/profiles/other/media/file',unit)).toThrow();
});
it('preserves binary bodies and decodes serialized JSON exactly once',()=>{
 const binary=new Uint8Array([1,2,3]);
 expect(rawCommunicationOptions({method:'PUT',body:binary,headers:{'Content-Type':'application/octet-stream'}}).body).toBe(binary);
 expect(rawCommunicationOptions({method:'POST',body:'{"x":1}',headers:{'Content-Type':'application/json','Idempotency-Key':'same'}})).toMatchObject({body:{x:1},idempotencyKey:'same',contentType:'application/json',rawResponse:true});
});
