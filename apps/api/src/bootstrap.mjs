import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { configuration } from './config.mjs';
import { createAuth } from './auth.mjs';
export async function bootstrap(pool,config,{email,password,name,company}) {
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email||'')||password?.length<12||password?.length>128||!name?.trim()||!company?.trim()) throw new Error('Provide valid email, name, company and a password of 12–128 characters');
  const connection=await pool.connect();let createdUser;
  try{
    await connection.query('BEGIN');
    await connection.query('SELECT pg_advisory_xact_lock(72410001)');
    if((await connection.query('SELECT 1 FROM fagoo.member LIMIT 1')).rows.length)throw new Error('Installation already initialized');
    const auth=createAuth(pool,config,{bootstrap:true});
    const result=await auth.api.signUpEmail({body:{email,password,name}});createdUser=result.user.id;
    const companyId=randomUUID(),warehouseId=randomUUID();
    await connection.query('INSERT INTO fagoo.company(id,name) VALUES($1,$2)',[companyId,company.trim()]);
    await connection.query('INSERT INTO fagoo.warehouse(company_id,id,name) VALUES($1,$2,$3)',[companyId,warehouseId,'Principal']);
    await connection.query("INSERT INTO fagoo.member(user_id,company_id,role,scopes) VALUES($1,$2,'admin','[]')",[createdUser,companyId]);
    await connection.query('COMMIT');return {userId:createdUser,companyId,warehouseId};
  }catch(error){await connection.query('ROLLBACK');if(createdUser)await pool.query('DELETE FROM "user" WHERE id=$1',[createdUser]);throw error;}finally{connection.release();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const args=process.argv.slice(2),value=key=>args[args.indexOf(key)+1];
  if(args.includes('--status')){const config=configuration(),pool=new Pool({connectionString:config.databaseUrl,max:1});try{console.log(JSON.stringify({initialized:!!(await pool.query('SELECT 1 FROM fagoo.member LIMIT 1')).rows.length}));}finally{await pool.end();}}
  else if(!args.includes('--password-stdin')||!['--email','--name','--company'].every(k=>args.includes(k))){console.error('Usage: npm run bootstrap -- --email EMAIL --name NAME --company COMPANY --password-stdin');process.exitCode=1;}
  else{let password='';for await(const chunk of process.stdin){password+=chunk;if(password.length>1024)throw new Error('Password input too long');}password=password.replace(/\r?\n$/,'');const config=configuration(),pool=new Pool({connectionString:config.databaseUrl,max:3});
    try{const result=await bootstrap(pool,config,{email:value('--email'),name:value('--name'),company:value('--company'),password});console.log(JSON.stringify({initialized:true,...result}));}catch(error){console.error(error.message);process.exitCode=1;}finally{password='';await pool.end();}}
}
