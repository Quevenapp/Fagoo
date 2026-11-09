const id = { type: "string", minLength: 1 };
const lineIds = { type: "array", maxItems: 200, uniqueItems: true, items: id };
export const serviceSchemas = {
  LineService: {
    type: "object",
    properties: {
      mode: { enum: ["inherit", "human", "bot"] },
      bot_id: { type: ["string", "null"] },
      menu_mode: { enum: ["automatic", "manual", "off"] },
    },
  },
  LineUpdate: {
    type: "object",
    properties: {
      service: { $ref: "#/components/schemas/LineService" },
      number_policy: { $ref: "#/components/schemas/NumberPolicy" },
    },
  },
  ServiceLine: {
    type: "object",
    properties: {
      id,
      name: { type: "string" },
      number: { type: "string" },
      status: { type: "string" },
      kind: { type: "string" },
      service: { $ref: "#/components/schemas/LineService" },
      number_policy: { $ref: "#/components/schemas/NumberPolicy" },
    },
  },
  MenuItem: {
    type: "object",
    required: ["id", "label", "type"],
    properties: {
      id,
      label: { type: "string", minLength: 1, maxLength: 100 },
      type: {
        enum: [
          "human",
          "bot",
          "app",
          "submenu",
          "link",
          "content",
          "protocols",
          "survey",
        ],
      },
      parent_id: { type: ["string", "null"] },
      bot_id: id,
      app_id: id,
      department_id: {
        type: ["string", "null"],
        description: "Setor humano. Sem setor, encaminha para a fila geral.",
      },
      url: {
        type: "string",
        format: "uri",
        description: "Endereço público HTTPS para destino link.",
      },
      content: {
        type: "string",
        maxLength: 3500,
        description:
          "Mensagem do destino content (obrigatória) ou texto do link (até3000).",
      },
      question: {
        type: "string",
        maxLength: 300,
        description: "Pergunta opcional da avaliação de 1 a 5.",
      },
      enabled: { type: "boolean" },
      line_ids: {
        ...lineIds,
        description:
          "Vazio permite todas as linhas autorizadas pelos menus ancestrais.",
      },
      trigger: { enum: ["automatic", "manual"], default: "automatic" },
    },
  },
  MenuSettings: {
    type: "object",
    properties: {
      menus: {
        type: "array",
        maxItems: 200,
        items: { $ref: "#/components/schemas/MenuItem" },
      },
      departments: {
        type: "array",
        maxItems: 100,
        items: { $ref: "#/components/schemas/ServiceDepartment" },
      },
      protocol_response_hours: {
        type: ["number", "null"],
        exclusiveMinimum: 0,
        maximum: 8760,
      },
      surveys_enabled: { type: "boolean" },
      jev_enabled: { type: "boolean" },
    },
  },
  ServiceDepartment: {
    type: "object",
    required: ["id", "name", "members"],
    properties: {
      id: { type: "string", pattern: "^[a-zA-Z0-9_-]{1,100}$" },
      name: { type: "string", minLength: 1, maxLength: 100 },
      members: { type: "array", maxItems: 100, uniqueItems: true, items: id },
      enabled: { type: "boolean", default: true },
    },
  },
  BotLineUpdate: {
    type: "object",
    properties: {
      enabled: { type: "boolean" },
      name: { type: "string" },
      line_ids: {
        ...lineIds,
        type: ["array", "null"],
        description:
          "null: todas as linhas; []: somente interno; lista: linhas autorizadas. As demais permissões também são aplicadas.",
      },
    },
  },
  TeamContact: {
    type: "object",
    properties: {
      id: { ...id, description: "ID de pessoa ou bot:<id>." },
      kind: { enum: ["user", "bot"] },
      name: { type: "string" },
      online: { type: "boolean" },
      bot_id: id,
    },
  },
  InternalChatCreate: {
    type: "object",
    required: ["peer_id"],
    properties: {
      peer_id: { ...id, description: "Outro contato retornado por GET /team." },
    },
  },
  InternalMessageCreate: {
    type: "object",
    required: ["text"],
    properties: { text: { type: "string", minLength: 1, maxLength: 60000 } },
  },
  InternalMessage: {
    type: "object",
    properties: {
      id,
      author: id,
      text: { type: "string" },
      created: { type: "integer" },
      status: { type: "string" },
      run_id: { type: ["string", "null"] },
    },
  },
  InternalChat: {
    type: "object",
    properties: {
      id,
      updated: { type: "integer" },
      peer: { $ref: "#/components/schemas/TeamContact" },
      messages: {
        type: "array",
        maxItems: 500,
        items: { $ref: "#/components/schemas/InternalMessage" },
      },
    },
  },
};
export const serviceOperations: [string, string, string, string?, string?][] = [
  [
    "get",
    "/profiles/{profile}/lines",
    "Linhas e responsáveis pelo atendimento",
    "conversations:read",
  ],
  [
    "put",
    "/profiles/{profile}/lines/{id}",
    "Configurar atendimento de uma linha (administrador)",
    "conversations:write",
    "LineUpdate",
  ],
  [
    "get",
    "/profiles/{profile}/menus",
    "Menus e submenus do perfil",
    "conversations:read",
  ],
  [
    "put",
    "/profiles/{profile}/settings",
    "Atualizar menus e configurações (administrador)",
    undefined,
    "MenuSettings",
  ],
  [
    "patch",
    "/profiles/{profile}/bots/{id}",
    "Habilitação e linhas de um bot (administrador)",
    undefined,
    "BotLineUpdate",
  ],
  [
    "get",
    "/profiles/{profile}/team",
    "Contatos internos e disponibilidade",
    "presence:read",
  ],
  [
    "get",
    "/profiles/{profile}/internal-chats",
    "Histórico interno do usuário autenticado",
    "presence:read",
  ],
  [
    "post",
    "/profiles/{profile}/internal-chats",
    "Abrir conversa interna com pessoa ou bot",
    "presence:read",
    "InternalChatCreate",
  ],
  [
    "get",
    "/profiles/{profile}/internal-chats/{id}",
    "Últimas mensagens de uma conversa interna",
    "presence:read",
  ],
  [
    "post",
    "/profiles/{profile}/internal-chats/{id}/messages",
    "Enviar mensagem interna (não usa WhatsApp)",
    "presence:read",
    "InternalMessageCreate",
  ],
];
export function describeServiceOperation(
  path: string,
  method: string,
  entry: any,
  success: any,
) {
  if (!serviceOperations.some(([m, p]) => p === path && m === method)) return;
  entry.tags = ["Linhas e equipe"];
  if (!path.endsWith("/menus"))
    entry.description +=
      " Exige sessão de pessoa (cookie ou token wabu_). Conversas internas são visíveis apenas aos participantes, inclusive para administradores.";
  if (
    path.endsWith("/settings") ||
    path.endsWith("/bots/{id}") ||
    (path.includes("/lines/") && method === "put")
  )
    entry.description +=
      " Exige administrador. Campos omitidos preservam a configuração atual.";
  if (path.endsWith("/menus"))
    entry.parameters.push({
      name: "connection_id",
      in: "query",
      required: false,
      schema: id,
      description: "Filtra pelas linhas do menu e de seus ancestrais.",
    });
  const list =
    method === "get" &&
    ["/lines", "/menus", "/team", "/internal-chats"].some((suffix) =>
      path.endsWith(suffix),
    );
  const model = path.includes("/lines")
    ? "ServiceLine"
    : path.endsWith("/menus")
      ? "MenuItem"
      : path.endsWith("/team")
        ? "TeamContact"
        : path.endsWith("/messages")
          ? "InternalMessage"
          : path.includes("/internal-chats")
            ? "InternalChat"
            : null;
  if (model)
    success.content["application/json"].schema = list
      ? {
          type: "object",
          properties: {
            data: {
              type: "array",
              items: { $ref: `#/components/schemas/${model}` },
            },
          },
        }
      : { $ref: `#/components/schemas/${model}` };
}
