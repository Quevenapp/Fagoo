import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { all, exec, one } from "../src/db";
import { defaults, json, now, uid, type Actor } from "../src/types";
import {
  conversation,
  handoff,
  inbound,
  openTicket,
  perform,
  requestSurvey,
} from "../src/service";
import { processInbox } from "../src/engine";
import { lookupProtocols, sendProtocolLookup } from "../src/protocol-lookup";
import { availableMenus, menuPayload, sendMenu } from "../src/line-service";

async function fixture() {
  const profile = uid(),
    line = uid(),
    second = uid(),
    qr = uid();
  await exec(
    env,
    "INSERT INTO profiles(id,name,settings,enabled,created) VALUES(?,?,?,1,?)",
    profile,
    "Atendimento",
    JSON.stringify(defaults),
    now(),
  );
  for (const id of [line, second, qr])
    await exec(
      env,
      "INSERT INTO connections(id,profile_id,name,kind,mode,status,config,created) VALUES(?,?,?,?, 'direct','active','{}',?)",
      id,
      profile,
      id,
      id === qr ? "qr" : "meta",
      now(),
    );
  const people: Actor[] = [];
  for (const role of ["admin", "operator", "operator"] as const) {
    const id = uid();
    await exec(
      env,
      "INSERT INTO users(id,email,name,password,role,profiles,created) VALUES(?,?,?,?,?,?,?)",
      id,
      `${id}@example.test`,
      id,
      "test",
      role,
      JSON.stringify([profile]),
      now(),
    );
    people.push({
      id,
      name: id,
      kind: "user",
      role,
      profiles: [profile],
      scopes: [],
      bots: [],
      rate: 100,
      runLimit: 10,
    });
  }
  return {
    profile,
    line,
    second,
    qr,
    admin: people[0],
    member: people[1],
    other: people[2],
  };
}
async function receive(
  f: any,
  line: string,
  text: string,
  phone = "5511999998888",
  content: any = {},
) {
  const result = await inbound(
    env,
    f.profile,
    { external_id: phone, phone, message_id: uid(), text, content },
    `channel:${line}`,
    line,
  );
  return conversation(env, result.conversation_id, f.profile);
}
async function configure(f: any, body: any) {
  return perform(env, f.admin, f.profile, "settings", body, uid());
}
async function latest(c: string) {
  return json(
    (
      await one(
        env,
        "SELECT payload FROM outbox WHERE conversation_id=? ORDER BY created DESC,rowid DESC LIMIT 1",
        c,
      )
    )?.payload,
  );
}
async function drain(f: any) {
  while (
    await one(
      env,
      "SELECT id FROM inbox WHERE profile_id=? AND status='pending'",
      f.profile,
    )
  )
    await processInbox(env, f.profile);
}

describe("consulta de protocolos pelo titular", () => {
  it("reconhece telefone entre linhas do mesmo perfil e inclui somente andamentos públicos", async () => {
    const f = await fixture();
    const original = await receive(f, f.line, "pedido");
    const ticket = await openTicket(
      env,
      original,
      "system",
      "Segunda via de boleto",
    );
    await exec(
      env,
      "INSERT INTO ticket_updates(id,ticket_id,actor,text,internal,created) VALUES(?,?,?,?,0,?)",
      uid(),
      ticket.id,
      f.admin.id,
      "Boleto em preparação",
      now(),
    );
    await exec(
      env,
      "INSERT INTO ticket_updates(id,ticket_id,actor,text,internal,created) VALUES(?,?,?,?,1,?)",
      uid(),
      ticket.id,
      f.admin.id,
      "Nota privada nunca enviada",
      now() + 1,
    );
    const current = await receive(f, f.second, "consultar protocolos");
    const rows = await lookupProtocols(env, current);
    expect(rows.map((r) => r.number)).toEqual([ticket.number]);
    expect(rows[0].latest_update).toBe("Boleto em preparação");
    await sendProtocolLookup(env, current, ticket.number, uid());
    const result = await latest(current.id);
    expect(result.text).toContain(ticket.number);
    expect(result.text).toContain("Prazo de primeira resposta");
    expect(result.text).not.toContain("Nota privada");
    expect(result.text).not.toContain(f.admin.id);
  });
  it("não revela outro telefone, outro perfil, identidade de aplicação ou protocolo de grupo", async () => {
    const f = await fixture(),
      other = await fixture();
    const original = await receive(f, f.line, "pedido"),
      ticket = await openTicket(env, original, "system", "Privado");
    const stranger = await receive(f, f.second, "consultar", "5511999997777");
    const otherProfile = await receive(other, other.line, "consultar");
    const application = await inbound(
      env,
      f.profile,
      {
        external_id: "5511999998888",
        phone: "5511999998888",
        message_id: uid(),
        text: "consultar",
      },
      "app:test",
      null,
    );
    for (const c of [
      stranger,
      otherProfile,
      await conversation(env, application.conversation_id, f.profile),
    ])
      expect(await lookupProtocols(env, c, ticket.number)).toEqual([]);
    await expect(
      lookupProtocols(env, { ...original, chat_type: "group" }, ticket.number),
    ).rejects.toThrow("individual");
    await expect(lookupProtocols(env, original, "WA-invalid")).rejects.toThrow(
      "número completo",
    );
  });
  it("o número digitado encontra protocolo antigo e não repete o texto interno", async () => {
    const f = await fixture(),
      old = await receive(f, f.line, "solicitação");
    const ticket = await openTicket(env, old, "system", "Entrega");
    const next = await receive(f, f.second, ticket.number.toLowerCase());
    await drain(f);
    expect((await latest(next.id)).text).toContain(ticket.number);
    expect((await latest(next.id)).text).toContain("Aberto");
  });
});

describe("menus interativos e destinos", () => {
  it("envia botões Meta, valida ID estável após reordenação e encaminha para setor com fila", async () => {
    const f = await fixture();
    const department = {
      id: "financeiro",
      name: "Financeiro",
      members: [f.member.id],
      enabled: true,
    };
    const menus = [
      {
        id: "fin",
        label: "Financeiro",
        type: "human",
        department_id: department.id,
      },
      {
        id: "info",
        label: "Informações",
        type: "content",
        content: "Horário: 9h às 18h",
      },
    ];
    await configure(f, { departments: [department], menus });
    await exec(
      env,
      "INSERT INTO presence(profile_id,actor,present,updated) VALUES(?,?,1,?)",
      f.profile,
      f.other.id,
      now(),
    );
    const c = await receive(f, f.line, "Olá");
    await drain(f);
    const menu = await latest(c.id);
    expect(menu.content.interactive.type).toBe("button");
    const id = menu.content.interactive.action.buttons[0].reply.id;
    await configure(f, { menus: [...menus].reverse() });
    await receive(f, f.line, "Financeiro", undefined, {
      interactive_reply_id: id,
    });
    await drain(f);
    const routed = await conversation(env, c.id, f.profile);
    expect(routed.department_id).toBe("financeiro");
    expect(routed.state).toBe("waiting");
    expect(
      await one(env, "SELECT id FROM tickets WHERE conversation_id=?", c.id),
    ).toBeTruthy();
    await expect(
      perform(
        env,
        f.other,
        f.profile,
        "conversation.action",
        { id: c.id, action: "claim" },
        uid(),
      ),
    ).rejects.toThrow("setor responsável");
    await perform(
      env,
      f.member,
      f.profile,
      "conversation.action",
      { id: c.id, action: "claim" },
      uid(),
    );
    expect((await conversation(env, c.id, f.profile)).owner).toBe(f.member.id);
  });
  it("recusa opção forjada, de outro menu/linha, expirada ou de sessão anterior sem usar o título", async () => {
    const f = await fixture();
    await configure(f, {
      menus: [
        { id: "general", label: "Atendente", type: "human" },
        {
          id: "restricted",
          label: "Restrito",
          type: "content",
          content: "Segredo",
          line_ids: [f.second],
        },
      ],
    });
    let c = await receive(f, f.line, "Olá");
    await drain(f);
    c = await conversation(env, c.id, f.profile);
    const valid = `wmenu:${c.menu_token}:general`;
    for (const id of [
      `wmenu:${c.menu_token}:restricted`,
      `wmenu:forjado:general`,
    ]) {
      await receive(f, f.line, "Atendente", undefined, {
        interactive_reply_id: id,
      });
      await drain(f);
      expect((await conversation(env, c.id, f.profile)).state).toBe("ai");
      expect((await latest(c.id)).text).toContain("não está mais disponível");
    }
    await exec(
      env,
      "UPDATE conversations SET menu_expires_at=? WHERE id=?",
      now() - 1,
      c.id,
    );
    await receive(f, f.line, "Atendente", undefined, {
      interactive_reply_id: valid,
    });
    await drain(f);
    expect((await conversation(env, c.id, f.profile)).state).toBe("ai");
    await exec(
      env,
      "UPDATE conversations SET menu_expires_at=?,session=? WHERE id=?",
      now() + 10000,
      uid(),
      c.id,
    );
    await receive(f, f.line, "Atendente", undefined, {
      interactive_reply_id: valid,
    });
    await drain(f);
    expect((await conversation(env, c.id, f.profile)).state).toBe("ai");
  });
  it("usa lista para títulos longos e texto para canais sem suporte ou mais de dez opções", async () => {
    expect(
      menuPayload(
        [{ id: "long", label: "Uma opção com título comprido" }],
        "Menu",
        "token",
        true,
      ).content?.interactive.type,
    ).toBe("list");
    expect(
      menuPayload(
        Array.from({ length: 11 }, (_, i) => ({
          id: String(i),
          label: `Opção ${i}`,
        })),
        "Menu",
        "token",
        true,
      ).content,
    ).toBeUndefined();
    const f = await fixture();
    await configure(f, {
      menus: [
        {
          id: "link",
          label: "Site",
          type: "link",
          url: "https://example.com/ajuda",
        },
      ],
    });
    const c = await receive(f, f.qr, "Olá");
    await drain(f);
    expect((await latest(c.id)).content).toBeUndefined();
    await receive(f, f.qr, "1");
    await drain(f);
    expect((await latest(c.id)).text).toContain("https://example.com/ajuda");
  });
  it("oferece consulta de protocolo e avaliação pelo menu, e MENU cancela a nota pendente", async () => {
    const f = await fixture();
    await configure(f, {
      menus: [
        { id: "tickets", label: "Protocolos", type: "protocols" },
        { id: "rating", label: "Avaliar", type: "survey" },
      ],
    });
    const c = await receive(f, f.line, "Olá");
    await drain(f);
    const ticket = await openTicket(env, c, "system", "Solicitação");
    await receive(f, f.line, "1");
    await drain(f);
    expect((await latest(c.id)).text).toContain(ticket.number);
    await receive(f, f.line, "menu");
    await drain(f);
    await receive(f, f.line, "2");
    await drain(f);
    expect(
      await one(
        env,
        "SELECT id FROM surveys WHERE conversation_id=? AND status='pending'",
        c.id,
      ),
    ).toBeTruthy();
    await receive(f, f.line, "menu");
    await drain(f);
    expect(
      await one(
        env,
        "SELECT id FROM surveys WHERE conversation_id=? AND status='pending'",
        c.id,
      ),
    ).toBeNull();
    await receive(f, f.line, "1");
    await drain(f);
    expect((await latest(c.id)).text).toContain(ticket.number);
  });
  it("uma pessoa pode consultar e convidar avaliação pela mesma API de ações", async () => {
    const f = await fixture(),
      c = await receive(f, f.line, "ajuda");
    await perform(
      env,
      f.member,
      f.profile,
      "conversation.action",
      { id: c.id, action: "claim" },
      uid(),
    );
    const ticket = await openTicket(
      env,
      await conversation(env, c.id, f.profile),
      f.member.id,
      "Pedido",
    );
    await expect(
      perform(
        env,
        f.other,
        f.profile,
        "conversation.action",
        { id: c.id, action: "protocols" },
        uid(),
      ),
    ).rejects.toThrow("Assuma");
    const sent = await perform(
      env,
      f.member,
      f.profile,
      "conversation.action",
      { id: c.id, action: "protocols", number: ticket.number },
      uid(),
    );
    expect(sent.data[0].number).toBe(ticket.number);
    await perform(
      env,
      f.member,
      f.profile,
      "conversation.action",
      { id: c.id, action: "survey" },
      uid(),
    );
    expect((await latest(c.id)).text).toContain("1 a 5");
  });
  it("valida membros de setor, links e tipos booleanos", async () => {
    const f = await fixture(),
      other = await fixture();
    await expect(
      configure(f, {
        departments: [
          { id: "wrong", name: "Outro", members: [other.member.id] },
        ],
      }),
    ).rejects.toThrow("autorizada");
    await expect(
      configure(f, {
        menus: [
          { id: "x", label: "Link", type: "link", url: "javascript:alert(1)" },
        ],
      }),
    ).rejects.toThrow();
    await expect(configure(f, { jev_enabled: "false" })).rejects.toThrow(
      "ligados ou desligados",
    );
    await expect(
      configure(f, {
        menus: [
          { id: "x", label: "Setor", type: "human", department_id: "missing" },
        ],
      }),
    ).rejects.toThrow("Setor");
  });
  it("registra avaliação solicitada por pessoa mesmo com automação pausada e não responde automaticamente", async () => {
    const f = await fixture(),
      c = await receive(f, f.line, "ajuda");
    await exec(
      env,
      "UPDATE connections SET config=? WHERE id=?",
      JSON.stringify({
        number_policy: { human: true, menu: false, bots: false, service: true },
      }),
      f.line,
    );
    await exec(env, "UPDATE profiles SET enabled=0 WHERE id=?", f.profile);
    await drain(f);
    const requested = await requestSurvey(env, c, uid(), f.member.id);
    await receive(f, f.line, "5 Ótimo atendimento");
    await drain(f);
    expect(
      await one(
        env,
        "SELECT score,comment,status FROM surveys WHERE id=?",
        requested.survey_id,
      ),
    ).toMatchObject({
      score: 5,
      comment: "Ótimo atendimento",
      status: "answered",
    });
    expect(
      await all(env, "SELECT id FROM outbox WHERE conversation_id=?", c.id),
    ).toHaveLength(1);
  });
  it("não interpreta uma mensagem antiga como resposta de uma pesquisa nova", async () => {
    const f = await fixture(),
      c = await receive(f, f.line, "5");
    const requested = await requestSurvey(env, c, uid(), f.admin.id);
    await exec(
      env,
      "UPDATE surveys SET created=? WHERE id=?",
      now() + 1000,
      requested.survey_id,
    );
    await drain(f);
    expect(
      (
        await one(
          env,
          "SELECT status FROM surveys WHERE id=?",
          requested.survey_id,
        )
      ).status,
    ).toBe("pending");
  });
  it("aplicação precisa de tickets:read além de permissão para escrever na conversa", async () => {
    const f = await fixture(),
      c = await receive(f, f.line, "consulta");
    const app: Actor = {
      ...f.admin,
      id: "app:test",
      kind: "app",
      role: "service",
      scopes: ["conversations:write"],
    };
    await exec(
      env,
      "UPDATE conversations SET owner=?,state='human' WHERE id=?",
      app.id,
      c.id,
    );
    await expect(
      perform(
        env,
        app,
        f.profile,
        "conversation.action",
        { id: c.id, action: "protocols" },
        uid(),
      ),
    ).rejects.toThrow("tickets:read");
  });
  it("não oferece consultas individuais em grupo e preserva o menu de conteúdo", async () => {
    const f = await fixture();
    await configure(f, {
      menus: [
        { id: "tickets", label: "Protocolos", type: "protocols" },
        { id: "rating", label: "Avaliar", type: "survey" },
        {
          id: "content",
          label: "Horários",
          type: "content",
          content: "De segunda a sexta.",
        },
      ],
    });
    expect(
      (await availableMenus(env, f.profile, f.qr, null, false, "group")).map(
        (item: any) => item.id,
      ),
    ).toEqual(["content"]);
  });
  it("não cria uma pesquisa se a política da linha recusar seu envio", async () => {
    const f = await fixture(),
      c = await receive(f, f.line, "ajuda");
    await exec(
      env,
      "UPDATE connections SET config=? WHERE id=?",
      JSON.stringify({ number_policy: { human: false } }),
      f.line,
    );
    await expect(requestSurvey(env, c, uid(), f.member.id)).rejects.toThrow(
      "não permite",
    );
    expect(
      await all(env, "SELECT id FROM surveys WHERE conversation_id=?", c.id),
    ).toHaveLength(0);
  });
  it("transfere o protocolo aberto junto com a fila sem reiniciar o prazo", async () => {
    const f = await fixture(),
      c = await receive(f, f.line, "pedido");
    await configure(f, {
      departments: [{ id: "support", name: "Suporte", members: [f.other.id] }],
      protocol_response_hours: 24,
    });
    await perform(
      env,
      f.member,
      f.profile,
      "conversation.action",
      { id: c.id, action: "claim" },
      uid(),
    );
    const ticket = await openTicket(
      env,
      await conversation(env, c.id, f.profile),
      f.member.id,
      "Problema",
    );
    await perform(
      env,
      f.member,
      f.profile,
      "conversation.action",
      { id: c.id, action: "transfer", department_id: "support" },
      uid(),
    );
    expect(
      (await one(env, "SELECT owner FROM tickets WHERE id=?", ticket.id)).owner,
    ).toBeNull();
    await perform(
      env,
      f.other,
      f.profile,
      "conversation.action",
      { id: c.id, action: "claim" },
      uid(),
    );
    expect(
      await one(
        env,
        "SELECT owner,response_due_at FROM tickets WHERE id=?",
        ticket.id,
      ),
    ).toMatchObject({
      owner: f.other.id,
      response_due_at: ticket.response_due_at,
    });
  });
});
