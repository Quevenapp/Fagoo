import { readFileSync } from 'node:fs';
export const VERSION = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')).version;
export function configuration(env = process.env) {
  const publicUrl = new URL(env.FAGOO_PUBLIC_URL || 'http://localhost:3000');
  if (publicUrl.username || publicUrl.password || publicUrl.pathname !== '/' || publicUrl.search || publicUrl.hash) throw new Error('FAGOO_PUBLIC_URL must be an origin');
  if (publicUrl.protocol !== 'https:' && !(publicUrl.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(publicUrl.hostname))) throw new Error('HTTPS is required outside localhost');
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  if (!env.BETTER_AUTH_SECRET || env.BETTER_AUTH_SECRET.length < 32) throw new Error('BETTER_AUTH_SECRET needs at least 32 characters');
  return { databaseUrl:env.DATABASE_URL, publicUrl:publicUrl.origin, secret:env.BETTER_AUTH_SECRET, port:Number(env.PORT || 3000), proxySecret:env.FAGOO_PROXY_SECRET || '', updaterSocket:env.FAGOO_UPDATER_SOCKET || '/run/fagoo/updater.sock', updaterTokenFile:env.FAGOO_UPDATER_TOKEN_FILE || '/run/secrets/updater-token', production:publicUrl.protocol === 'https:' };
}
