const headers = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
};
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const isApi =
      url.pathname === "/api" ||
      url.pathname.startsWith("/api/") ||
      url.pathname === "/.well-known/fagoo.json" ||
      url.pathname === "/.well-known/oauth-authorization-server/api/auth";
    let response;
    if (isApi) {
      let upstream;
      try {
        upstream = new URL(env.FAGOO_API_ORIGIN);
      } catch {
        return Response.json(
          {
            error: {
              code: "SERVER_NOT_CONFIGURED",
              message: "A conexão com o servidor ainda não foi configurada.",
            },
          },
          { status: 503 },
        );
      }
      if (
        upstream.protocol !== "https:" ||
        upstream.username ||
        upstream.password ||
        upstream.pathname !== "/" ||
        upstream.search ||
        upstream.hash ||
        upstream.origin === url.origin
      )
        return Response.json(
          {
            error: {
              code: "SERVER_NOT_CONFIGURED",
              message: "O endereço do servidor precisa ser revisado.",
            },
          },
          { status: 503 },
        );
      const target = new URL(url.pathname + url.search, upstream.origin);
      const proxyHeaders = new Headers(request.headers);
      proxyHeaders.delete("x-fagoo-proxy-secret");
      proxyHeaders.set("X-Forwarded-Host", url.host);
      proxyHeaders.set("X-Forwarded-Proto", "https");
      if (env.FAGOO_PROXY_SECRET)
        proxyHeaders.set("X-Fagoo-Proxy-Secret", env.FAGOO_PROXY_SECRET);
      try {
        response = await fetch(
          new Request(target, {
            method: request.method,
            headers: proxyHeaders,
            body: ["GET", "HEAD"].includes(request.method)
              ? undefined
              : request.body,
            redirect: "manual",
          }),
        );
      } catch {
        response = Response.json(
          {
            error: {
              code: "SERVER_UNREACHABLE",
              message: "O servidor está temporariamente indisponível.",
            },
          },
          { status: 502 },
        );
      }
    } else response = await env.ASSETS.fetch(request);
    const safe = new Response(response.body, response);
    for (const [name, value] of Object.entries(headers))
      safe.headers.set(name, value);
    if (isApi) safe.headers.set("Cache-Control", "no-store");
    return safe;
  },
};
