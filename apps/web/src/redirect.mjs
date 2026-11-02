export function loginContinuation(candidate, origin) {
  if (typeof candidate !== "string" || !candidate) return null;
  const url = new URL(candidate, origin);
  if (
    url.origin !== origin ||
    !["/api/auth/oauth2/authorize", "/oauth/consent"].includes(url.pathname) ||
    url.username ||
    url.password
  )
    throw new Error("O destino de autenticação não pertence a este servidor.");
  return url.href;
}
export function consentContinuation(candidate) {
  if (typeof candidate !== "string" || !candidate)
    throw new Error("O servidor não retornou o destino da autorização.");
  const url = new URL(candidate);
  const loopback =
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    !(
      url.protocol === "https:" ||
      (url.protocol === "app.fagoo:" &&
        url.hostname === "oauth" &&
        url.pathname === "/callback" &&
        !url.port) ||
      loopback
    )
  )
    throw new Error("O endereço de retorno não é compatível com este cliente.");
  return url.href;
}
