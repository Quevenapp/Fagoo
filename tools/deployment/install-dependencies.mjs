/** Prepare every independently locked package needed by the application build. */
import {readFileSync, existsSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const root=resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const packages=['.', 'workers/erp-api', 'packages/fiscal-xml', 'packages/fiscal-danfe'];
const read=path=>JSON.parse(readFileSync(path, 'utf8'));

function verifyInstalled() {
  const missing=[];
  for (const directory of packages) {
    const path=resolve(root,directory);
    const manifest=read(join(path,'package.json'));
    const lock=read(join(path,'package-lock.json'));
    for (const name of Object.keys({...manifest.dependencies,...manifest.devDependencies})) {
      const expected=lock.packages?.['node_modules/'+name]?.version;
      let installed;
      try { installed=read(join(path,'node_modules',...name.split('/'),'package.json')).version; } catch {}
      if (!expected || installed!==expected) missing.push(directory+': '+name);
    }
  }
  if (missing.length) {
    console.error('Deployment dependencies are missing or differ from their lockfiles:\n'+missing.join('\n'));
    throw new Error('DEPENDENCIES_REQUIRED: run npm run install:deployment from the repository root.');
  }
  console.log('All four application dependency trees match their direct locked dependencies.');
}

try {
  if (process.argv.length===3 && process.argv[2]==='--check') {
    verifyInstalled();
  } else {
    if (process.argv.length!==2) throw new Error('Unsupported argument. Use --check or npm run install:deployment.');
    if (Number(process.versions.node.split('.')[0])!==24) throw new Error('Node.js 24 is required for deployment preparation.');
    const npm=process.env.npm_execpath;
    if (!npm || !existsSync(npm)) throw new Error('Run this installer with npm run install:deployment.');
    for (const directory of packages) {
      console.log('Installing locked dependencies: '+directory);
      const result=spawnSync(process.execPath,[npm,'ci','--include=dev','--prefix',resolve(root,directory)],{cwd:root,stdio:'inherit'});
      if (result.error || result.status!==0) throw new Error('Dependency installation failed for '+directory+'.');
    }
    verifyInstalled();
  }
} catch (error) {
  console.error(error.message);
  process.exitCode=1;
}
