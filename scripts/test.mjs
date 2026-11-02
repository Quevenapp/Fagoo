import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
async function files(path){const out=[];for(const item of await readdir(path,{withFileTypes:true})){if(['node_modules','.git','dist','.wrangler'].includes(item.name))continue;const next=join(path,item.name);if(item.isDirectory())out.push(...await files(next));else if(item.name.endsWith('.test.mjs'))out.push(next);}return out;}
const tests=[...await files('apps'),...await files('packages')];
const result=spawnSync(process.execPath,['--test','--test-concurrency=2',...tests],{stdio:'inherit'});process.exitCode=result.status??1;
