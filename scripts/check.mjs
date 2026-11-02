import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
let failed=false,checked=0;
async function visit(path){for(const item of await readdir(path,{withFileTypes:true})){if(['node_modules','.git','dist','.wrangler','release-artifacts'].includes(item.name))continue;const next=join(path,item.name);if(item.isDirectory())await visit(next);else if(item.name.endsWith('.mjs')){const result=spawnSync(process.execPath,['--check',next],{encoding:'utf8'});checked++;if(result.status){console.error(result.stderr);failed=true;}}}}
await visit('apps');await visit('packages');await visit('scripts');console.log(`${checked} JavaScript modules checked.`);process.exitCode=failed?1:0;
