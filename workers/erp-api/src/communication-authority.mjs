import { WorkerEntrypoint } from 'cloudflare:workers';
import { createServiceRpc } from './platform.mjs';
/** Re-export as a named entrypoint; never route this method through public fetch. */
export class FagooCommunicationAuthority extends WorkerEntrypoint {
  async projectContact({unitId,namespace,sourceId,name,phone}) {
    const rpc=createServiceRpc({baseUrl:this.env.SUPABASE_URL,key:this.env.SUPABASE_SERVICE_ROLE_KEY});
    return rpc('fagoo_contact_project',{p_unit_id:unitId,p_source_namespace:namespace,p_source_id:sourceId,p_name:name,p_phone:phone});
  }
  async subscribeWhatsApp({unitId,token,phone}) {
    const rpc=createServiceRpc({baseUrl:this.env.SUPABASE_URL,key:this.env.SUPABASE_SERVICE_ROLE_KEY});
    return rpc('fagoo_queue_whatsapp_subscribe',{p_unit_id:unitId,p_token:token,p_phone:phone});
  }
  async noticeAllowed({noticeId,claimId,deliveryId}) {
    const rpc=createServiceRpc({baseUrl:this.env.SUPABASE_URL,key:this.env.SUPABASE_SERVICE_ROLE_KEY});
    return rpc('fagoo_queue_notice_delivery_allowed',{p_notice_id:noticeId,p_claim_id:claimId,p_delivery_id:deliveryId});
  }
  async authorize({userId,unitId,capability}) {
    const rpc=createServiceRpc({baseUrl:this.env.SUPABASE_URL,key:this.env.SUPABASE_SERVICE_ROLE_KEY});
    return rpc('fagoo_communication_context',{p_user_id:userId,p_unit_id:unitId,p_capability:capability});
  }
}
