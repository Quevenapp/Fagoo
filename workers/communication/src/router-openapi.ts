const id = { type: "string", minLength: 1 };
const sources = {
  oneOf: [
    { required: ["number_id"], not: { required: ["pool_id"] } },
    { required: ["pool_id"], not: { required: ["number_id"] } },
  ],
};
const sourceProperties = {
  expires_at: {
    type: "integer",
    description:
      "Opcional: validade em milissegundos Unix, posterior ao pedido e no máximo 24 horas adiante. A entrega é cancelada se vencer na fila; omitir preserva o comportamento anterior.",
  },
  number_id: {
    ...id,
    description: "ID Wabotia do número, não o Phone Number ID da Meta.",
  },
  pool_id: {
    ...id,
    description:
      "ID de um grupo autorizado. Mantém o remetente após a primeira escolha.",
  },
  external_id: {
    ...id,
    maxLength: 200,
    description:
      "Identificador estável deste cliente/atendimento no sistema integrador. Reutilize para manter o remetente. Separado por aplicação.",
  },
  to: {
    type: "string",
    pattern: "^[0-9]{8,16}$",
    description:
      "Telefone do destinatário, DDI e DDD, sem + ou espaços. Obrigatório no primeiro envio.",
  },
  conversation_id: {
    ...id,
    description: "Opcional: conversa autorizada que já possui o remetente.",
  },
};
export const routerSchemas = {
  NumberPolicy: {
    type: "object",
    additionalProperties: false,
    required: [
      "purpose",
      "service",
      "templates",
      "human",
      "api",
      "menu",
      "bots",
      "pool",
    ],
    description:
      "Restrições por número. Não substituem os escopos e permissões da aplicação, consentimento, janela real ou autorização individual de cobrança. Números existentes mantêm suas opções até o administrador salvar. A função identifica a configuração sugerida; as opções booleanas determinam o comportamento.",
    properties: {
      purpose: { enum: ["official", "service_only", "custom"] },
      service: {
        type: "boolean",
        description: "Respostas sem template dentro da janela de 24h.",
      },
      service_overage: {
        type: "boolean",
        default: true,
        description:
          "False ativa Somente franquia gratuita: reservas de serviço são admitidas atomicamente até a franquia local. Saldo local não garante fatura sem cobrança. Omitir preserva a opção salva; linhas sem opção salva permitem excedente por compatibilidade.",
      },
      templates: {
        type: "boolean",
        description:
          "Permite templates com autorização individual de cobrança.",
      },
      human: {
        type: "boolean",
        description: "Atendimento manual pelo painel/Telegram.",
      },
      api: {
        type: "boolean",
        description: "Envios pelas aplicações autorizadas.",
      },
      menu: {
        type: "boolean",
        description: "Menu e saudação automática do perfil.",
      },
      bots: {
        type: "boolean",
        description: "Atendente e especialistas Hermes.",
      },
      pool: {
        type: "boolean",
        description: "Seleção e envio por grupos de roteamento.",
      },
    },
  },
  RouterNumberPolicy: {
    type: "object",
    required: ["policy"],
    properties: { policy: { $ref: "#/components/schemas/NumberPolicy" } },
  },
  RouterUsage: {
    type: "object",
    description:
      "Estimativa de uso e franquia; não é uma fatura Meta. Uso inclui o histórico inicial, entregas e reservas. service_overage_allowed=false bloqueia excedentes de serviço pelo contador conservador. Reservas sem confirmação atravessam o mês. Templates não consomem a franquia de serviço. limit/remaining são aliases legados de free_allowance/free_remaining.",
    properties: Object.fromEntries([
      ["period", { type: "string", example: "2026-11" }],
      ["timezone", { type: "string", example: "America/Sao_Paulo" }],
      ["service_overage_allowed", { type: "boolean" }],
      ...[
        "limit",
        "baseline",
        "used",
        "remaining",
        "free_allowance",
        "free_remaining",
        "paid_service_estimated",
        "reserved",
        "delivered",
        "service_delivered",
        "template_delivered",
        "free_confirmed",
        "billable_confirmed",
        "pricing_unknown",
        "monitored_at",
      ].map((key) => [key, { type: "integer", minimum: 0 }]),
    ]),
  },
  RouterView: {
    type: "object",
    properties: {
      numbers: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id,
            name: { type: "string" },
            number: { type: "string" },
            phone_id: id,
            account_id: id,
            status: { enum: ["active", "paused"] },
            direct_allowed: { type: "boolean" },
            policy: { $ref: "#/components/schemas/NumberPolicy" },
            usage: { $ref: "#/components/schemas/RouterUsage" },
          },
        },
      },
      pools: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id,
            name: { type: "string" },
            account_id: id,
            strategy: {
              const: "round_robin",
              description:
                "Rodízio com prioridade aos números com franquia gratuita. Linhas sem saldo que proíbem excedente saem da seleção; as demais podem continuar com serviço pago.",
            },
            enabled: { type: "integer" },
            allow_paid: { type: "integer" },
            members: { type: "array", items: id },
          },
        },
      },
      accounts: {
        type: "array",
        description: "Somente administrador humano; nunca inclui segredos.",
        items: { type: "object" },
      },
      applications: {
        type: "array",
        description: "Somente administrador humano.",
        items: { type: "object" },
      },
      grants: {
        type: "array",
        description: "Somente administrador humano.",
        items: { type: "object" },
      },
    },
  },
  RouterSend: {
    oneOf: [
      { $ref: "#/components/schemas/RouterServiceMessage" },
      { $ref: "#/components/schemas/RouterPaidMessage" },
    ],
  },
  RouterServiceMessage: {
    type: "object",
    required: ["external_id"],
    ...sources,
    not: { required: ["template"] },
    description:
      "Janela real de 24 horas aberta neste mesmo número. Se free_only=true ou service_overage=false, saldo esgotado retorna quota_exhausted sem trocar remetente. Vinki pareado exige free_only automaticamente, mesmo quando omitido ou falso. Caso contrário o serviço pode continuar com cobrança após a franquia. routing:paid/allow_paid se aplicam somente a templates. A janela vencida continua bloqueando texto livre. Um anexo por pedido. O envio assume a conversa em nome da aplicação; não pode tomar atendimento de outra pessoa.",
    properties: {
      ...sourceProperties,
      free_only: {
        type: "boolean",
        default: false,
        description:
          "Exige saldo no contador conservador para este pedido, mesmo se a linha permite excedente. A reserva é atômica, permanece na fila e é revalidada antes da entrega. Não garante fatura sem cobrança. Obrigatório por regra do servidor para aplicações pareadas como Vinki.",
      },
      text: { type: "string", maxLength: 4096 },
      attachments: { type: "array", maxItems: 1, items: id },
      content: { $ref: "#/components/schemas/MessageContent" },
    },
    example: {
      pool_id: "ID_GRUPO",
      to: "5511999991111",
      external_id: "cliente-123",
      text: "Olá! Como podemos ajudar?",
    },
  },
  RouterPaidMessage: {
    type: "object",
    required: ["external_id", "allow_paid", "consent", "template"],
    ...sources,
    description:
      "Modelo aprovado da WABA. Exige routing:paid, permissão paga da origem, grupo habilitado para pagos, autorização por pedido e consentimento da mesma categoria. Não abre uma janela de atendimento artificialmente.",
    properties: {
      ...sourceProperties,
      free_only: {
        const: false,
        description:
          "Modelos pagos não aceitam free_only=true. Aplicações pareadas como Vinki não podem enviar modelos pagos.",
      },
      allow_paid: {
        const: true,
        description:
          "Autorização de possível cobrança somente para este envio.",
      },
      consent: {
        type: "object",
        required: ["granted", "category", "reference"],
        properties: {
          granted: { const: true },
          category: { enum: ["marketing", "utility", "authentication"] },
          reference: {
            type: "string",
            minLength: 3,
            maxLength: 1000,
            description:
              "Referência da comprovação do aceite do destinatário. Não substitui consentimento retirado.",
          },
        },
      },
      template: {
        type: "object",
        required: ["name", "language"],
        properties: {
          name: { type: "string", pattern: "^[a-z0-9_]{1,512}$" },
          language: { type: "string", example: "pt_BR" },
          components: {
            type: "array",
            maxItems: 12,
            description:
              "Parâmetros dos componentes aprovados: texto posicional ou nomeado; header image/video/document com media_id privado do Wabotia; botão url, quick_reply ou copy_code. Formatos não suportados são recusados.",
            items: {
              type: "object",
              required: ["type", "parameters"],
              properties: {
                type: { enum: ["body", "header", "button"] },
                sub_type: { enum: ["url", "quick_reply", "copy_code"] },
                index: { type: ["string", "integer"] },
                parameters: {
                  type: "array",
                  items: {
                    type: "object",
                    required: ["type"],
                    properties: {
                      type: {
                        enum: [
                          "text",
                          "image",
                          "video",
                          "document",
                          "payload",
                          "coupon_code",
                        ],
                      },
                      text: { type: "string" },
                      parameter_name: { type: "string" },
                      media_id: id,
                      payload: { type: "string" },
                      coupon_code: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    example: {
      pool_id: "ID_GRUPO",
      to: "5511999992222",
      external_id: "cliente-456",
      allow_paid: true,
      consent: {
        granted: true,
        category: "utility",
        reference: "Aceite no pedido 456",
      },
      template: {
        name: "pedido_atualizado",
        language: "pt_BR",
        components: [
          { type: "body", parameters: [{ type: "text", text: "456" }] },
        ],
      },
    },
  },
  RouterQueued: {
    type: "object",
    required: ["delivery_id", "conversation_id", "number_id", "status"],
    properties: {
      delivery_id: id,
      conversation_id: id,
      number_id: id,
      source_type: { enum: ["number", "pool"] },
      source_id: id,
      status: { const: "pending" },
      free_only: {
        type: "boolean",
        description:
          "Restrição efetiva deste pedido; pode ser imposta pelo pareamento Vinki.",
      },
      expires_at: {
        type: ["integer", "null"],
        description:
          "Validade em milissegundos Unix, ou null quando não definida.",
      },
      usage: { $ref: "#/components/schemas/RouterUsage" },
      billing: {
        type: "object",
        properties: {
          mode: {
            enum: ["service_allowance", "service_paid", "paid_template"],
          },
          authorized: { type: "boolean" },
          category: { type: "string" },
          estimated: {
            type: "boolean",
            description:
              "A classificação de serviço usa o contador local; a cobrança final é informada pela Meta.",
          },
          service_overage_allowed: { type: "boolean" },
        },
      },
    },
  },
  RouterDelivery: {
    type: "object",
    description:
      "sent confirma aceitação pelo canal. Consulte provider_status para entrega/leitura. unknown exige reconciliação; não repita com outro número. Somente a aplicação autora ou equipe do perfil pode consultar.",
    properties: {
      id,
      delivery_id: id,
      conversation_id: id,
      number_id: id,
      status: {
        enum: ["pending", "sending", "sent", "failed", "unknown", "cancelled"],
      },
      provider_status: { type: ["string", "null"] },
      provider_category: { type: ["string", "null"] },
      billable: { type: ["boolean", "null"] },
      error: { type: ["string", "null"] },
      free_only: { type: "boolean" },
      expires_at: { type: ["integer", "null"] },
      source: {
        type: "object",
        properties: { type: { enum: ["number", "pool"] }, id },
      },
      created: { type: "integer" },
      updated: { type: "integer" },
    },
  },
  RouterAccount: {
    type: "object",
    required: ["name", "waba_id"],
    properties: {
      id,
      name: { type: "string", maxLength: 100 },
      waba_id: { type: "string", pattern: "^[0-9]{3,40}$" },
      timezone: { type: "string", default: "America/Sao_Paulo" },
      secrets: {
        type: "object",
        description:
          "Todos obrigatórios ao criar; campos vazios mantêm credenciais existentes ao editar.",
        properties: Object.fromEntries(
          ["token", "app_secret", "verify_token"].map((key) => [
            key,
            { type: "string", writeOnly: true, maxLength: 4096 },
          ]),
        ),
      },
    },
  },
  RouterNumber: {
    type: "object",
    required: ["account_id", "phone_id", "baseline_used", "baseline_confirmed"],
    description:
      "Números autorizados pela Meta na WABA, descobertos há menos de uma hora, sem teto de quantidade imposto pelo roteador. Cria pausado; conexão existente deve estar pausada e sem entregas não confirmadas.",
    properties: {
      account_id: id,
      phone_id: id,
      name: { type: "string" },
      baseline_used: { type: "integer", minimum: 0, maximum: 100000000 },
      baseline_confirmed: { const: true },
      service_limit: {
        type: "integer",
        minimum: 0,
        maximum: 1000,
        default: 1000,
        description:
          "Franquia gratuita mensal para priorizar novas entradas e limitar o envio quando service_overage=false.",
      },
    },
  },
  RouterLimit: {
    type: "object",
    description:
      "Atualiza a franquia gratuita estimada. Se service_overage=false, reduz também o limite de admissão e mensagens pendentes excedentes são bloqueadas antes do envio.",
    required: ["service_limit"],
    properties: {
      service_limit: { type: "integer", minimum: 0, maximum: 1000 },
    },
  },
  RouterPool: {
    type: "object",
    required: ["account_id", "name", "members"],
    properties: {
      id,
      account_id: id,
      name: { type: "string", maxLength: 100 },
      members: {
        type: "array",
        minItems: 1,
        uniqueItems: true,
        items: id,
      },
      strategy: {
        enum: ["least_used", "round_robin", "random"],
        default: "round_robin",
        description:
          "Novos e antigos grupos usam rodízio com prioridade à franquia. Valores legados least_used/random são aceitos por compatibilidade e normalizados para round_robin.",
      },
      enabled: { type: "boolean", default: false },
      allow_paid: {
        type: "boolean",
        default: false,
        description:
          "Habilita templates pagos. Excedente de serviço depende de service_overage na linha, não desta opção.",
      },
      public_enabled: {
        type: "boolean",
        default: false,
        description:
          "Gera link de entrada que redireciona para wa.me; não envia mensagem.",
      },
    },
  },
  RouterGrants: {
    type: "object",
    required: ["app_id", "numbers", "pools"],
    properties: {
      app_id: id,
      numbers: { type: "array", maxItems: 100, items: id },
      pools: { type: "array", maxItems: 100, items: id },
      allow_paid: { type: "boolean", default: false },
      enable_scopes: {
        type: "boolean",
        default: false,
        description:
          "Adiciona routing:read/send e conversations:read/write; adiciona routing:paid se allow_paid. Substitui as origens deste perfil, sem remover escopos de outros perfis.",
      },
    },
  },
};
export const routerOperations: [string, string, string, string, string?][] = [
  [
    "get",
    "/profiles/{profile}/router",
    "Números, grupos autorizados e contadores",
    "routing:read",
  ],
  [
    "post",
    "/profiles/{profile}/router/messages",
    "Escolher remetente e enfileirar mensagem",
    "routing:read + routing:send + conversations:write; modelos também routing:paid",
    "RouterSend",
  ],
  [
    "get",
    "/profiles/{profile}/router/messages/{id}",
    "Consultar estado e recibo de um envio",
    "routing:read",
  ],
  [
    "post",
    "/profiles/{profile}/router/messages/{id}/cancel",
    "Cancelar envio ainda pending (somente autor ou administrador)",
    "routing:read + routing:send",
  ],
  [
    "post",
    "/profiles/{profile}/router/accounts",
    "Cadastrar ou editar conta Meta",
    "administrador humano",
    "RouterAccount",
  ],
  [
    "post",
    "/profiles/{profile}/router/accounts/{id}/discover",
    "Buscar números da WABA sem ativar nem enviar",
    "administrador humano",
  ],
  [
    "post",
    "/profiles/{profile}/router/numbers",
    "Adicionar número descoberto com uso inicial",
    "administrador humano",
    "RouterNumber",
  ],
  [
    "put",
    "/profiles/{profile}/router/numbers/{id}/limit",
    "Alterar franquia gratuita estimada",
    "administrador humano",
    "RouterLimit",
  ],
  [
    "put",
    "/profiles/{profile}/router/numbers/{id}/policy",
    "Definir função e permissões do número",
    "administrador humano",
    "RouterNumberPolicy",
  ],
  [
    "post",
    "/profiles/{profile}/router/pools",
    "Criar ou editar grupo da mesma WABA",
    "administrador humano",
    "RouterPool",
  ],
  [
    "put",
    "/profiles/{profile}/router/grants",
    "Substituir origens permitidas à aplicação neste perfil",
    "administrador humano",
    "RouterGrants",
  ],
];
