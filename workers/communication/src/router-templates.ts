import { Env, Actor, ApiError, requireValue, json, now } from "./types";
import { access } from "./security";
import { one } from "./db";
import { metaRequest } from "./meta";
import { authorizedMedia } from "./media";
import { validateMedia } from "./whatsapp";
import { metaUpload } from "./integrations";

function textParameters(definition: string, supplied: any, named: boolean) {
  const names = [
    ...new Set(
      Array.from(
        definition.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g),
        (m) => m[1],
      ),
    ),
  ];
  const params = supplied || [];
  requireValue(
    Array.isArray(params) && params.length === names.length,
    "Quantidade de parâmetros diferente do modelo aprovado.",
  );
  const seen = new Set();
  return params.map((p: any, i: number) => {
    requireValue(
      p?.type === "text" &&
        typeof p.text === "string" &&
        p.text.trim() &&
        p.text.length <= 32768,
      "Use parâmetros de texto válidos no modelo.",
    );
    if (named) {
      requireValue(
        names.includes(p.parameter_name) && !seen.has(p.parameter_name),
        "Parâmetro nomeado inválido ou repetido.",
      );
      seen.add(p.parameter_name);
    } else
      requireValue(
        !p.parameter_name && names.includes(String(i + 1)),
        "Parâmetros posicionais inválidos.",
      );
    return {
      type: "text",
      text: p.text,
      ...(named ? { parameter_name: p.parameter_name } : {}),
    };
  });
}
export async function paidTemplate(
  env: Env,
  actor: Actor,
  conn: any,
  data: any,
) {
  access(actor, conn.profile_id, "routing:paid");
  requireValue(
    data.allow_paid === true,
    "Declare allow_paid: true neste pedido para autorizar possível cobrança da Meta.",
  );
  requireValue(
    data.consent?.granted === true &&
      typeof data.consent.reference === "string" &&
      data.consent.reference.trim().length >= 3 &&
      data.consent.reference.length <= 1000,
    "Informe o consentimento e uma referência da comprovação para este destinatário.",
  );
  const input = data.template;
  requireValue(
    input &&
      /^[a-z0-9_]{1,512}$/.test(input.name || "") &&
      /^[a-zA-Z_]{2,12}$/.test(input.language || ""),
    "Informe nome e idioma do modelo.",
  );
  const cfg = json(conn.config);
  const response = await metaRequest(
    env,
    conn,
    `${cfg.waba_id}/message_templates?name=${encodeURIComponent(input.name)}&fields=name,language,status,category,components,parameter_format&limit=100`,
  );
  const approved = response.data?.find(
    (t: any) =>
      t.name === input.name &&
      t.language === input.language &&
      t.status === "APPROVED",
  );
  requireValue(
    approved &&
      ["MARKETING", "UTILITY", "AUTHENTICATION"].includes(approved.category),
    "A Meta não confirmou este modelo como aprovado para a conta e o idioma.",
  );
  requireValue(
    data.consent.category === approved.category.toLowerCase(),
    "A categoria do consentimento deve corresponder ao modelo: marketing, utility ou authentication.",
  );
  const inputs = input.components || [];
  requireValue(
    Array.isArray(inputs) &&
      inputs.length <= 12 &&
      JSON.stringify(inputs).length <= 50000,
    "Componentes do modelo inválidos.",
  );
  requireValue(
    inputs.every(
      (c: any) =>
        c &&
        typeof c === "object" &&
        ["body", "header", "button"].includes(c.type),
    ),
    "Componente de modelo inválido.",
  );
  const components: any[] = [],
    mediaIds: string[] = [],
    used = new Set<any>();
  const get = (type: string, index?: number) => {
    const found = inputs.filter(
      (c: any) =>
        c.type === type &&
        (index === undefined || String(c.index) === String(index)),
    );
    requireValue(found.length <= 1, "Componente de modelo repetido.");
    if (found[0]) used.add(found[0]);
    return found[0];
  };
  for (const def of approved.components || []) {
    if (
      def.type === "BODY" ||
      (def.type === "HEADER" && (def.format || "TEXT") === "TEXT")
    ) {
      const type = def.type.toLowerCase(),
        supplied = get(type);
      const parameters = textParameters(
        def.text || "",
        supplied?.parameters,
        approved.parameter_format === "NAMED",
      );
      if (parameters.length) components.push({ type, parameters });
    } else if (
      def.type === "HEADER" &&
      ["IMAGE", "VIDEO", "DOCUMENT"].includes(def.format)
    ) {
      const supplied = get("header"),
        kind = def.format.toLowerCase();
      requireValue(
        supplied?.parameters?.length === 1 &&
          supplied.parameters[0]?.type === kind &&
          typeof supplied.parameters[0].media_id === "string",
        "O cabeçalho exige um media_id privado do Wabotia.",
      );
      const media = await authorizedMedia(
        env,
        actor,
        conn.profile_id,
        supplied.parameters[0].media_id,
      );
      validateMedia(media, kind, conn);
      mediaIds.push(media.id);
      components.push({
        type: "header",
        parameters: [{ type: kind, wabotia_media_id: media.id }],
      });
    } else if (def.type === "BUTTONS") {
      for (const [index, button] of (def.buttons || []).entries()) {
        const supplied = get("button", index);
        const dynamic =
          (button.type === "URL" && /\{\{/.test(button.url || "")) ||
          button.type === "OTP";
        if (!supplied && !dynamic && button.type !== "COPY_CODE") continue;
        requireValue(
          supplied &&
            Array.isArray(supplied.parameters) &&
            supplied.parameters.length === 1,
          "Informe o parâmetro do botão do modelo.",
        );
        const p = supplied.parameters[0];
        if (button.type === "URL" || button.type === "OTP") {
          requireValue(
            supplied.sub_type === "url" &&
              p.type === "text" &&
              typeof p.text === "string" &&
              p.text.length > 0 &&
              p.text.length <= 2000,
            "Parâmetro de URL inválido.",
          );
          components.push({
            type: "button",
            sub_type: "url",
            index: String(index),
            parameters: [{ type: "text", text: p.text }],
          });
        } else if (button.type === "QUICK_REPLY") {
          requireValue(
            supplied.sub_type === "quick_reply" &&
              p.type === "payload" &&
              typeof p.payload === "string" &&
              p.payload.length > 0 &&
              p.payload.length <= 128,
            "Resposta rápida inválida.",
          );
          components.push({
            type: "button",
            sub_type: "quick_reply",
            index: String(index),
            parameters: [{ type: "payload", payload: p.payload }],
          });
        } else if (button.type === "COPY_CODE") {
          requireValue(
            supplied.sub_type === "copy_code" &&
              p.type === "coupon_code" &&
              typeof p.coupon_code === "string" &&
              p.coupon_code.length > 0 &&
              p.coupon_code.length <= 15,
            "Código de cupom inválido.",
          );
          components.push({
            type: "button",
            sub_type: "copy_code",
            index: String(index),
            parameters: [{ type: "coupon_code", coupon_code: p.coupon_code }],
          });
        } else
          throw new ApiError(
            422,
            "unsupported_template",
            "Este tipo de botão ainda não é suportado pelo roteador.",
          );
      }
    } else if (def.type !== "FOOTER")
      throw new ApiError(
        422,
        "unsupported_template",
        "Este formato de modelo ainda não é suportado pelo roteador.",
      );
  }
  requireValue(
    used.size === inputs.length,
    "Componente não previsto no modelo aprovado.",
  );
  return {
    text: `Modelo ${input.name} (${approved.category.toLowerCase()})`,
    content: {
      type: "template",
      template_name: input.name,
      template_category: approved.category.toLowerCase(),
    },
    template_message: {
      type: "template",
      template: {
        name: input.name,
        language: { code: input.language },
        ...(components.length ? { components } : {}),
      },
    },
    template_media_ids: mediaIds,
    paid_authorization: {
      actor: actor.id,
      authorized_at: now(),
      category: approved.category.toLowerCase(),
      consent_reference: data.consent.reference,
    },
  };
}
export async function assertPaidConsent(
  env: Env,
  conversation: any,
  payload: any,
) {
  requireValue(
    payload.paid_authorization?.actor,
    "Autorização de cobrança ausente.",
  );
  const consent = await one(
    env,
    "SELECT status FROM consents WHERE conversation_id=? ORDER BY created DESC,rowid DESC LIMIT 1",
    conversation.id,
  );
  if (consent?.status !== "granted")
    throw new ApiError(
      400,
      "consent_required",
      "O consentimento foi retirado ou não está disponível.",
    );
}
export async function preparePaidTemplate(
  env: Env,
  conn: any,
  conversation: any,
  payload: any,
) {
  await assertPaidConsent(env, conversation, payload);
  const body = structuredClone(payload.template_message);
  for (const component of body.template.components || [])
    for (const parameter of component.parameters || [])
      if (parameter.wabotia_media_id) {
        const media = await metaUpload(
          env,
          conn,
          parameter.wabotia_media_id,
          parameter.type,
        );
        parameter[parameter.type] = {
          id: media.id,
          ...(parameter.type === "document" ? { filename: media.name } : {}),
        };
        delete parameter.wabotia_media_id;
      }
  return body;
}
