import { routerOperations, routerSchemas } from "./router-openapi";
import {
  integrationOperations,
  integrationSchemas,
  describeIntegrationOperation,
} from "./integration-openapi";
import {
  serviceOperations,
  serviceSchemas,
  describeServiceOperation,
} from "./service-openapi";
const contactProperties = {
  name: { type: "string", minLength: 1, maxLength: 120 },
  phone: {
    type: "string",
    maxLength: 40,
    description:
      "Opcional. De 8 a 15 dígitos com DDI e DDD; aceita +, espaços e pontuação de telefone. Não une cadastros.",
  },
  email: {
    type: "string",
    maxLength: 254,
    description: "E-mail válido ou vazio.",
  },
  company: { type: "string", maxLength: 160 },
  notes: { type: "string", maxLength: 2000 },
};
const schemas = {
  ...routerSchemas,
  ...integrationSchemas,
  ...serviceSchemas,
  MessageContent: {
    type: "object",
    properties: {
      type: {
        enum: [
          "text",
          "image",
          "video",
          "audio",
          "voice",
          "document",
          "sticker",
          "location",
          "contacts",
        ],
      },
      reply_to: {
        type: "string",
        description: "ID Wabotia de uma mensagem desta conversa.",
      },
      mentions: {
        type: "array",
        items: { type: "string" },
        description: "IDs de participantes do grupo; somente QR direto.",
      },
      location: {
        type: "object",
        required: ["latitude", "longitude"],
        properties: {
          latitude: { type: "number", minimum: -90, maximum: 90 },
          longitude: { type: "number", minimum: -180, maximum: 180 },
          name: { type: "string" },
          address: { type: "string" },
        },
      },
      contacts: {
        type: "array",
        maxItems: 10,
        items: {
          type: "object",
          required: ["name", "phone"],
          properties: { name: { type: "string" }, phone: { type: "string" } },
        },
      },
    },
  },
  MessageAction: {
    type: "object",
    required: ["action", "message_id"],
    properties: {
      action: { enum: ["reaction", "edit", "delete", "read"] },
      message_id: { type: "string" },
      emoji: {
        type: "string",
        description: "Emoji ou vazio para remover sua reação.",
      },
      text: { type: "string" },
    },
  },
  MediaUpload: {
    type: "object",
    required: ["name", "type", "size"],
    properties: {
      name: { type: "string", maxLength: 200 },
      type: { type: "string" },
      size: { type: "integer", minimum: 1, maximum: 104857600 },
    },
  },
  GroupAction: {
    type: "object",
    required: ["action"],
    properties: {
      action: {
        enum: [
          "sync",
          "create",
          "join",
          "refresh",
          "invite",
          "subject",
          "description",
          "participants",
          "announcement",
          "leave",
        ],
      },
      connection_id: { type: "string" },
      subject: { type: "string", maxLength: 128 },
      description: { type: "string", maxLength: 2048 },
      invite: { type: "string" },
      participants: { type: "array", items: { type: "string" } },
      operation: { enum: ["add", "remove", "promote", "demote"] },
      enabled: { type: "boolean" },
      cursor: { type: "string" },
    },
  },
  GroupPolicy: {
    type: "object",
    required: ["bot_policy"],
    properties: { bot_policy: { enum: ["off", "mentions", "all"] } },
  },
  GroupReconcile: {
    type: "object",
    required: ["confirmed", "status"],
    properties: {
      confirmed: { const: true },
      status: { enum: ["sent", "failed"] },
    },
  },
  CallSession: {
    type: "object",
    required: ["sdp_type", "sdp"],
    properties: {
      sdp_type: { enum: ["offer", "answer"] },
      sdp: {
        type: "string",
        maxLength: 60000,
        description: "SDP de áudio WebRTC. Não envie vídeo ou dados.",
      },
    },
  },
  CallStart: {
    type: "object",
    required: ["conversation_id", "session"],
    properties: {
      conversation_id: { type: "string" },
      session: { $ref: "#/components/schemas/CallSession" },
    },
  },
  CallAccept: {
    type: "object",
    properties: { session: { $ref: "#/components/schemas/CallSession" } },
  },
  CallPermission: {
    type: "object",
    required: ["conversation_id"],
    properties: { conversation_id: { type: "string" } },
  },
  CallReconcile: {
    type: "object",
    required: ["confirmed_ended"],
    properties: { confirmed_ended: { const: true } },
  },
  ContactInput: {
    type: "object",
    required: ["name"],
    properties: contactProperties,
  },
  ContactUpdate: {
    type: "object",
    required: ["expected_version"],
    properties: {
      ...contactProperties,
      expected_version: {
        type: "integer",
        minimum: 1,
        description: "Versão obtida na consulta. Desatualizada retorna 409.",
      },
    },
  },
  Contact: {
    type: "object",
    properties: {
      ...contactProperties,
      id: { type: "string" },
      profile_id: { type: "string" },
      namespace: { type: "string", readOnly: true },
      source: { enum: ["manual", "csv", "conversation"] },
      version: { type: "integer" },
      created_by: { type: "string", readOnly: true },
      updated_by: { type: "string", readOnly: true },
      created: { type: "integer" },
      updated: { type: "integer" },
    },
  },
  ContactLink: {
    oneOf: [
      { $ref: "#/components/schemas/ContactInput" },
      {
        type: "object",
        required: ["contact_id"],
        properties: {
          contact_id: {
            type: "string",
            description:
              "Contato existente do mesmo perfil e namespace da aplicação.",
          },
        },
      },
    ],
  },
  ContactUnlink: {
    type: "object",
    required: ["expected_contact_id"],
    properties: {
      expected_contact_id: {
        type: "string",
        description:
          "Contato atualmente vinculado; impede desvincular uma alteração mais recente.",
      },
    },
  },
  ContactCsv: {
    type: "object",
    required: ["csv"],
    properties: {
      csv: {
        type: "string",
        maxLength: 1048576,
        description:
          "Conteúdo UTF-8 completo, até 1 MiB e 500 contatos. Cabeçalho nome obrigatório; telefone, email, empresa, observacoes opcionais. Separador vírgula ou ponto e vírgula. Nenhuma linha é importada se houver erro.",
      },
    },
  },
  ContactImportResult: {
    type: "object",
    properties: {
      imported: { type: "integer" },
      skipped: { type: "integer" },
      total: { type: "integer" },
    },
  },
  ContactCsvPreview: {
    type: "object",
    properties: {
      total: { type: "integer" },
      new_count: { type: "integer" },
      skipped_count: { type: "integer" },
      delimiter: { type: "string" },
      ignored_columns: { type: "array", items: { type: "string" } },
      rows: {
        type: "array",
        items: {
          type: "object",
          properties: {
            line: { type: "integer" },
            values: { $ref: "#/components/schemas/ContactInput" },
            duplicate: { type: "boolean" },
          },
        },
      },
      errors: {
        type: "array",
        items: {
          type: "object",
          properties: {
            line: { type: "integer" },
            message: { type: "string" },
          },
        },
      },
    },
  },
  Error: {
    type: "object",
    properties: {
      error: {
        type: "object",
        properties: {
          code: { type: "string" },
          message: { type: "string" },
          request_id: { type: "string" },
        },
      },
    },
  },
  Inbound: {
    type: "object",
    required: ["external_id", "message_id", "text"],
    properties: {
      external_id: {
        type: "string",
        description: "Identificador do cliente no namespace desta aplicação.",
      },
      message_id: { type: "string" },
      text: { type: "string" },
      attachments: { type: "array", items: { type: "string" } },
    },
  },
  Action: {
    type: "object",
    required: ["action"],
    properties: {
      action: {
        enum: [
          "claim",
          "reply",
          "note",
          "transfer",
          "resolve",
          "resume",
          "tags",
          "menu",
          "protocols",
          "survey",
        ],
      },
      content: { $ref: "#/components/schemas/MessageContent" },
      text: { type: "string" },
      target: {
        type: "string",
        description:
          "Para transferir: ID de pessoa ou bot:<id>, do diretório /team.",
      },
      menu_id: {
        type: ["string", "null"],
        description:
          "Na ação menu: ID de submenu ou null para o menu principal. Respeita linhas, responsabilidade e janela de 24 horas.",
      },
      number: {
        type: "string",
        description:
          "Na ação protocols, número exato opcional. Sem ele lista protocolos do telefone verificado e perfil; não consulta terceiros.",
      },
      department_id: {
        type: ["string", "null"],
        description: "Setor responsável ao transferir para atendimento humano.",
      },
      attachments: { type: "array", items: { type: "string" } },
      tags: { type: "array", items: { type: "string" } },
    },
  },
  BotRun: {
    type: "object",
    required: ["profile_id", "bot_id", "input"],
    properties: {
      profile_id: { type: "string" },
      bot_id: { type: "string" },
      input: { type: "string", maxLength: 60000 },
    },
  },
  Ticket: {
    type: "object",
    required: ["conversation_id", "title"],
    properties: {
      conversation_id: { type: "string" },
      title: { type: "string", maxLength: 300 },
    },
  },
  TicketUpdate: {
    type: "object",
    properties: {
      text: { type: "string" },
      status: { enum: ["open", "in_progress", "closed"] },
      owner: { type: "string" },
      response_due_at: {
        type: ["integer", "null"],
        description:
          "Unix em milissegundos; somente antes da primeira resposta.",
      },
    },
  },
  Knowledge: {
    type: "object",
    required: ["title", "kind"],
    properties: {
      title: { type: "string" },
      kind: { enum: ["text", "url", "file", "youtube"] },
      text: { type: "string" },
      url: { type: "string", format: "uri" },
      media_id: { type: "string" },
    },
  },
  Webhook: {
    type: "object",
    required: ["url", "events"],
    properties: {
      url: { type: "string", format: "uri" },
      events: { type: "array", items: { type: "string" } },
    },
  },
  RunResult: {
    type: "object",
    properties: {
      id: { type: "string" },
      status: {
        enum: [
          "queued",
          "starting",
          "running",
          "cancelling",
          "cancelled",
          "completed",
          "failed",
          "unknown",
        ],
      },
      result: { type: ["string", "null"] },
      attachments: {
        type: "array",
        items: { type: "string" },
        description:
          "IDs de mídias autorizadas, obtidos pela rota de conteúdo do perfil.",
      },
      error: { type: ["string", "null"] },
    },
  },
  MobileLogin: {
    type: "object",
    required: ["email", "password", "device"],
    properties: {
      email: { type: "string", maxLength: 254 },
      password: { type: "string" },
      device: {
        type: "object",
        required: ["platform", "name", "app_version"],
        properties: {
          platform: { enum: ["android", "ios"] },
          name: { type: "string", maxLength: 120 },
          app_version: { type: "string", maxLength: 40 },
        },
      },
    },
  },
  MobileSession: {
    type: "object",
    required: ["token", "expires", "user"],
    properties: {
      token: {
        type: "string",
        description:
          "Sessão de usuário com prefixo wabu_. Exibida uma única vez; o servidor guarda apenas o hash. Use em Authorization: Bearer.",
      },
      expires: {
        type: "integer",
        description: "Unix em milissegundos; 30 dias, renováveis por refresh.",
      },
      user: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          email: { type: "string" },
          role: { enum: ["admin", "agent"] },
          profiles: {
            type: "array",
            items: { type: "string" },
            description: "IDs dos perfis autorizados à pessoa.",
          },
        },
      },
    },
  },
  DeviceInput: {
    type: "object",
    required: ["platform", "provider", "token"],
    properties: {
      platform: { enum: ["android", "ios"] },
      provider: { enum: ["fcm"] },
      token: {
        type: "string",
        maxLength: 4096,
        description: "Token de registro do provedor de push.",
      },
      name: { type: "string", maxLength: 120 },
      app_version: { type: "string", maxLength: 40 },
      profiles: {
        type: "array",
        items: { type: "string" },
        description:
          "Perfis a notificar; vazio recebe de todos os perfis autorizados.",
      },
      enabled: { type: "boolean", default: true },
    },
  },
  Device: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "UUID gerado pelo aplicativo em cada instalação.",
      },
      user_id: { type: "string", readOnly: true },
      platform: { enum: ["android", "ios"] },
      provider: { enum: ["fcm"] },
      name: { type: "string" },
      app_version: { type: "string" },
      profiles: { type: "array", items: { type: "string" } },
      enabled: {
        type: "boolean",
        description:
          "Falso quando o provedor recusou o token como inexistente ou o usuário desativou.",
      },
      token_suffix: {
        type: "string",
        readOnly: true,
        description:
          "Últimos caracteres do token; o token completo não é devolvido.",
      },
      created: { type: "integer" },
      updated: { type: "integer" },
      last_sent_at: { type: ["integer", "null"], readOnly: true },
    },
  },
  PushConfig: {
    type: "object",
    properties: {
      mode: { enum: ["off", "gateway", "fcm"] },
      gateway_url: { type: "string", format: "uri" },
      gateway_secret_configured: { type: "boolean", readOnly: true },
      fcm_configured: { type: "boolean", readOnly: true },
      fcm_project_id: {
        type: "string",
        readOnly: true,
        description:
          "project_id da conta de serviço; a conta nunca é devolvida.",
      },
      preview: { enum: ["preview", "minimal"] },
      ticket_alert_minutes: { type: "integer", minimum: 0 },
    },
  },
  PushConfigInput: {
    type: "object",
    required: ["mode"],
    properties: {
      mode: { enum: ["off", "gateway", "fcm"] },
      gateway_url: {
        type: "string",
        format: "uri",
        default: "https://push.wabotia.queven.app",
        description: "Somente no modo gateway. HTTPS obrigatório.",
      },
      gateway_secret: {
        type: "string",
        writeOnly: true,
        description:
          "Opcional; valor de GATEWAY_SHARED_SECRET do gateway. Ausente mantém o atual; vazio remove.",
      },
      fcm_service_account: {
        type: "string",
        writeOnly: true,
        description:
          "JSON da conta de serviço com papel Firebase Cloud Messaging API Admin; somente no modo fcm. Ausente mantém a atual. Guardada criptografada.",
      },
      preview: { enum: ["preview", "minimal"], default: "preview" },
      ticket_alert_minutes: {
        type: "integer",
        minimum: 0,
        maximum: 10080,
        default: 60,
        description: "Minutos antes do prazo da primeira resposta; 0 desativa.",
      },
    },
  },
  PushTestResult: {
    type: "object",
    properties: {
      sent: {
        type: "integer",
        description: "Notificações aceitas pelo provedor ou gateway.",
      },
      devices: {
        type: "integer",
        description: "Dispositivos ativos da pessoa autenticada.",
      },
    },
  },
  TicketDetail: {
    type: "object",
    properties: {
      id: { type: "string" },
      number: { type: "string", description: "Protocolo público, como WA-…" },
      profile_id: { type: "string" },
      conversation_id: { type: "string" },
      title: { type: "string" },
      status: { enum: ["open", "in_progress", "closed"] },
      owner: { type: ["string", "null"] },
      response_due_at: { type: ["integer", "null"] },
      first_response_at: { type: ["integer", "null"] },
      overdue: {
        type: "boolean",
        description:
          "Verdadeiro quando o prazo da primeira resposta passou sem resposta.",
      },
      created: { type: "integer" },
      updated: { type: "integer" },
      updates: {
        type: "array",
        description:
          "Andamentos em ordem cronológica; notas internas exigem notes:read ou sessão de usuário.",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            actor: { type: "string" },
            text: { type: "string" },
            internal: { type: "boolean" },
            created: { type: "integer" },
          },
        },
      },
    },
  },
};
const operations: [string, string, string, string?, string?][] = [
  ["get", "/profiles", "Listar perfis autorizados"],
  [
    "get",
    "/profiles/{profile}/contacts",
    "Consultar agenda de contatos",
    "contacts:read",
  ],
  [
    "post",
    "/profiles/{profile}/contacts",
    "Cadastrar contato",
    "contacts:write",
    "ContactInput",
  ],
  [
    "get",
    "/profiles/{profile}/contacts/{id}",
    "Consultar contato e conversas vinculadas",
    "contacts:read",
  ],
  [
    "patch",
    "/profiles/{profile}/contacts/{id}",
    "Atualizar contato",
    "contacts:write",
    "ContactUpdate",
  ],
  [
    "post",
    "/profiles/{profile}/contacts/import/preview",
    "Conferir CSV sem salvar",
    "contacts:write",
    "ContactCsv",
  ],
  [
    "post",
    "/profiles/{profile}/contacts/import",
    "Importar contatos de CSV",
    "contacts:write",
    "ContactCsv",
  ],
  [
    "put",
    "/profiles/{profile}/conversations/{id}/contact",
    "Salvar ou vincular contato da conversa",
    "contacts:write e conversations:read",
    "ContactLink",
  ],
  [
    "delete",
    "/profiles/{profile}/conversations/{id}/contact",
    "Desvincular contato sem excluir cadastro",
    "contacts:write e conversations:read",
    "ContactUnlink",
  ],
  ["get", "/profiles/{profile}/bots", "Listar bots", "bots:read"],
  [
    "get",
    "/profiles/{profile}/conversations",
    "Listar conversas",
    "conversations:read",
  ],
  [
    "post",
    "/profiles/{profile}/conversations",
    "Iniciar conversa",
    "conversations:write",
    "Inbound",
  ],
  [
    "post",
    "/profiles/{profile}/inbound",
    "Receber mensagem do sistema externo",
    "conversations:write",
    "Inbound",
  ],
  [
    "get",
    "/profiles/{profile}/conversations/{id}",
    "Consultar conversa e histórico",
    "conversations:read",
  ],
  [
    "post",
    "/profiles/{profile}/conversations/{id}/actions",
    "Operar atendimento",
    "conversations:write",
    "Action",
  ],
  [
    "get",
    "/profiles/{profile}/tickets",
    "Consultar protocolos",
    "tickets:read",
  ],
  [
    "get",
    "/profiles/{profile}/tickets/{id}",
    "Consultar protocolo e andamentos",
    "tickets:read",
  ],
  [
    "post",
    "/profiles/{profile}/tickets",
    "Abrir protocolo",
    "tickets:write",
    "Ticket",
  ],
  [
    "patch",
    "/profiles/{profile}/tickets/{id}",
    "Atualizar protocolo",
    "tickets:write",
    "TicketUpdate",
  ],
  [
    "get",
    "/profiles/{profile}/knowledge",
    "Consultar conhecimento",
    "knowledge:read",
  ],
  [
    "post",
    "/profiles/{profile}/knowledge",
    "Importar fonte",
    "knowledge:write",
    "Knowledge",
  ],
  [
    "delete",
    "/profiles/{profile}/knowledge/{id}",
    "Excluir fonte",
    "knowledge:write",
  ],
  ["get", "/profiles/{profile}/media", "Listar arquivos", "media:read"],
  [
    "post",
    "/profiles/{profile}/media",
    "Enviar arquivo de até 20 MB",
    "media:write",
  ],
  [
    "get",
    "/profiles/{profile}/media/{id}/content",
    "Baixar arquivo autorizado",
    "media:read",
  ],
  ["get", "/profiles/{profile}/reports", "Consultar relatório", "reports:read"],
  [
    "get",
    "/profiles/{profile}/presence",
    "Consultar presença",
    "presence:read",
  ],
  [
    "get",
    "/profiles/{profile}/consents",
    "Consultar consentimentos",
    "conversations:read",
  ],
  ["post", "/bot-runs", "Executar bot autorizado", "bots:invoke", "BotRun"],
  ["get", "/bot-runs/{id}", "Consultar resultado de execução", "bots:invoke"],
  [
    "post",
    "/profiles/{profile}/bot-runs/{id}/cancel",
    "Cancelar execução",
    "bots:invoke",
  ],
  [
    "get",
    "/profiles/{profile}/events",
    "Consultar eventos incrementais",
    "events:read",
  ],
  [
    "get",
    "/profiles/{profile}/webhook-subscriptions",
    "Listar webhooks",
    "webhooks:manage",
  ],
  [
    "post",
    "/profiles/{profile}/webhook-subscriptions",
    "Cadastrar webhook",
    "webhooks:manage",
    "Webhook",
  ],
  [
    "delete",
    "/profiles/{profile}/webhook-subscriptions/{id}",
    "Desativar webhook",
    "webhooks:manage",
  ],
  [
    "get",
    "/profiles/{profile}/webhook-deliveries",
    "Histórico de entregas",
    "webhooks:manage",
  ],
  [
    "post",
    "/profiles/{profile}/webhook-deliveries/{id}/retry",
    "Repetir entrega",
    "webhooks:manage",
  ],
];
operations.push(
  [
    "get",
    "/profiles/{profile}/connections/{id}/capabilities",
    "Recursos disponíveis neste canal",
    "conversations:read",
  ],
  [
    "post",
    "/profiles/{profile}/conversations/{id}/message-actions",
    "Reagir, editar, apagar ou marcar como lida",
    "conversations:write",
    "MessageAction",
  ],
  [
    "post",
    "/profiles/{profile}/media/uploads",
    "Iniciar arquivo de até 100 MB em partes de 5 MB",
    "media:write",
    "MediaUpload",
  ],
  [
    "put",
    "/profiles/{profile}/media/uploads/{id}/parts/{part}",
    "Enviar uma parte; identidade upload + número, conflito se bytes diferentes",
    "media:write",
  ],
  [
    "post",
    "/profiles/{profile}/media/uploads/{id}/complete",
    "Concluir arquivo após confirmar todas as partes",
    "media:write",
  ],
  [
    "post",
    "/profiles/{profile}/media/uploads/{id}/abort",
    "Cancelar envio incompleto",
    "media:write",
  ],
  [
    "get",
    "/profiles/{profile}/groups",
    "Listar conversas de grupo",
    "conversations:read",
  ],
  [
    "post",
    "/profiles/{profile}/groups/actions",
    "Buscar grupos, criar grupo ou entrar por convite",
    "groups:manage",
    "GroupAction",
  ],
  [
    "post",
    "/profiles/{profile}/groups/{id}/actions",
    "Administrar grupo autorizado",
    "groups:manage",
    "GroupAction",
  ],
  [
    "put",
    "/profiles/{profile}/groups/{id}/policy",
    "Escolher quando a IA responde no grupo",
    "groups:manage",
    "GroupPolicy",
  ],
  [
    "get",
    "/profiles/{profile}/group-operations",
    "Consultar últimas 30 operações de grupo da aplicação",
    "groups:manage",
  ],
  [
    "post",
    "/profiles/{profile}/group-operations/{id}/reconcile",
    "Reconciliar operação após conferência no WhatsApp",
    "groups:manage",
    "GroupReconcile",
  ],
  [
    "get",
    "/profiles/{profile}/calls",
    "Listar ligações autorizadas",
    "calls:read",
  ],
  [
    "get",
    "/profiles/{profile}/calls/{id}",
    "Consultar ligação; sessão de áudio só para o responsável",
    "calls:read",
  ],
  [
    "get",
    "/profiles/{profile}/conversations/{id}/call-permission",
    "Verificar permissão e limites atuais da Meta",
    "calls:read",
  ],
  [
    "post",
    "/profiles/{profile}/calls",
    "Iniciar chamada humana com oferta WebRTC",
    "calls:write",
    "CallStart",
  ],
  [
    "post",
    "/profiles/{profile}/calls/permission",
    "Solicitar permissão ao cliente dentro da janela de atendimento",
    "calls:write",
    "CallPermission",
  ],
  ...[
    "claim",
    "pre_accept",
    "accept",
    "reject",
    "terminate",
    "keepalive",
    "reconcile",
  ].map(
    (action) =>
      [
        "post",
        `/profiles/{profile}/calls/{id}/${action}`,
        `Ligação: ${action}`,
        action === "claim"
          ? "calls:read + calls:write + conversations:write"
          : "calls:read + calls:write",
        ["accept", "pre_accept"].includes(action)
          ? "CallAccept"
          : action === "reconcile"
            ? "CallReconcile"
            : "",
      ] as [string, string, string, string, string],
  ),
);
const USER_ONLY =
  "Somente sessão de usuário (token wabu_) ou cookie do painel; não disponível para chaves de aplicação.";
const mobileOperations: [string, string, string, string?, string?][] = [
  [
    "post",
    "/auth/mobile/login",
    "Entrar pelo aplicativo com e-mail e senha",
    "",
    "MobileLogin",
  ],
  [
    "post",
    "/auth/mobile/refresh",
    "Renovar sessão do aplicativo; o token anterior é revogado",
    "",
    "",
  ],
  ["get", "/devices", "Listar dispositivos da própria pessoa", "", ""],
  [
    "put",
    "/devices/{id}",
    "Registrar ou atualizar dispositivo para push",
    "",
    "DeviceInput",
  ],
  ["delete", "/devices/{id}", "Remover dispositivo antes de sair", "", ""],
  [
    "post",
    "/devices/{id}/test",
    "Enviar notificação de teste a este dispositivo",
    "",
    "",
  ],
  ["get", "/system/push", "Consultar notificações dos aplicativos", "", ""],
  [
    "post",
    "/system/push/configure",
    "Configurar modo, gateway, FCM, conteúdo e alerta de protocolo",
    "",
    "PushConfigInput",
  ],
  [
    "post",
    "/system/push/test",
    "Enviar notificação de teste aos dispositivos do administrador",
    "",
    "",
  ],
];
const isMobilePath = (path: string) =>
  path.startsWith("/auth/mobile") ||
  path.startsWith("/devices") ||
  path.startsWith("/system/push");
export function openapi(origin: string) {
  const paths: any = {};
  for (const [method, path, summary, scope, schema] of [
    ...operations,
    ...routerOperations,
    ...mobileOperations,
    ...serviceOperations,
    ...integrationOperations,
  ]) {
    const mobile = isMobilePath(path);
    const successCode =
      method === "post" &&
      (path === "/bot-runs" ||
        path.endsWith("/router/messages") ||
        path.endsWith("/inbound"))
        ? "202"
        : "200";
    const mutation =
      method !== "get" &&
      !path.endsWith("/contacts/import/preview") &&
      !(path === "/devices/{id}" && method === "put") &&
      path !== "/auth/mobile/login";
    const idempotent = mutation && !path.startsWith("/pairing");
    const parameters: any[] = [...path.matchAll(/\{(\w+)\}/g)].map((m) => ({
      in: "path",
      name: m[1],
      required: true,
      schema: { type: "string" },
    }));
    if (idempotent)
      parameters.push({
        in: "header",
        name: "Idempotency-Key",
        required: true,
        schema: { type: "string", maxLength: 200 },
      });
    if (path.endsWith("/conversations") && method === "get")
      parameters.push(
        ...["cursor", "state", "q", "limit", "department_id"].map((name) => ({
          in: "query",
          name,
          schema: { type: "string" },
        })),
      );
    if (path.endsWith("/contacts") && method === "get")
      parameters.push(
        ...["cursor", "q", "namespace"].map((name) => ({
          in: "query",
          name,
          schema: { type: "string" },
        })),
        {
          in: "query",
          name: "limit",
          schema: { type: "integer", minimum: 1, maximum: 100, default: 50 },
        },
      );
    if (path.endsWith("/calls/{id}"))
      parameters.push({
        in: "query",
        name: "session",
        schema: { enum: ["1"] },
        description:
          "Exige calls:write e responsabilidade da ligação; devolve SDP remoto. Não exponha ao público.",
      });
    if (path.endsWith("/calls") && method === "get")
      parameters.push(
        ...["cursor", "conversation_id", "limit"].map((name) => ({
          in: "query",
          name,
          schema: { type: "string" },
        })),
      );
    if (path.endsWith("/groups") && method === "get")
      parameters.push({
        in: "query",
        name: "cursor",
        schema: { type: "string" },
      });
    if (path.endsWith("/content"))
      parameters.push(
        { in: "header", name: "Range", schema: { type: "string" } },
        { in: "query", name: "inline", schema: { enum: ["1"] } },
      );
    if (path.endsWith("/events"))
      parameters.push({
        in: "query",
        name: "after",
        schema: { type: "integer", default: 0 },
      });
    if (path.endsWith("/tickets") && method === "get")
      parameters.push(
        {
          in: "query",
          name: "q",
          schema: { type: "string", maxLength: 200 },
          description:
            "Pesquisa pelo número do protocolo ou telefone, dentro dos recursos autorizados.",
        },
        {
          in: "query",
          name: "status",
          schema: { enum: ["open", "in_progress", "closed"] },
          description: "Filtra pelo estado do protocolo.",
        },
        {
          in: "query",
          name: "overdue",
          schema: { enum: ["1"] },
          description:
            "Somente protocolos com prazo da primeira resposta vencido e sem resposta.",
        },
      );
    if (path.endsWith("/reports"))
      parameters.push(
        ...["section", "start", "end", "format", "cursor", "limit"].map(
          (name) => ({
            in: "query",
            name,
            schema: { type: "string" },
          }),
        ),
      );
    const paginated =
      method === "get" &&
      /\/(bots|tickets|knowledge|media|surveys|consents|deliveries|webhook-deliveries|bot-runs)$/.test(
        path,
      );
    if (paginated)
      parameters.push(
        { in: "query", name: "cursor", schema: { type: "string" } },
        {
          in: "query",
          name: "limit",
          schema: { type: "integer", minimum: 1, maximum: 100, default: 100 },
        },
      );
    const entry: any = {
      summary,
      description: mobile
        ? `${USER_ONLY} Datas no formato Unix em milissegundos.`
        : scope
          ? `Permissão: ${scope}. Datas no formato Unix em milissegundos.`
          : "Retorna somente perfis autorizados.",
      operationId: method + "_" + path.replace(/[^a-zA-Z]+/g, "_"),
      parameters,
      security: [{ BearerAuth: [] }],
      responses: {
        [successCode]: {
          description: "Operação aceita ou concluída",
          content: {
            "application/json": {
              schema: path.includes("bot-runs")
                ? { $ref: "#/components/schemas/RunResult" }
                : { type: "object" },
            },
          },
        },
        "400": { description: "Requisição inválida" },
        "401": { description: "Chave inválida ou expirada" },
        "403": { description: "Permissão insuficiente" },
        "409": { description: "Conflito de responsabilidade ou idempotência" },
        "429": { description: "Limite atingido; respeite Retry-After" },
      },
    };
    if (schema)
      entry.requestBody = {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: `#/components/schemas/${schema}` },
          },
        },
      };
    if (path.endsWith("/media") && method === "post")
      entry.requestBody = {
        required: true,
        content: {
          "multipart/form-data": {
            schema: {
              type: "object",
              required: ["file"],
              properties: { file: { type: "string", format: "binary" } },
            },
          },
        },
      };
    if (path.endsWith("/parts/{part}"))
      entry.requestBody = {
        required: true,
        content: {
          "application/octet-stream": {
            schema: { type: "string", format: "binary" },
          },
        },
      };
    if (path.endsWith("/content")) {
      entry.responses["200"] = {
        description: "Arquivo privado",
        content: {
          "application/octet-stream": {
            schema: { type: "string", format: "binary" },
          },
        },
      };
      entry.responses["206"] = {
        description: "Parte do arquivo; Content-Range e Accept-Ranges",
      };
      entry.responses["416"] = { description: "Range inválido" };
    }
    for (const [status, description] of Object.entries({
      400: "Requisição inválida",
      401: "Chave expirada, revogada ou inválida",
      403: "Permissão insuficiente",
      404: "Recurso ausente ou fora do acesso",
      409: "Conflito de responsabilidade ou idempotência",
      413: "Arquivo acima do limite",
      422: "Recurso não suportado pelo canal",
      429: "Limite atingido; respeite Retry-After",
      502: "Serviço externo indisponível",
    })) {
      entry.responses[status] = {
        description,
        headers: {
          "X-Request-Id": { schema: { type: "string" } },
          ...(status === "429"
            ? {
                "Retry-After": {
                  schema: { type: "integer" },
                  description: "Segundos até nova tentativa",
                },
              }
            : {}),
        },
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/Error" },
          },
        },
      };
    }
    const success = entry.responses[successCode];
    if (path.includes("/router")) {
      entry.tags = ["Roteador WhatsApp"];
      entry.description +=
        " A quantidade de números da WABA é definida pela Meta, sem teto imposto pelo roteador. Sem troca automática do remetente de uma conversa. A franquia local não garante ausência de cobranças Meta.";
      const resultSchema = path.endsWith("/router")
        ? "RouterView"
        : path.endsWith("/router/messages")
          ? "RouterQueued"
          : path.endsWith("/router/messages/{id}")
            ? "RouterDelivery"
            : null;
      if (resultSchema)
        success.content["application/json"].schema = {
          $ref: "#/components/schemas/" + resultSchema,
        };
    }
    success.headers = {
      "X-Request-Id": { schema: { type: "string" } },
      ...(idempotent
        ? {
            "Idempotency-Replayed": {
              schema: { type: "string", enum: ["true"] },
            },
          }
        : {}),
    };
    if (
      paginated ||
      (/\/(conversations|contacts)$/.test(path) && method === "get")
    )
      success.content["application/json"].schema = {
        type: "object",
        required: ["data", "next_cursor"],
        properties: {
          data: { type: "array", items: { type: "object" } },
          next_cursor: { type: ["string", "null"] },
        },
      };
    if (path.endsWith("/contacts") && method === "get")
      success.content["application/json"].schema.properties.data.items = {
        allOf: [
          { $ref: "#/components/schemas/Contact" },
          {
            type: "object",
            properties: { conversation_count: { type: "integer" } },
          },
        ],
      };
    if (
      (path.endsWith("/contacts") && method === "post") ||
      (path.endsWith("/contacts/{id}") && method === "patch") ||
      (path.endsWith("/contact") && method === "put")
    )
      success.content["application/json"].schema = {
        $ref: "#/components/schemas/Contact",
      };
    if (path.endsWith("/contacts/{id}") && method === "get")
      success.content["application/json"].schema = {
        type: "object",
        properties: {
          contact: { $ref: "#/components/schemas/Contact" },
          conversations: {
            type: "array",
            maxItems: 50,
            description:
              "Requer também conversations:read. Até 50 conversas recentes da própria aplicação.",
            items: { type: "object" },
          },
        },
      };
    if (path.endsWith("/contacts/import"))
      success.content["application/json"].schema = {
        $ref: "#/components/schemas/ContactImportResult",
      };
    if (path.endsWith("/contacts/import/preview"))
      success.content["application/json"].schema = {
        $ref: "#/components/schemas/ContactCsvPreview",
      };
    if (path.includes("/contacts") || path.endsWith("/contact"))
      entry.description +=
        " A aplicação acessa somente seus contatos no perfil. Namespace e autor vêm da autenticação. Nenhuma operação envia mensagens, concede consentimento ou une clientes pelo telefone. Importações repetidas ignoram linhas com todos os campos idênticos normalizados. Vínculos exigem conversa da própria aplicação.";
    if (path.endsWith("/events"))
      success.content["application/json"].schema = {
        type: "object",
        properties: {
          data: { type: "array", items: { type: "object" } },
          cursor: { type: "integer" },
        },
      };
    if (
      method === "get" &&
      [
        "/profiles",
        "/profiles/{profile}/presence",
        "/profiles/{profile}/webhook-subscriptions",
      ].includes(path)
    )
      success.content["application/json"].schema = {
        type: "array",
        items: { type: "object" },
      };
    if (path.endsWith("/content"))
      success.content = {
        "application/octet-stream": {
          schema: { type: "string", format: "binary" },
        },
      };
    if (path.endsWith("/reports"))
      success.content["application/x-ndjson"] = {
        schema: { type: "string" },
        description: "Uma linha JSON por registro; formato por streaming.",
      };
    if (path.endsWith("/tickets/{id}") && method === "get")
      success.content["application/json"].schema = {
        $ref: "#/components/schemas/TicketDetail",
      };
    if (mobile) {
      entry.tags = ["Aplicativos móveis"];
      const ref = (name: string) => ({
        $ref: `#/components/schemas/${name}`,
      });
      if (path === "/auth/mobile/login") {
        entry.security = [];
        entry.servers = [{ url: origin + "/api" }];
        entry.description +=
          " Rota servida em /api/auth/mobile/login, fora de /api/v1 (veja servers desta operação). Sem autenticação prévia; limite de 10 tentativas por IP a cada 10 minutos. Não exige Idempotency-Key.";
        success.content["application/json"].schema = ref("MobileSession");
      }
      if (path === "/auth/mobile/refresh") {
        entry.description +=
          " Estende a validade por 30 dias; use quando faltar menos de 7 dias. O token usado na chamada deixa de valer.";
        success.content["application/json"].schema = ref("MobileSession");
      }
      if (path === "/devices" && method === "get")
        success.content["application/json"].schema = {
          type: "array",
          items: ref("Device"),
        };
      if (path === "/devices/{id}" && method === "put") {
        entry.description +=
          " Cria ou substitui o dispositivo identificado pelo UUID gerado no aparelho; a operação é naturalmente idempotente e não exige Idempotency-Key.";
        success.content["application/json"].schema = ref("Device");
      }
      if (path === "/devices/{id}" && method === "delete")
        success.content["application/json"].schema = {
          type: "object",
          properties: { ok: { type: "boolean" } },
        };
      if (path.endsWith("/test"))
        success.content["application/json"].schema = ref("PushTestResult");
      if (path.startsWith("/system/push")) {
        entry.description += " Exige papel de administrador.";
        if (!path.endsWith("/test"))
          success.content["application/json"].schema = ref("PushConfig");
      }
      if (path === "/system/push/configure")
        entry.description +=
          " Segredo do gateway e conta de serviço FCM são guardados criptografados e nunca devolvidos; a resposta informa apenas se estão configurados.";
    }
    describeServiceOperation(path, method, entry, success);
    describeIntegrationOperation(path, entry, origin);
    (paths[path] ??= {})[method] = entry;
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "Wabotia API",
      version: "1.0.0",
      description:
        'Atendimento e bots Hermes. Integrações servidor-servidor cadastradas pelo administrador. Nunca exponha sua chave em JavaScript público. Webhooks são entregues ao menos uma vez; deduplique por ID. Assinatura HMAC-SHA256 sobre timestamp.corpo_original. As operações marcadas como "Aplicativos móveis" aceitam somente sessões de usuário (token wabu_, emitido por POST /api/auth/mobile/login) ou o cookie do painel; chaves de aplicação recebem 403. O login móvel é servido em /api/auth/mobile/login, fora de /api/v1.',
    },
    servers: [{ url: origin + "/api/v1" }],
    components: {
      securitySchemes: { BearerAuth: { type: "http", scheme: "bearer" } },
      schemas,
    },
    paths,
  };
}
