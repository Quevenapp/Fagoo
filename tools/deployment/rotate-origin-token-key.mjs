// Gera uma TOKEN_ENCRYPTION_KEY nova (32 bytes, base64) e grava a mesma chave no coletor (fagoo-origin-sync) e na API
// (fagoo-erp-api); gera também um INTEGRATION_ADMIN_TOKEN novo para o coletor. A chave nunca é impressa; o token de
// administrador aparece uma vez, para colar na página do coletor. Depois, reconecte o Origin nessa página: o token do
// Origin guardado com a chave antiga deixa de abrir até a reconexão.
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const put = (name, value, config) => {
  const result = spawnSync('npx', ['wrangler', 'secret', 'put', name, '--config', config], { input: value, stdio: ['pipe', 'inherit', 'inherit'], shell: true });
  if (result.status !== 0) { console.error(`Falhou ao gravar ${name} em ${config}. Rode o script de novo: ele gera valores novos e grava tudo.`); process.exit(1); }
};

const key = randomBytes(32).toString('base64');
const admin = randomBytes(32).toString('base64url');
put('TOKEN_ENCRYPTION_KEY', key, 'workers/origin-sync/wrangler.jsonc');
put('TOKEN_ENCRYPTION_KEY', key, 'workers/erp-api/wrangler.jsonc');
put('INTEGRATION_ADMIN_TOKEN', admin, 'workers/origin-sync/wrangler.jsonc');

console.log('\nChave gravada no coletor e na API.');
console.log('Token de administrador do coletor (guarde num gerenciador de senhas; ele não aparece de novo):\n');
console.log(`  ${admin}\n`);
console.log('Abra a URL pública configurada para esta instalação do coletor, cole o token acima e clique em Conectar.');
