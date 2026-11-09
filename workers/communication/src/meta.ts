import { Env, ApiError, json, requireValue } from "./types";
import { secret } from "./security";
import { metaCredentials } from "./meta-accounts";
export async function metaRequest(
  env: Env,
  conn: any,
  path: string,
  method = "GET",
  body?: any,
) {
  const keys = await metaCredentials(env, conn),
    cfg = json(conn.config);
  const version = /^v\d+\.\d+$/.test(cfg.api_version || "")
    ? cfg.api_version
    : "v23.0";
  let response: Response;
  try {
    response = await fetch(`https://graph.facebook.com/${version}/${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${keys.token}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      // Workers supports manual/follow. Reject 3xx below without forwarding
      // the Meta credential to a redirect destination.
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new ApiError(
      502,
      "meta_unknown",
      "A Meta não confirmou a operação. Consulte o estado antes de tentar novamente.",
    );
  }
  const result = await response.json<any>().catch(() => ({}));
  if (!response.ok)
    throw new ApiError(
      response.status >= 500 ? 502 : 400,
      response.status >= 500 ? "meta_unknown" : "meta_rejected",
      `Meta recusou a operação (HTTP ${response.status}${result.error?.code ? `, código ${result.error.code}` : ""}). Confira as permissões e a configuração do número.`,
    );
  return result;
}
