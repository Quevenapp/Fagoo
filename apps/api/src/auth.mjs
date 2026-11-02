import { betterAuth } from 'better-auth';
import { jwt } from 'better-auth/plugins';
import { oauthProvider } from '@better-auth/oauth-provider';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const SCOPES = Object.freeze(['catalog:read','catalog:write','orders:read','orders:write','stock:read','stock:write','finance:read','finance:write','pricing:write','pricing:override','fiscal:read','fiscal:write','analytics:read','events:read','events:write']);
export function authOptions(pool, config, { bootstrap = false } = {}) {
  const administrator=async context=>!!context.user&&(await pool.query("SELECT 1 FROM fagoo.member WHERE user_id=$1 AND role='admin' AND active=true",[context.user.id])).rowCount>0;
  return { appName:'FAGOO', baseURL:config.publicUrl, basePath:'/api/auth', secret:config.secret, database:pool,
    trustedOrigins:[config.publicUrl], emailAndPassword:{ enabled:true, disableSignUp:!bootstrap, minPasswordLength:12, maxPasswordLength:128, autoSignIn:false },
    session:{ expiresIn:60*60*24*7, updateAge:60*60*24 }, rateLimit:{ enabled:true, window:60, max:60 },
    advanced:{ useSecureCookies:config.production }, logger:{ level:'error' },
    plugins:[jwt(),oauthProvider({loginPage:'/login',consentPage:'/oauth/consent',scopes:['openid','profile','email','offline_access','fagoo'],grantTypes:['authorization_code','refresh_token'],allowDynamicClientRegistration:false,allowUnauthenticatedClientRegistration:false,clientPrivileges:administrator,resourcePrivileges:administrator,customUserInfoClaims:({scopes})=>({fagoo_access:scopes.includes('fagoo')})})]
  };
}
export const createAuth=(...args)=>betterAuth(authOptions(...args));
export const tokenHash = token => createHash('sha256').update(token).digest('hex');
export const createToken = () => `fagoo_${randomBytes(32).toString('base64url')}`;
export function constantEqual(a,b) { if(typeof a !== 'string' || typeof b !== 'string') return false; const aa=Buffer.from(a),bb=Buffer.from(b);return aa.length===bb.length&&timingSafeEqual(aa,bb); }
export async function actorFor(request, { pool, auth }) {
  const header=request.headers.get('authorization');
  if(header) {
    const token=/^Bearer (fagoo_[A-Za-z0-9_-]{43})$/.exec(header)?.[1];
    if(!token) {
      if(!/^Bearer [^\s]{20,8192}$/.test(header))return null;
      try{const info=await auth.api.oauth2UserInfo({headers:request.headers});if(!info?.fagoo_access||!info.sub)return null;
        const member=(await pool.query('SELECT company_id,role,scopes FROM fagoo.member WHERE user_id=$1 AND active=true',[info.sub])).rows[0];if(!member)return null;
        return{id:info.sub,companyId:member.company_id,scopes:member.role==='admin'?SCOPES:member.scopes,kind:'oauth',name:info.name,user:{id:info.sub,name:info.name,email:info.email}};
      }catch{return null;}
    }
    const {rows}=await pool.query('SELECT id,company_id,name,scopes FROM fagoo.integration WHERE token_hash=$1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now())',[tokenHash(token)]);
    if(!rows[0])return null;
    return {id:`integration:${rows[0].id}`,integrationId:rows[0].id,companyId:rows[0].company_id,name:rows[0].name,scopes:rows[0].scopes,kind:'integration'};
  }
  const session=await auth.api.getSession({headers:request.headers});
  if(!session?.user)return null;
  const {rows}=await pool.query('SELECT company_id,role,scopes FROM fagoo.member WHERE user_id=$1 AND active=true',[session.user.id]);
  if(rows.length!==1)return null;
  return {id:session.user.id,companyId:rows[0].company_id,scopes:rows[0].role==='admin'?['*']:rows[0].scopes,kind:'user',name:session.user.name,user:{id:session.user.id,name:session.user.name,email:session.user.email}};
}
export const can = (actor,scope) => actor.scopes.includes('*')||actor.scopes.includes(scope);
export const isAdmin = actor => actor.kind==='user'&&actor.scopes.includes('*');
