import { randomUUID } from 'node:crypto';
import { actorFor, can, constantEqual, createToken, isAdmin, SCOPES, tokenHash } from './auth.mjs';
import { VERSION } from './config.mjs';
import { handleBusinessRequest } from './business/router.mjs';
import { handleMcp } from './mcp.mjs';
import { updaterRequest } from './updater.mjs';
import { handleUsers } from './users.mjs';
import { handleFiscalRequest } from './fiscal/router.mjs';
import { openApi } from '../../../spec/openapi.mjs';
import { handleBankingRequest } from './banking/router.mjs';
import { createWebhookSubscription,listWebhookSubscriptions,disableWebhookSubscription,listWebhookDeliveries,retryWebhookDelivery } from './webhook-delivery.mjs';
import { fiscalEngineCapabilities } from '../../../packages/fiscal-engine/capabilities.mjs';

export const json=(value,status=200,headers={})=>Response.json(value,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers}});
export const fiscalCapabilities=(storage=null)=>({configured:!!storage,xml_import:!!storage,engine:fiscalEngineCapabilities,issuance:false,distribution:false,tax_validation:false,cnab_profiles:[],reason:storage?'Importação de XML disponível. Engine de homologação instalado, com envio desativado; coleta automática e validação tributária operacional ainda indisponíveis.':'Engine de homologação instalado, com envio desativado. Configure o armazenamento privado para importar XML.'});
const body=async request=>{if(!/^application\/json(?:;|$)/i.test(request.headers.get('content-type')||''))throw Object.assign(new Error('JSON_REQUIRED'),{status:415});const value=await request.json();if(!value||Array.isArray(value)||typeof value!=='object')throw Object.assign(new Error('INVALID_BODY'),{status:400});return value;};
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value);

export function createApp({pool,auth,config,update=updaterRequest,storage=null}) {
  return async request=>{
    const requestId=randomUUID(),url=new URL(request.url),path=url.pathname;
    try {
      if(path==='/health/ready'&&request.method==='GET'){
        try{await pool.query('SELECT id FROM fagoo.installation LIMIT 1');return json({status:'ready',version:VERSION});}catch{return json({status:'not_ready'},503);}
      }
      if(config.proxySecret&&!constantEqual(request.headers.get('x-fagoo-proxy-secret'),config.proxySecret))return json({error:'PROXY_REQUIRED'},403);
      if(path==='/api/openapi.json'&&request.method==='GET')return json(openApi(config.publicUrl,VERSION));
      if(path==='/.well-known/oauth-authorization-server/api/auth'&&request.method==='GET')return json(await auth.api.getOAuthServerConfig());
      if(path==='/.well-known/fagoo.json'&&request.method==='GET'){
        const {rows}=await pool.query('SELECT id,mobile_client_id FROM fagoo.installation LIMIT 1');
        return json({product:'fagoo',server_id:rows[0]?.id,display_name:'FAGOO',server_version:VERSION,api_version:'1',minimum_client_version:'0.1.0',api_base:'/api/v1',auth_base:'/api/auth',mcp_endpoint:'/api/mcp',oauth:{issuer:config.publicUrl+'/api/auth',discovery:'/.well-known/oauth-authorization-server/api/auth',client_id:rows[0]?.mobile_client_id,scope:'openid profile email offline_access fagoo',pkce:['S256']},capabilities:{integration_api:true,mcp:true,mobile_pkce:true,native_app:false,fiscal:false}},200,{'Cache-Control':'public, max-age=300'});
      }
      if(path.startsWith('/api/auth/'))return auth.handler(request);
      const actor=await actorFor(request,{pool,auth});
      if(!actor)return json({error:'UNAUTHENTICATED',request_id:requestId},401);
      if(!['GET','HEAD','OPTIONS'].includes(request.method)&&actor.kind==='user'&&request.headers.get('origin')!==config.publicUrl)return json({error:'ORIGIN_REQUIRED'},403);
      if(path==='/api/mcp')return handleMcp(request,{pool,actor,storage});
      const deliveries=path.match(/^\/api\/v1\/integrations\/webhooks\/([^/]+)\/deliveries$/);
      const retryDelivery=path.match(/^\/api\/v1\/integrations\/webhooks\/deliveries\/([^/]+)\/retry$/);
      if(deliveries||retryDelivery){
        if(!isAdmin(actor))return json({error:'ADMIN_REQUIRED'},403);
        if(deliveries&&request.method==='GET')return json(await listWebhookDeliveries(pool,actor,deliveries[1],{before:url.searchParams.get('before'),limit:Number(url.searchParams.get('limit')??50)}));
        if(retryDelivery&&request.method==='POST'){await body(request);return json(await retryWebhookDelivery(pool,actor,retryDelivery[1]));}
        return json({error:'METHOD_NOT_ALLOWED'},405);
      }
      if(path==='/api/v1/integrations/webhooks'||/^\/api\/v1\/integrations\/webhooks\/[^/]+$/.test(path)){
        if(!isAdmin(actor))return json({error:'ADMIN_REQUIRED'},403);
        if(path==='/api/v1/integrations/webhooks'&&request.method==='GET')return json(await listWebhookSubscriptions(pool,actor));
        if(path==='/api/v1/integrations/webhooks'&&request.method==='POST')return json(await createWebhookSubscription(pool,config,actor,await body(request)),201);
        if(request.method==='DELETE')return json(await disableWebhookSubscription(pool,actor,path.split('/').at(-1)));
        return json({error:'METHOD_NOT_ALLOWED'},405);
      }
      if(path==='/api/v1/me'&&request.method==='GET'){
        const company=(await pool.query('SELECT id,name,tax_regime FROM fagoo.company WHERE id=$1',[actor.companyId])).rows[0];
        return json({user:actor.user||{id:actor.id,name:actor.name},company,scopes:actor.scopes,capabilities:{admin:isAdmin(actor),fiscal:fiscalCapabilities(storage),mobile:false}});
      }
      if(path==='/api/v1/fiscal/capabilities'&&request.method==='GET')return json(fiscalCapabilities(storage));
      if(path==='/api/v1/mobile/client'&&request.method==='POST'){
        if(!isAdmin(actor))return json({error:'ADMIN_REQUIRED'},403);
        const current=(await pool.query('SELECT mobile_client_id FROM fagoo.installation LIMIT 1')).rows[0];
        if(current.mobile_client_id)return json({client_id:current.mobile_client_id});
        const client=await auth.api.adminCreateOAuthClient({headers:request.headers,body:{client_name:'FAGOO Mobile',redirect_uris:['app.fagoo://oauth/callback'],application_type:'native',token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code'],scope:'openid profile email offline_access fagoo',require_pkce:true,skip_consent:false}});
        await pool.query('UPDATE fagoo.installation SET mobile_client_id=$1 WHERE singleton=true',[client.client_id]);
        return json({client_id:client.client_id},201);
      }
      if(path.startsWith('/api/v1/system/updates')){
        if(!isAdmin(actor))return json({error:'ADMIN_REQUIRED'},403);
        const action=path.slice('/api/v1/system/updates'.length);
        if(!((action===''&&request.method==='GET')||(['/check','/request'].includes(action)&&request.method==='POST')))return json({error:'NOT_FOUND'},404);
        try{
          const input=request.method==='POST'?await body(request):undefined;
          if(action==='/request'&&!/^v?\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(input.version||''))return json({error:'INVALID_VERSION'},400);
          const result=await update(config,action==='/check'?'/v1/check':action==='/request'?'/v1/update':'/v1/status',action==='/request'?{version:input.version}:input);
          if(action==='/request')await pool.query('INSERT INTO fagoo.security_audit(company_id,actor_id,action,target) VALUES($1,$2,$3,$4)',[actor.companyId,actor.id,'update.request',input.version]);
          return json({installed:VERSION,...result},action==='/request'?202:200);
        }catch(error){return json({installed:VERSION,latest:null,status:'unavailable',backup:null,error:'UPDATER_UNAVAILABLE',message:'O atualizador local não está disponível. Verifique a instalação e os logs do serviço.'},error.status||503);}
      }
      if(path==='/api/v1/integrations'||/^\/api\/v1\/integrations\/[^/]+$/.test(path)){
        if(!isAdmin(actor))return json({error:'ADMIN_REQUIRED'},403);
        if(path==='/api/v1/integrations'&&request.method==='GET'){
          const result=await pool.query('SELECT id,name,scopes,created_at,expires_at,revoked_at FROM fagoo.integration WHERE company_id=$1 ORDER BY created_at DESC',[actor.companyId]);return json({items:result.rows,available_scopes:SCOPES});
        }
        if(path==='/api/v1/integrations'&&request.method==='POST'){
          const input=await body(request);
          if(typeof input.name!=='string'||!input.name.trim()||input.name.length>120||!Array.isArray(input.scopes)||!input.scopes.length||input.scopes.some(s=>!SCOPES.includes(s)))return json({error:'INVALID_INTEGRATION'},400);
          const days=input.expires_in_days??90;if(!Number.isInteger(days)||days<1||days>365)return json({error:'INVALID_EXPIRY'},400);
          const id=randomUUID(),token=createToken();const result=await pool.query('INSERT INTO fagoo.integration(id,company_id,name,token_hash,scopes,created_by,expires_at) VALUES($1,$2,$3,$4,$5,$6,now()+($7::integer*interval \'1 day\')) RETURNING id,name,scopes,expires_at',[id,actor.companyId,input.name.trim(),tokenHash(token),JSON.stringify([...new Set(input.scopes)]),actor.id,days]);
          await pool.query('INSERT INTO fagoo.security_audit(company_id,actor_id,action,target) VALUES($1,$2,$3,$4)',[actor.companyId,actor.id,'integration.create',id]);
          return json({...result.rows[0],token},201);
        }
        if(request.method==='DELETE'){
          const id=path.split('/').at(-1);if(!uuid(id))return json({error:'INVALID_ID'},400);
          const result=await pool.query('UPDATE fagoo.integration SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1 AND company_id=$2 RETURNING id',[id,actor.companyId]);if(!result.rowCount)return json({error:'NOT_FOUND'},404);
          await pool.query('INSERT INTO fagoo.security_audit(company_id,actor_id,action,target) VALUES($1,$2,$3,$4)',[actor.companyId,actor.id,'integration.revoke',id]);return json({revoked:true,id});
        }
        return json({error:'METHOD_NOT_ALLOWED'},405);
      }
      return await handleUsers(request,{pool,actor,config})||await handleBankingRequest(request,{pool,actor})||await handleFiscalRequest(request,{pool,actor,storage})||await handleBusinessRequest(request,{pool,actor})||json({error:'NOT_FOUND'},404);
    }catch(error){
      const status=error.status||((error instanceof SyntaxError)?400:500);
      if(status>=500)console.error(JSON.stringify({request_id:requestId,error:'INTERNAL_ERROR',code:error.code||'unknown'}));
      return json({error:status<500?error.message:'INTERNAL_ERROR',request_id:requestId},status);
    }
  };
}
