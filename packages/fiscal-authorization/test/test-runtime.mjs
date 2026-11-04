// Test runtime of the official fiscal validators (validator.py, receipt-validator.py).
// BRUFAP_TEST_PYTHON wins; otherwise the repository virtualenv described in docs/verification.md
// (.venv with packages/fiscal-schema/requirements.txt); otherwise the system python3. The validators
// only accept an absolute interpreter path.
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const venvPython=fileURLToPath(new URL('../../../.venv/bin/python3',import.meta.url));
export const TEST_PYTHON=process.env.BRUFAP_TEST_PYTHON||(existsSync(venvPython)?venvPython:'/usr/bin/python3');

// The validators are pinned by hash and resolve their XSD includes as POSIX file paths, as in the Linux
// fiscal runtime (/opt/fiscal-validator). On Windows a drive-letter file URI is refused by that resolver,
// so the cases that need the real validator run on Linux (WSL or the fiscal container) instead.
export const FISCAL_VALIDATOR_SKIP=process.platform==='win32'
 ?'Validador fiscal oficial: execute no Linux (WSL ou container fiscal); o resolvedor de XSD fixado não aceita caminhos de unidade do Windows.'
 :false;
