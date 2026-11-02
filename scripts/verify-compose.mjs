#!/usr/bin/env node
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,unlink,rmdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';

const directory=await mkdtemp(join(tmpdir(),'fagoo-compose-check-')),envFile=join(directory,'empty.env');
try{
 await writeFile(envFile,'');
 const result=spawnSync('docker',['compose','--env-file',envFile,'-f',resolve(import.meta.dirname,'../infra/compose.yaml'),'config','--format','json'],{encoding:'utf8',env:{...process.env,FAGOO_HOME:'/opt/fagoo',FAGOO_IMAGE:'fagoo/test:validation',FAGOO_PUBLIC_URL:'https://erp.example.com',POSTGRES_PASSWORD:'test-only-database-password',BETTER_AUTH_SECRET:'test-only-auth-secret-at-least-32-characters',FAGOO_UPDATER_GID:'1000'}});
 if(result.status!==0)throw new Error(result.stderr||'Docker Compose configuration check failed');
 const config=JSON.parse(result.stdout);
 for(const name of['api','jobs']){
  const service=config.services[name];assert(Array.isArray(service.tmpfs)&&service.tmpfs.length===1,'Exactly one tmpfs mount is required');
  assert(service.tmpfs[0].startsWith('/tmp:')&&service.tmpfs[0].includes('mode=1777'),'tmpfs mode must remain part of the mount options');
  assert(service.read_only);assert(service.cap_drop.includes('ALL'));
  assert(!service.volumes?.some(volume=>String(volume.source).endsWith('docker.sock')),'Application cannot access Docker socket');
 }
 assert.equal(config.services.api.ports[0].host_ip,'127.0.0.1');assert(!config.services.postgres.ports?.length);
 console.log('Compose verified: single tmpfs mounts, loopback binding, private PostgreSQL and no application Docker socket.');
}finally{await unlink(envFile);await rmdir(directory);}
