import { Pool } from 'pg';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { getMigrations } from 'better-auth/db/migration';
import { migrate } from '../../../packages/database/migrate.mjs';
import { configuration } from './config.mjs';
import { authOptions } from './auth.mjs';
import { migrateWebhooks } from './webhook-delivery.mjs';
export async function migrateAll(pool, config) {
  await migrate(pool);
  const plan=await getMigrations(authOptions(pool,config));
  if(plan.schemaProblems.length||plan.unsafeChanges.length)throw new Error('Authentication schema requires manual review');
  await plan.runMigrations();
  await pool.query(await readFile(new URL('../sql/system.sql',import.meta.url),'utf8'));
  await migrateWebhooks(pool);
  await pool.query('INSERT INTO fagoo.installation(singleton,id) VALUES(true,$1) ON CONFLICT(singleton) DO NOTHING',[randomUUID()]);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const config=configuration(),pool=new Pool({connectionString:config.databaseUrl,max:3});
  try{await migrateAll(pool,config);console.log('FAGOO migrations completed.');}catch(error){console.error(error.message);process.exitCode=1;}finally{await pool.end();}
}
