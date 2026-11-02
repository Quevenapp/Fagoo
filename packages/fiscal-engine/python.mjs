import {existsSync} from 'node:fs';
import {isAbsolute} from 'node:path';
import {spawnSync} from 'node:child_process';

/** Resolve an installed local interpreter; never downloads or executes remote code. */
export function fiscalPythonPath(environment=process.env){
  const configured=environment.FAGOO_TEST_PYTHON??environment.FAGOO_FISCAL_PYTHON??environment.PYTHON;
  if(configured){if(!isAbsolute(configured)||!existsSync(configured))throw Error('FISCAL_PYTHON_PATH_INVALID');return configured;}
  if(existsSync('/opt/fiscal-validator/bin/python3'))return '/opt/fiscal-validator/bin/python3';
  for(const command of process.platform==='win32'?['python','python3']:['python3','python']){
    const result=spawnSync(command,['-I','-c','import sys; print(sys.executable)'],{encoding:'utf8',timeout:3000,maxBuffer:4096,shell:false,windowsHide:true});
    const executable=result.status===0?result.stdout.trim():'';
    if(isAbsolute(executable)&&existsSync(executable))return executable;
  }
  throw Error('FISCAL_PYTHON_NOT_INSTALLED');
}
