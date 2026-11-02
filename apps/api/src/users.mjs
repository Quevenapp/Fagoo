import { createAuth, isAdmin, SCOPES } from './auth.mjs';
const reply=(data,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store'}});
export async function handleUsers(request,{pool,actor,config}){
 const path=new URL(request.url).pathname;if(path!=='/api/v1/users'&&!/^\/api\/v1\/users\/[^/]+$/.test(path))return null;
 if(!isAdmin(actor))return reply({error:'ADMIN_REQUIRED'},403);
 if(request.method==='GET'&&path==='/api/v1/users'){const result=await pool.query('SELECT u.id,u.name,u.email,m.role,m.scopes,m.active FROM fagoo.member m JOIN "user" u ON u.id=m.user_id WHERE m.company_id=$1 ORDER BY u.name,u.id',[actor.companyId]);return reply({items:result.rows,available_scopes:SCOPES});}
 if(!['POST','PATCH'].includes(request.method)||!request.headers.get('content-type')?.includes('application/json'))return reply({error:'METHOD_NOT_ALLOWED'},405);
 const input=await request.json();if(!input||Array.isArray(input)||!['admin','operator'].includes(input.role)||!Array.isArray(input.scopes)||input.scopes.some(s=>!SCOPES.includes(s)))return reply({error:'INVALID_USER'},400);
 if(request.method==='POST'&&path==='/api/v1/users'){
  if(typeof input.name!=='string'||!input.name.trim()||input.name.length>200||typeof input.email!=='string'||typeof input.password!=='string'||input.password.length<12||input.password.length>128)return reply({error:'INVALID_USER'},400);
  let user;
  try{const auth=createAuth(pool,config,{bootstrap:true});user=(await auth.api.signUpEmail({body:{name:input.name.trim(),email:input.email,password:input.password}})).user;
   await pool.query('INSERT INTO fagoo.member(user_id,company_id,role,scopes) VALUES($1,$2,$3,$4)',[user.id,actor.companyId,input.role,JSON.stringify([...new Set(input.scopes)])]);
   await pool.query('INSERT INTO fagoo.security_audit(company_id,actor_id,action,target) VALUES($1,$2,$3,$4)',[actor.companyId,actor.id,'user.create',user.id]);
   return reply({user:{id:user.id,name:user.name,email:user.email},role:input.role,scopes:input.scopes,active:true},201);
  }catch(error){if(user)await pool.query('DELETE FROM "user" WHERE id=$1',[user.id]);return reply({error:'USER_CREATE_FAILED'},error.statusCode||409);}
 }
 if(request.method==='PATCH'){
  const target=decodeURIComponent(path.split('/').at(-1));if(!target||target.length>128||typeof input.active!=='boolean')return reply({error:'INVALID_USER'},400);
  const client=await pool.connect();try{await client.query('BEGIN');await client.query('SELECT id FROM fagoo.company WHERE id=$1 FOR UPDATE',[actor.companyId]);
   const row=(await client.query('SELECT * FROM fagoo.member WHERE user_id=$1 AND company_id=$2',[target,actor.companyId])).rows[0];if(!row){await client.query('ROLLBACK');return reply({error:'NOT_FOUND'},404);}
   if(row.role==='admin'&&row.active&&(!input.active||input.role!=='admin')){const admins=await client.query("SELECT user_id FROM fagoo.member WHERE company_id=$1 AND role='admin' AND active=true",[actor.companyId]);if(admins.rowCount===1){await client.query('ROLLBACK');return reply({error:'LAST_ADMIN_REQUIRED'},409);}}
   await client.query('UPDATE fagoo.member SET role=$3,scopes=$4,active=$5 WHERE user_id=$1 AND company_id=$2',[target,actor.companyId,input.role,JSON.stringify([...new Set(input.scopes)]),input.active]);
   await client.query('DELETE FROM "session" WHERE "userId"=$1',[target]);
   await client.query('INSERT INTO fagoo.security_audit(company_id,actor_id,action,target) VALUES($1,$2,$3,$4)',[actor.companyId,actor.id,'user.update',target]);await client.query('COMMIT');return reply({id:target,role:input.role,scopes:input.scopes,active:input.active});
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 }
 return reply({error:'NOT_FOUND'},404);
}
