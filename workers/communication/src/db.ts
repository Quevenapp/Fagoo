import type { Env } from "./types";
export async function one<T = any>(
  env: Env,
  sql: string,
  ...args: any[]
): Promise<T | null> {
  return env.DB.prepare(sql)
    .bind(...args)
    .first<T>();
}
export async function all<T = any>(
  env: Env,
  sql: string,
  ...args: any[]
): Promise<T[]> {
  return (
    await env.DB.prepare(sql)
      .bind(...args)
      .all<T>()
  ).results;
}
export async function exec(env: Env, sql: string, ...args: any[]) {
  return env.DB.prepare(sql)
    .bind(...args)
    .run();
}
export async function batch(env: Env, items: [string, any[]][]) {
  return env.DB.batch(
    items.map(([sql, args]) => env.DB.prepare(sql).bind(...args)),
  );
}
