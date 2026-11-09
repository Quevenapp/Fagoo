import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { one, exec } from "../src/db";
import { defaults, uid, now, json, type Run } from "../src/types";
import { setSecret } from "../src/security";
import { inbound } from "../src/service";
import { processInbox, processRun } from "../src/engine";
import { decideInterpretation } from "../src/jev";

afterEach(() => vi.unstubAllGlobals());
const proposal = {
  action: "answer",
  text: "O prazo de entrega é de dois dias.",
  citations: [7],
  interpretation: {
    intent: "consultar prazo",
    summary: "O cliente quer o prazo de entrega do pedido.",
    missing_information: [],
  },
};
const context = {
  request: "Qual o prazo de entrega?",
  sources: [{ id: 7, text: "Prazo: dois dias." }],
};
const route = (choice = "answer", probability = 0.95, confidence = 0.91) => ({
  model: "jev-latest",
  answers: {
    route: {
      type: "choice",
      choice,
      confidence,
      probabilities: { [choice]: probability },
    },
  },
});
async function decisionFixture() {
  const run = { id: uid(), profile_id: uid(), phase: "attendant" } as Run;
  await setSecret(env, `jev:${run.profile_id}`, { key: "test-jev-only" });
  return run;
}
async function serviceFixture(enabled = true) {
  const profile = uid(),
    line = uid(),
    hermes = uid(),
    bot = uid();
  await exec(
    env,
    "INSERT INTO profiles(id,name,settings,enabled,created) VALUES(?,?,?,1,?)",
    profile,
    "JEV",
    JSON.stringify({ ...defaults, attendant_bot: bot, jev_enabled: enabled }),
    now(),
  );
  await exec(
    env,
    "INSERT INTO connections(id,profile_id,name,kind,mode,status,config,created) VALUES(?,?,?,'meta','api','active',?,?)",
    line,
    profile,
    "WhatsApp",
    JSON.stringify({
      number: "5511999999999",
      service: { menu_mode: "manual" },
    }),
    now(),
  );
  await exec(
    env,
    "INSERT INTO connections(id,profile_id,name,kind,mode,status,config,created) VALUES(?,?,?,'hermes','api','active',?,?)",
    hermes,
    profile,
    "Hermes",
    JSON.stringify({ api_url: "https://hermes.example.com" }),
    now(),
  );
  await exec(
    env,
    "INSERT INTO bots(id,profile_id,connection_id,remote_profile,name,enabled) VALUES(?,?,?,'default','Atendente',1)",
    bot,
    profile,
    hermes,
  );
  await setSecret(env, `connection:${hermes}`, {
    profile_keys: { default: "test-hermes-only" },
  });
  await setSecret(env, `jev:${profile}`, { key: "test-jev-only" });
  const received = await inbound(
    env,
    profile,
    {
      external_id: "5511888888888",
      message_id: uid(),
      text: "Qual o prazo de entrega da encomenda?",
    },
    `channel:${line}`,
    line,
  );
  return { profile, line, hermes, bot, conversation: received.conversation_id };
}

describe("interpretação do Atendente antes da decisão JEV", () => {
  it("executa Hermes primeiro e só consulta JEV depois de receber a interpretação", async () => {
    const f = await serviceFixture();
    const calls: { url: string; body: any }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, options: RequestInit) => {
        const body = options.body ? JSON.parse(String(options.body)) : null;
        calls.push({ url: String(url), body });
        if (String(url).includes("typesafe.ai")) return Response.json(route());
        if (options.method === "POST")
          return Response.json({ run_id: "hermes-test" });
        return Response.json({ status: "completed", output: proposal });
      }),
    );
    await processInbox(env, f.profile);
    expect(calls).toHaveLength(0);
    let run = (await one(
      env,
      "SELECT * FROM bot_runs WHERE conversation_id=?",
      f.conversation,
    )) as Run;
    expect(run.status).toBe("queued");
    await exec(
      env,
      "UPDATE bot_runs SET context=? WHERE id=?",
      JSON.stringify(context),
      run.id,
    );
    run = (await one(env, "SELECT * FROM bot_runs WHERE id=?", run.id)) as Run;
    await processRun(env, run);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("hermes.example.com/v1/runs");
    expect(calls[0].body.instructions).toContain('"interpretation"');
    run = (await one(env, "SELECT * FROM bot_runs WHERE id=?", run.id)) as Run;
    await processRun(env, run);
    expect(calls.map((call) => new URL(call.url).hostname)).toEqual([
      "hermes.example.com",
      "hermes.example.com",
      "api.typesafe.ai",
    ]);
    expect(calls[2].body.state.interpretation.summary).toBe(
      proposal.interpretation.summary,
    );
    const outgoing = await one(
      env,
      "SELECT * FROM outbox WHERE dedupe=?",
      `run:${run.id}`,
    );
    expect(json(outgoing.payload).text).toBe(proposal.text);
    expect(
      (
        await one(
          env,
          "SELECT completion_handled FROM bot_runs WHERE id=?",
          run.id,
        )
      ).completion_handled,
    ).toBe(1);
  });

  it("desligado mantém a decisão do Atendente sem chamar JEV", async () => {
    const run = await decisionFixture(),
      fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    expect(
      await decideInterpretation(
        env,
        run,
        proposal,
        context,
        { jev_enabled: false },
        [],
      ),
    ).toEqual(proposal);
    expect(fetcher).not.toHaveBeenCalled();
    expect(
      await one(env, "SELECT * FROM jev_decisions WHERE run_id=?", run.id),
    ).toBeNull();
  });

  it("exige a interpretação antes de decidir e não chama o provedor para saída inválida", async () => {
    const run = await decisionFixture(),
      fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const result = await decideInterpretation(
      env,
      run,
      { ...proposal, interpretation: undefined },
      context,
      { jev_enabled: true },
      [],
    );
    expect(result.action).toBe("human");
    expect(result.jev.reason).toBe("missing_interpretation");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    ["choice inexistente", route("admin"), "invalid_decision"],
    [
      "probabilidade alta mas baixa confiança",
      route("answer", 0.99, 0.2),
      "low_confidence",
    ],
    ["baixa probabilidade", route("answer", 0.6, 0.99), "low_confidence"],
    [
      "probabilidade ausente",
      {
        answers: { route: { type: "choice", choice: "answer", confidence: 1 } },
      },
      "invalid_decision",
    ],
  ])("encaminha para humano diante de %s", async (_label, response, reason) => {
    const run = await decisionFixture();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(response)),
    );
    const result = await decideInterpretation(
      env,
      run,
      proposal,
      context,
      { jev_enabled: true },
      [],
    );
    expect(result.action).toBe("human");
    expect(result.jev.reason).toBe(reason);
  });

  it("guarda a decisão e não repete uma chamada cobrável ao retomar a conclusão", async () => {
    const run = await decisionFixture(),
      fetcher = vi.fn(async () => Response.json(route()));
    vi.stubGlobal("fetch", fetcher);
    const first = await decideInterpretation(
      env,
      run,
      proposal,
      context,
      { jev_enabled: true },
      [],
    );
    const again = await decideInterpretation(
      env,
      run,
      proposal,
      context,
      { jev_enabled: true },
      [],
    );
    expect(again).toEqual(first);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(
      (
        await decideInterpretation(
          env,
          run,
          { ...proposal, text: "alterada" },
          context,
          { jev_enabled: true },
          [],
        )
      ).jev.reason,
    ).toBe("interpretation_changed");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("falha HTTP ou timeout nunca libera a resposta e não causa retry automático", async () => {
    for (const failure of [
      async () => new Response("falha", { status: 429 }),
      async () => {
        throw new Error("timeout");
      },
    ]) {
      const run = await decisionFixture(),
        fetcher = vi.fn(failure);
      vi.stubGlobal("fetch", fetcher);
      const first = await decideInterpretation(
        env,
        run,
        proposal,
        context,
        { jev_enabled: true },
        [],
      );
      const again = await decideInterpretation(
        env,
        run,
        proposal,
        context,
        { jev_enabled: true },
        [],
      );
      expect(first.action).toBe("human");
      expect(again.action).toBe("human");
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it("não oferece ação de especialista não autorizada ao JEV", async () => {
    const run = await decisionFixture();
    const fetcher = vi.fn(async (_url: string, options: RequestInit) => {
      expect(
        JSON.parse(String(options.body)).questions.route.criteria.consult,
      ).toBeUndefined();
      return Response.json(route("consult"));
    });
    vi.stubGlobal("fetch", fetcher);
    const result = await decideInterpretation(
      env,
      run,
      { ...proposal, action: "consult", capability_id: "outro-perfil" },
      context,
      { jev_enabled: true, capabilities: [] },
      [],
    );
    expect(result.action).toBe("human");
  });

  it("permite ao JEV pedir esclarecimento sem entregar a resposta ainda não aprovada", async () => {
    const run = await decisionFixture();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, options: RequestInit) => {
        expect(
          JSON.parse(String(options.body)).state.proposed_clarification,
        ).toBe("Qual é o seu pedido?");
        return Response.json(route("clarify"));
      }),
    );
    const result = await decideInterpretation(
      env,
      run,
      { ...proposal, clarification: "Qual é o seu pedido?" },
      context,
      { jev_enabled: true },
      [],
    );
    expect(result.action).toBe("clarify");
    expect(result.text).toBe("Qual é o seu pedido?");
    expect(result.citations).toEqual([]);
  });

  it("inclui primeiro o resultado citado do especialista mesmo depois de muitos trechos e imagens", async () => {
    const run = { ...(await decisionFixture()), phase: "answer" } as Run;
    const sources = [
      ...Array.from({ length: 12 }, (_, id) => ({ id, text: `Trecho ${id}` })),
      { id: 999999, text: "Resultado financeiro do especialista" },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, options: RequestInit) => {
        const state = JSON.parse(String(options.body)).state;
        expect(state.sources[0]).toEqual({
          id: 999999,
          text: "Resultado financeiro do especialista",
        });
        expect(state.sources).toHaveLength(10);
        expect(state.citations).toEqual([999999]);
        return Response.json(route());
      }),
    );
    const result = await decideInterpretation(
      env,
      run,
      { ...proposal, citations: [999999] },
      { ...context, sources },
      { jev_enabled: true },
      [],
    );
    expect(result.action).toBe("answer");
  });

  it("invalida a decisão se uma pessoa assume enquanto JEV responde", async () => {
    const f = await serviceFixture();
    await processInbox(env, f.profile);
    const run = (await one(
      env,
      "SELECT * FROM bot_runs WHERE conversation_id=?",
      f.conversation,
    )) as Run;
    await exec(
      env,
      "UPDATE bot_runs SET status='completed',result=?,context=? WHERE id=?",
      JSON.stringify(proposal),
      JSON.stringify(context),
      run.id,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        await exec(
          env,
          "UPDATE conversations SET state='human',owner='person',epoch=epoch+1 WHERE id=?",
          f.conversation,
        );
        return Response.json(route());
      }),
    );
    await processRun(
      env,
      (await one(env, "SELECT * FROM bot_runs WHERE id=?", run.id)) as Run,
    );
    expect(
      await one(env, "SELECT * FROM outbox WHERE dedupe=?", `run:${run.id}`),
    ).toBeNull();
    expect(
      (
        await one(
          env,
          "SELECT state FROM conversations WHERE id=?",
          f.conversation,
        )
      ).state,
    ).toBe("human");
  });
});
