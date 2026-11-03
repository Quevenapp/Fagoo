import { defineConfig, loadEnv } from 'vite';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { accessConfig } from './src/lib/access-config.ts';

const root = fileURLToPath(new URL('.', import.meta.url));
export default defineConfig(({ mode, command }) => {
  const config = accessConfig(loadEnv(mode, root, 'VITE_'));
  if (command === 'build' && mode === 'production' && !config) throw new Error('ERP_PUBLIC_ACCESS_CONFIG_REQUIRED');
  return {
  root,
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true },
  plugins: [{
    name: 'brufap-exact-connect-origins',
    async writeBundle(output) {
      const source = await readFile(new URL('./public/_headers', import.meta.url), 'utf8');
      const origins = config ? [...new Set([config.supabaseUrl, config.apiUrl, ...(config.a1ApiUrl ? [config.a1ApiUrl] : [])])].join(' ') : '';
      await writeFile(resolve(output.dir || resolve(root, 'dist'), '_headers'), source.replace("connect-src 'self';", `connect-src 'self'${origins ? ` ${origins}` : ''};`));
    },
  }],
  };
});
