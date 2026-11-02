export class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export async function api(path, { body, method, signal } = {}) {
  if (!path.startsWith("/") || path.startsWith("//") || /[\\\r\n]/.test(path))
    throw new Error("Endereço de API inválido.");
  let response;
  try {
    response = await fetch(path, {
      method: method || (body === undefined ? "GET" : "POST"),
      credentials: "same-origin",
      signal,
      headers: {
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (error) {
    if (error.name === "AbortError") throw error;
    throw new ApiError(
      "Não foi possível acessar o servidor. Verifique sua conexão.",
      0,
      "NETWORK_ERROR",
    );
  }
  if (response.status === 204) return null;
  let data;
  try {
    data = await response.json();
  } catch {
    throw new ApiError(
      "O servidor respondeu em um formato inesperado.",
      response.status,
      "INVALID_RESPONSE",
    );
  }
  if (!response.ok)
    throw new ApiError(
      data.error?.message ||
        data.message ||
        "Não foi possível concluir a operação.",
      response.status,
      data.error?.code ||
        (typeof data.error === "string" ? data.error : undefined) ||
        data.code,
    );
  return data;
}
export const command = () => crypto.randomUUID();
export const query = (data) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(data))
    if (value !== "" && value !== null && value !== undefined)
      params.set(key, String(value));
  return params.toString();
};
