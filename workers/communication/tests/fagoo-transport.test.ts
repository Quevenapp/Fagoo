import {it,expect} from 'vitest';
import {communicationPath,rawCommunicationOptions,communicationFailure} from '../web/fagoo-transport';
import {documentationHref,managedApiOperations} from '../web/api-reference';
it('uses the full canonical Fagoo prefix and never lets embedded UI change unit',()=>{
 const unit='11111111-1111-1111-1111-111111111111';
 expect(communicationPath(`v1/profiles/${unit}/conversations?limit=5`,unit)).toBe(`/v1/communication/units/${unit}/conversations?limit=5`);
 expect(communicationPath('v1/applications',unit)).toBe(`/v1/communication/units/${unit}/applications`);
 expect(()=>communicationPath('v1/profiles/other/media/file',unit)).toThrow();
});
it('presents useful failures while preserving the original access error and uncertain writes',()=>{
 class AccessError extends Error{status=503;code='COMMUNICATION_AUTHORITY_UNAVAILABLE';constructor(){super('access_request_failed');}}
 const original=new AccessError(),read=communicationFailure(original);
 expect(read).toBe(original);expect(read).toBeInstanceOf(AccessError);expect(read).toMatchObject({status:503,code:'COMMUNICATION_AUTHORITY_UNAVAILABLE'});
 expect(read.message).toContain('atualizar o atendimento');expect(read.message).not.toContain('access_request_failed');
 const write=communicationFailure(new AccessError(),'POST');expect(write.message).toContain('Confira o resultado');
 const aborted=new DOMException('Request cancelled','AbortError');expect(communicationFailure(aborted)).toBe(aborted);
});
it('documents only existing delegated operations with Fagoo unit paths and no standalone authentication',()=>{
 const unit='11111111-1111-1111-1111-111111111111',rows=managedApiOperations(unit);
 expect(rows.some(row=>row.method==='GET'&&row.path===`/v1/communication/units/${unit}/conversations`)).toBe(true);
 expect(rows.some(row=>row.method==='POST'&&row.path.endsWith('/conversations/{id}/actions'))).toBe(true);
 expect(rows.every(row=>row.path.startsWith(`/v1/communication/units/${unit}/`))).toBe(true);
 expect(JSON.stringify(rows)).not.toMatch(/wabu_|\/auth\/|\/system\/|\/users|\/pairings|\/contacts/);
 expect(documentationHref(unit)).toBe(`/atendimento?unit=${unit}&page=api-docs`);
 expect(()=>managedApiOperations('other-unit')).toThrow();
});
it('preserves binary bodies and decodes serialized JSON exactly once',()=>{
 const binary=new Uint8Array([1,2,3]);
 expect(rawCommunicationOptions({method:'PUT',body:binary,headers:{'Content-Type':'application/octet-stream'}}).body).toBe(binary);
 expect(rawCommunicationOptions({method:'POST',body:'{"x":1}',headers:{'Content-Type':'application/json','Idempotency-Key':'same'}})).toMatchObject({body:{x:1},idempotencyKey:'same',contentType:'application/json',rawResponse:true});
});
