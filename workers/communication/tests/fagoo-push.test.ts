import {it,expect} from 'vitest';
import {fcmMessage} from '../src/push-fcm';

it('managed iOS push is silent data and cannot display after switching to panel',()=>{
 const value=fcmMessage({platform:'ios',token:'synthetic',title:'Fagoo',body:'Novo aviso',data:{user_id:'actor',unit_id:'unit'},priority:'high',data_only:true}) as any;
 expect(value.message.notification).toBeUndefined();
 expect(value.message.apns.headers['apns-push-type']).toBe('background');
 expect(value.message.apns.headers['apns-priority']).toBe('5');
 expect(value.message.apns.payload.aps).toEqual({'content-available':1});
 expect(value.message.data.user_id).toBe('actor');
});
