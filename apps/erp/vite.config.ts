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
  resolve: {dedupe: ['react','react-dom']},
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false, rollupOptions: {output: {
    // Keep inherited worker assets compatible with the signed updater's retained-asset grammar.
    assetFileNames(asset) { const name=(asset.names?.[0] || 'asset').replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_-]/g,'-'); return `assets/${name}-[hash][extname]`; },
  }} },
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true },
  plugins: [{
    name: 'brufap-exact-connect-origins',
    async writeBundle(output) {
      const source = await readFile(new URL('./public/_headers', import.meta.url), 'utf8');
      const origins = config ? [...new Set([config.supabaseUrl, config.apiUrl, ...(config.a1ApiUrl ? [config.a1ApiUrl] : [])])].join(' ') : '';
      await writeFile(resolve(output.dir || resolve(root, 'dist'), '_headers'), source.replace("connect-src 'self';", `connect-src 'self'${origins ? ` ${origins}` : ''};`));
      // The native client discovers this installation from its web address. accessConfig has already
      // rejected service-role keys; only the same public Auth settings used by the web are distributed.
      if(config)await writeFile(resolve(output.dir || resolve(root,'dist'),'fagoo-mobile.json'),JSON.stringify({
        product:'fagoo',protocol:1,online_required:true,api_url:config.apiUrl,auth_url:config.supabaseUrl,public_key:config.publicKey,
        modes:['panel','communication'],foreground_poll_ms:2000,
      }));
    },
  }],
  };
});
