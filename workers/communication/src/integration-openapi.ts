const ids = {
  type: "array",
  maxItems: 200,
  uniqueItems: true,
  items: { type: "string" },
};
export const integrationSchemas = {
  PairingStart: {
    type: "object",
    required: ["client", "instance_name"],
    properties: {
      client: { enum: ["vinki", "fagoo"] },
      instance_name: { type: "string", minLength: 1, maxLength: 80 },
    },
  },
  PairingToken: {
    type: "object",
    required: ["client", "device_code"],
    properties: {
      client: { enum: ["vinki", "fagoo"] },
      device_code: {
        type: "string",
        description:
          "Segredo temporário guardado apenas pelo servidor iniciador.",
      },
    },
  },
  PairingLookup: {
    type: "object",
    required: ["user_code"],
    properties: { user_code: { type: "string", example: "ABCD-EFGH" } },
  },
  PairingApprove: {
    type: "object",
    required: ["profile_id", "scopes", "number_ids", "pool_ids", "bot_ids"],
    properties: {
      profile_id: { type: "string" },
      scopes: {
        ...ids,
        description:
          "Subconjunto de allowed_scopes retornado pela consulta; não concede templates pagos.",
      },
      number_ids: ids,
      pool_ids: ids,
      bot_ids: ids,
    },
  },
  AutomaticUpdates: {
    type: "object",
    required: ["enabled", "hour", "window_hours"],
    properties: {
      enabled: { type: "boolean", default: false },
      hour: { type: "integer", minimum: 0, maximum: 23, default: 3 },
      window_hours: { type: "integer", minimum: 1, maximum: 6, default: 2 },
    },
  },
};
export const integrationOperations: [
  string,
  string,
  string,
  string?,
  string?,
][] = [
  [
    "post",
    "/pairing/start",
    "Iniciar pareamento no servidor do Vinki ou Fagoo",
    "",
    "PairingStart",
  ],
  [
    "post",
    "/pairing/token",
    "Consultar aprovação e receber credencial uma única vez",
    "",
    "PairingToken",
  ],
  ["get", "/pairings", "Listar integrações pareadas (administrador)"],
  [
    "post",
    "/pairings/lookup",
    "Conferir código e instalação solicitante (administrador)",
    "",
    "PairingLookup",
  ],
  [
    "post",
    "/pairings/{id}/approve",
    "Autorizar perfil, recursos e permissões (administrador)",
    "",
    "PairingApprove",
  ],
  ["post", "/pairings/{id}/deny", "Recusar solicitação (administrador)"],
  [
    "delete",
    "/pairings/{id}",
    "Revogar pareamento e suas chaves (administrador)",
  ],
  [
    "post",
    "/pairings/disconnect",
    "Revogar o próprio pareamento (aplicação pareada)",
  ],
  [
    "post",
    "/system/updates/automatic",
    "Configurar atualizações automáticas (administrador)",
    "",
    "AutomaticUpdates",
  ],
];
export function describeIntegrationOperation(
  path: string,
  entry: any,
  origin: string,
) {
  if (path.startsWith("/pairing")) {
    entry.tags = ["Pareamento"];
    entry.description =
      "Pareamento por código temporário de 10 minutos. O administrador confirma a instalação e limita seu acesso; a credencial permanece entre servidores. A consulta retorna status authorization_pending ou connected; expiração, recusa e consumo anterior retornam erros padronizados. Respeite interval (5 segundos) e Retry-After. Repetições não geram uma segunda credencial. Resposta de consumo perdida exige novo pareamento.";
    if (path.startsWith("/pairing/")) {
      entry.servers = [{ url: origin + "/api" }];
      entry.security = [];
    } else if (path !== "/pairings/disconnect") {
      entry.description +=
        " Exige sessão de administrador; aplicações não podem aprovar acesso.";
    }
    if (path === "/pairing/start") {
      entry.responses["201"] = entry.responses["200"];
      delete entry.responses["200"];
    }
  }
  if (path === "/system/updates/automatic") {
    entry.description =
      "Exige administrador e Idempotency-Key. Opt-in desativado por padrão. Hora e janela diária no fuso America/Sao_Paulo; instala somente release oficial mais nova verificada usando a autorização Cloudflare já configurada. Falhas ambíguas exigem revisão e não são repetidas automaticamente.";
  }
}
