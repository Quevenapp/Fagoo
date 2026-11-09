import React, { useEffect, useRef, useState } from "react";
import { NumberPolicyEditor } from "./NumberPolicyEditor";
import { numberPolicyPresets } from "../src/number-policy";

const routerSteps = [
  {
    id: "account",
    title: "Conta Meta",
    description: "Conecte a conta da sua empresa.",
  },
  {
    id: "numbers",
    title: "Números",
    description: "Importe as linhas e acompanhe o uso.",
  },
  {
    id: "distribution",
    title: "Distribuição",
    description: "Escolha as linhas que trabalham juntas.",
  },
  {
    id: "access",
    title: "Acesso dos sistemas",
    description: "Autorize Vinki, Fagoo e outros sistemas.",
  },
] as const;
type RouterStep = (typeof routerSteps)[number]["id"];
type Row = Record<string, any>;
const parse = (v: any) => {
  try {
    return typeof v === "string" ? JSON.parse(v) : v || [];
  } catch {
    return [];
  }
};
const empty = {
  accounts: [],
  numbers: [],
  pools: [],
  applications: [],
  grants: [],
};
const sample = {
  accounts: [
    {
      id: "conta-exemplo",
      name: "Minha empresa",
      waba_id: "123456789000000",
      timezone: "America/Sao_Paulo",
      discovered: "[]",
    },
  ],
  numbers: [
    {
      id: "numero-atendimento-1",
      account_id: "conta-exemplo",
      name: "Atendimento oficial",
      policy: numberPolicyPresets.official,
      number: "5511999990001",
      status: "active",
      usage: {
        period: "2026-11",
        limit: 1000,
        used: 842,
        remaining: 158,
        reserved: 2,
        delivered: 852,
        service_delivered: 840,
        template_delivered: 12,
        free_confirmed: 840,
        billable_confirmed: 12,
        baseline: 0,
        pricing_unknown: 0,
      },
    },
    {
      id: "numero-atendimento-2",
      account_id: "conta-exemplo",
      name: "Vinki · Janela de 24 horas",
      policy: numberPolicyPresets.service_only,
      number: "5511999990002",
      status: "active",
      usage: {
        period: "2026-11",
        limit: 1000,
        used: 635,
        remaining: 365,
        reserved: 3,
        delivered: 632,
        service_delivered: 632,
        template_delivered: 0,
        free_confirmed: 632,
        billable_confirmed: 0,
        baseline: 0,
        pricing_unknown: 0,
      },
    },
  ],
  pools: [
    {
      id: "grupo-atendimento",
      account_id: "conta-exemplo",
      name: "Atendimento principal",
      strategy: "round_robin",
      enabled: 1,
      allow_paid: 1,
      members: ["numero-atendimento-1", "numero-atendimento-2"],
      public_token: "exemplo-dados-ficticios",
    },
  ],
  applications: [
    {
      id: "sistema-exemplo",
      name: "Sistema de pedidos",
      scopes: '["routing:read","routing:send","routing:paid"]',
    },
  ],
  grants: [],
};
export function NumberRouter({
  api,
  root,
  demo,
}: {
  api: any;
  root: string;
  demo: boolean;
}) {
  const [data, setData] = useState<Row>(demo ? sample : empty),
    [step, setStep] = useState<RouterStep>("account"),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(""),
    [accountEditing, setAccountEditing] = useState(false),
    [accountId, setAccountId] = useState(demo ? "conta-exemplo" : ""),
    [accountForm, setAccountForm] = useState<Row>({
      name: "",
      waba_id: "",
      timezone: "America/Sao_Paulo",
    }),
    [numberForm, setNumberForm] = useState<Row>({
      phone_id: "",
      baseline_used: 0,
      service_limit: 1000,
      baseline_confirmed: false,
    }),
    [poolForm, setPoolForm] = useState<Row>({
      name: "",
      strategy: "round_robin",
      members: [],
      enabled: false,
      allow_paid: false,
      public_enabled: false,
    }),
    [appId, setAppId] = useState(""),
    [grants, setGrants] = useState<Row>({
      numbers: [],
      pools: [],
      allow_paid: false,
    }),
    [limits, setLimits] = useState<Row>({});
  const intents = useRef(new Map<string, string>());
  async function load() {
    if (demo) return;
    const r = await api(root + "/router");
    setData(r);
    setAccountId((v) => v || r.accounts?.[0]?.id || "");
  }
  useEffect(() => {
    if (!busy) load().catch((e) => setError(e.message));
    const timer = setInterval(() => {
      if (!document.hidden && !busy) load().catch(() => {});
    }, 15000);
    return () => clearInterval(timer);
  }, [root, demo, busy]);
  const account = data.accounts.find((a: Row) => a.id === accountId),
    available = parse(account?.discovered),
    numbers = data.numbers.filter((n: Row) => n.account_id === accountId);
  async function write(
    path: string,
    body: Row,
    label: string,
    method = "POST",
  ) {
    if (demo) {
      setNotice(
        "Demonstração com dados fictícios. Nenhuma alteração ou mensagem é enviada.",
      );
      return;
    }
    setBusy(label);
    setError("");
    setNotice("");
    const intent = path + JSON.stringify(body);
    if (!intents.current.has(intent))
      intents.current.set(intent, crypto.randomUUID());
    try {
      const result = await api(
        root + "/" + path,
        method,
        body,
        undefined,
        intents.current.get(intent),
      );
      intents.current.delete(intent);
      await load();
      setNotice(label + " concluído.");
      return result;
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy("");
    }
  }
  function editAccount(a?: Row) {
    setAccountEditing(true);
    setAccountForm(
      a
        ? { id: a.id, name: a.name, waba_id: a.waba_id, timezone: a.timezone }
        : { name: "", waba_id: "", timezone: "America/Sao_Paulo" },
    );
  }
  function chooseAccount(id: string) {
    setAccountId(id);
    editAccount(data.accounts.find((a: Row) => a.id === id));
    setAccountEditing(false);
    setPoolForm({
      name: "",
      strategy: "round_robin",
      members: [],
      enabled: false,
      allow_paid: false,
      public_enabled: false,
    });
    setNumberForm({
      phone_id: "",
      baseline_used: 0,
      service_limit: 1000,
      baseline_confirmed: false,
    });
  }
  function selectApp(id: string) {
    setAppId(id);
    const rows = data.grants.filter((r: Row) => r.app_id === id);
    setGrants({
      numbers: rows
        .filter((r: Row) => r.source_type === "number")
        .map((r: Row) => r.source_id),
      pools: rows
        .filter((r: Row) => r.source_type === "pool")
        .map((r: Row) => r.source_id),
      allow_paid: rows.some((r: Row) => r.allow_paid),
    });
  }
  function toggle(field: string, id: string) {
    setGrants((g: Row) => ({
      ...g,
      [field]: g[field].includes(id)
        ? g[field].filter((x: string) => x !== id)
        : [...g[field], id],
    }));
  }
  const exampleSource = data.pools[0]
    ? { pool_id: data.pools[0].id }
    : { number_id: data.numbers[0]?.id || "ID_DO_NUMERO" };
  return (
    <div className="number-router">
      <section className="card">
        <div className="section-heading">
          <h2>WhatsApp da sua empresa</h2>
          <button
            disabled={!!busy}
            onClick={() => load().catch((e) => setError(e.message))}
          >
            Atualizar dados
          </button>
        </div>
        <p>
          Conecte sua conta Meta, escolha os números e defina como distribuir
          novos atendimentos. Cada área abaixo cuida de uma parte da
          configuração.
        </p>
        {step === "account" && (
          <p>
            <a href="/install#meta-whatsapp" target="_blank" rel="noreferrer">
              Ainda não configurou a Meta? Siga o passo a passo ↗
            </a>
          </p>
        )}
        <nav
          className="router-step-nav"
          aria-label="Configuração dos números WhatsApp"
        >
          {routerSteps.map((item, index) => (
            <button
              key={item.id}
              type="button"
              aria-pressed={step === item.id}
              aria-controls="router-step-content"
              disabled={!!busy}
              onClick={() => setStep(item.id)}
            >
              <span className="router-step-number">{index + 1}</span>
              <span>
                <strong>{item.title}</strong>
                <small>{item.description}</small>
              </span>
            </button>
          ))}
        </nav>
        {demo && (
          <p className="notice">
            Tela de referência · todos os números e contadores abaixo são
            fictícios.
          </p>
        )}
        {busy && <p role="status">{busy}… Aguarde a confirmação.</p>}
        {error && (
          <p role="alert" className="notice error">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="notice">
            {notice}
          </p>
        )}
        {step !== "access" && data.accounts.length > 0 && (
          <label>
            Conta que você está configurando
            <select
              value={accountId}
              disabled={!!busy}
              onChange={(e) => chooseAccount(e.target.value)}
            >
              <option value="">Selecione uma conta</option>
              {data.accounts.map((a: Row) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </section>
      <div id="router-step-content" className="router-step-content">
        {step === "account" && (
          <section className="card">
            <h3>
              {accountEditing
                ? accountForm.id
                  ? "Editar conta Meta"
                  : "Cadastrar conta Meta"
                : account
                  ? account.name
                  : "Conectar conta Meta"}
            </h3>
            <p>
              A conta empresarial do WhatsApp é identificada pelo WABA ID. Use
              um token com acesso a essa conta e aos seus números. App Secret é
              o segredo do aplicativo Meta. Verify Token é uma chave escolhida
              por você para confirmar o webhook. As credenciais ficam protegidas
              no backend.
            </p>
            <div className="router-actions">
              <button disabled={!!busy} onClick={() => editAccount()}>
                Nova conta
              </button>
              {account && (
                <button disabled={!!busy} onClick={() => editAccount(account)}>
                  Editar {account.name}
                </button>
              )}
            </div>
            {(accountEditing || !data.accounts.length) && (
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  const r = await write(
                    "router/accounts",
                    {
                      id: accountForm.id,
                      name: accountForm.name,
                      waba_id: accountForm.waba_id,
                      timezone: accountForm.timezone,
                      secrets: {
                        token: accountForm.token,
                        app_secret: accountForm.app_secret,
                        verify_token: accountForm.verify_token,
                      },
                    },
                    "Salvar conta",
                  );
                  if (r) {
                    setAccountId(r.id);
                    setAccountForm({
                      id: r.id,
                      name: accountForm.name,
                      waba_id: accountForm.waba_id,
                      timezone: accountForm.timezone,
                    });
                    setAccountEditing(false);
                  }
                }}
              >
                <div className="router-fields">
                  <label>
                    Nome da conta
                    <input
                      required
                      maxLength={100}
                      value={accountForm.name}
                      onChange={(e) =>
                        setAccountForm({ ...accountForm, name: e.target.value })
                      }
                    />
                  </label>
                  <label>
                    Identificador da conta WhatsApp (WABA ID)
                    <input
                      required
                      readOnly={!!accountForm.id}
                      value={accountForm.waba_id}
                      onChange={(e) =>
                        setAccountForm({
                          ...accountForm,
                          waba_id: e.target.value,
                        })
                      }
                    />
                  </label>
                  <label>
                    Fuso da conta Meta
                    <input
                      required
                      value={accountForm.timezone}
                      onChange={(e) =>
                        setAccountForm({
                          ...accountForm,
                          timezone: e.target.value,
                        })
                      }
                    />
                  </label>
                  {[
                    ["token", "Token Meta"],
                    ["app_secret", "App Secret"],
                    ["verify_token", "Verify Token do webhook"],
                  ].map(([field, label]) => (
                    <label key={field}>
                      {label}
                      <input
                        type="password"
                        autoComplete="new-password"
                        required={!accountForm.id}
                        value={accountForm[field] || ""}
                        placeholder={
                          accountForm.id ? "Vazio mantém o valor atual" : ""
                        }
                        onChange={(e) =>
                          setAccountForm({
                            ...accountForm,
                            [field]: e.target.value,
                          })
                        }
                      />
                    </label>
                  ))}
                </div>
                <button disabled={!!busy} type="submit">
                  Salvar conta Meta
                </button>
                {data.accounts.length > 0 && (
                  <button
                    type="button"
                    disabled={!!busy}
                    onClick={() => {
                      setAccountEditing(false);
                      setAccountForm({
                        name: "",
                        waba_id: "",
                        timezone: "America/Sao_Paulo",
                      });
                    }}
                  >
                    Cancelar edição
                  </button>
                )}
              </form>
            )}
            {account && (
              <>
                <h3>Webhook único desta conta</h3>
                <p>
                  Cadastre esta URL no aplicativo Meta, com o Verify Token
                  cadastrado para esta conta. Assine <code>messages</code>. A
                  WABA precisa estar inscrita no mesmo aplicativo. Se usa
                  ligações ou grupos, mantenha também os eventos desses
                  recursos.
                </p>
                <CopyValue
                  value={
                    location.origin + "/webhooks/meta-accounts/" + account.id
                  }
                />
                <div className="router-actions">
                  <button
                    type="button"
                    disabled={!!busy}
                    onClick={() => setStep("numbers")}
                  >
                    Continuar para os números →
                  </button>
                </div>
              </>
            )}
          </section>
        )}
        {!account && ["numbers", "distribution"].includes(step) && (
          <section className="card router-step-empty">
            <h3>Comece pela conta Meta</h3>
            <p>
              Conecte ou selecione uma conta para buscar seus números e
              organizar a distribuição.
            </p>
            <button type="button" onClick={() => setStep("account")}>
              Configurar conta Meta
            </button>
          </section>
        )}
        {step === "numbers" && account && (
          <section className="card">
            <h3>Trazer números da Meta</h3>
            <p>
              Os números precisam estar cadastrados e habilitados na Meta.
              Buscar números apenas consulta sua conta; não cria nem ativa
              telefones.
            </p>
            <button
              disabled={!!busy}
              onClick={() =>
                write(
                  `router/accounts/${accountId}/discover`,
                  {},
                  "Buscar números",
                )
              }
            >
              Buscar números na Meta
            </button>
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                const r = await write(
                  "router/numbers",
                  {
                    ...numberForm,
                    account_id: accountId,
                    baseline_used: Number(numberForm.baseline_used),
                    service_limit: Number(numberForm.service_limit),
                  },
                  "Adicionar número",
                );
                if (r)
                  setNumberForm({
                    phone_id: "",
                    baseline_used: 0,
                    service_limit: 1000,
                    baseline_confirmed: false,
                  });
              }}
            >
              <div className="router-fields">
                <label>
                  Número encontrado
                  <select
                    required
                    value={numberForm.phone_id}
                    onChange={(e) =>
                      setNumberForm({ ...numberForm, phone_id: e.target.value })
                    }
                  >
                    <option value="">Escolha após buscar</option>
                    {available
                      .filter(
                        (n: Row) =>
                          !data.numbers.some(
                            (r: Row) => r.phone_id === n.phone_id,
                          ),
                      )
                      .map((n: Row) => (
                        <option value={n.phone_id} key={n.phone_id}>
                          +{n.number} · {n.name || n.phone_id} · qualidade{" "}
                          {n.quality}
                        </option>
                      ))}
                  </select>
                </label>
                <label>
                  Nome para reconhecer no painel
                  <input
                    value={numberForm.name || ""}
                    maxLength={100}
                    onChange={(e) =>
                      setNumberForm({ ...numberForm, name: e.target.value })
                    }
                  />
                </label>
                <label>
                  Mensagens de atendimento já usadas neste mês
                  <input
                    required
                    type="number"
                    min="0"
                    max="100000000"
                    value={numberForm.baseline_used}
                    onChange={(e) =>
                      setNumberForm({
                        ...numberForm,
                        baseline_used: e.target.value,
                      })
                    }
                  />
                </label>
                <label>
                  Franquia gratuita mensal (até 1.000)
                  <input
                    required
                    type="number"
                    min="0"
                    max="1000"
                    value={numberForm.service_limit}
                    onChange={(e) =>
                      setNumberForm({
                        ...numberForm,
                        service_limit: e.target.value,
                      })
                    }
                  />
                </label>
              </div>
              <label className="check-line">
                <input
                  type="checkbox"
                  required
                  checked={numberForm.baseline_confirmed}
                  onChange={(e) =>
                    setNumberForm({
                      ...numberForm,
                      baseline_confirmed: e.target.checked,
                    })
                  }
                />
                Conferi na Meta o uso deste mês e o fuso {account.timezone}. O
                valor inicial não inclui mensagens futuras.
              </label>
              <p>
                O número será adicionado pausado. Se ele já está no Wabotia,
                pause e reconcilie as entregas antes. Depois confira o webhook e
                clique em Ativar na lista.
              </p>
              <button type="submit" disabled={!!busy}>
                Adicionar número ao Wabotia
              </button>
            </form>
          </section>
        )}
        {step === "numbers" && account && (
          <section className="card">
            <h3>Seus números e consumo</h3>
            <p>
              Uso protegido = histórico inicial + entregas de atendimento +
              reservas. Reservas sem confirmação não são liberadas
              automaticamente. A mudança de mês segue o fuso da conta Meta.
            </p>
            {!numbers.length && (
              <p>
                Nenhum número cadastrado nesta conta. Use Buscar números na Meta
                acima e escolha os que deseja trazer para o Wabotia.
              </p>
            )}
            <div className="router-number-grid">
              {numbers.map((n: Row) => (
                <article className="router-number" key={n.id}>
                  <div className="section-heading">
                    <strong>{n.name}</strong>
                    <span
                      className={
                        "badge " + (n.status === "active" ? "active" : "paused")
                      }
                    >
                      {n.status === "active" ? "Ativo" : "Pausado"}
                    </span>
                  </div>
                  <p>+{n.number}</p>
                  <strong className="router-count">
                    {n.usage.used} / {n.usage.limit}
                  </strong>
                  <span> usados ou reservados · {n.usage.period}</span>
                  <progress
                    aria-label={"Uso de " + n.name}
                    value={Math.min(n.usage.used, n.usage.limit)}
                    max={n.usage.limit || 1}
                  />
                  <dl>
                    <div>
                      <dt>Franquia gratuita restante</dt>
                      <dd>{n.usage.remaining}</dd>
                    </div>
                    <div>
                      <dt>Reservadas</dt>
                      <dd>{n.usage.reserved}</dd>
                    </div>
                    <div>
                      <dt>Serviço grátis confirmado pela Meta</dt>
                      <dd>{n.usage.free_confirmed}</dd>
                    </div>
                    <div>
                      <dt>Templates entregues</dt>
                      <dd>{n.usage.template_delivered ?? 0}</dd>
                    </div>
                    <div>
                      <dt>Serviço além da franquia (estimado)</dt>
                      <dd>
                        {n.usage.paid_service_estimated ??
                          Math.max(0, n.usage.used - n.usage.limit)}
                      </dd>
                    </div>
                    <div>
                      <dt>Pagas confirmadas (todas as categorias)</dt>
                      <dd>{n.usage.billable_confirmed}</dd>
                    </div>
                    <div>
                      <dt>Cobrança não informada</dt>
                      <dd>{n.usage.pricing_unknown}</dd>
                    </div>
                    <div>
                      <dt>Uso anterior informado</dt>
                      <dd>{n.usage.baseline}</dd>
                    </div>
                  </dl>
                  <div className="router-actions">
                    <button
                      disabled={!!busy}
                      onClick={() =>
                        write(
                          `connections/${n.id}/state`,
                          {
                            status: n.status === "active" ? "paused" : "active",
                          },
                          n.status === "active"
                            ? "Pausar número"
                            : "Ativar número",
                          "PUT",
                        )
                      }
                    >
                      {n.status === "active" ? "Pausar" : "Ativar"}
                    </button>
                    <label>
                      Franquia
                      <input
                        aria-label={"Franquia de " + n.name}
                        type="number"
                        min="0"
                        max="1000"
                        value={limits[n.id] ?? n.usage.limit}
                        onChange={(e) =>
                          setLimits({ ...limits, [n.id]: e.target.value })
                        }
                      />
                    </label>
                    <button
                      disabled={!!busy}
                      onClick={() =>
                        write(
                          `router/numbers/${n.id}/limit`,
                          {
                            service_limit: Number(
                              limits[n.id] ?? n.usage.limit,
                            ),
                          },
                          "Atualizar franquia",
                          "PUT",
                        )
                      }
                    >
                      Salvar franquia
                    </button>
                  </div>
                  <p className="number-policy-note">
                    {n.policy?.service_overage === false
                      ? "Somente franquia gratuita: ao atingir o contador, novas mensagens de serviço são bloqueadas. O remetente da conversa é mantido."
                      : "Ao terminar a franquia, as conversas continuam neste número com possível cobrança de serviço."}
                  </p>
                  <details className="router-technical-details">
                    <summary>Identificador para integração</summary>
                    <CopyValue value={n.id} />
                  </details>
                  <NumberPolicyEditor
                    policy={n.policy}
                    name={n.name}
                    busy={!!busy}
                    onSave={(policy) =>
                      write(
                        `router/numbers/${n.id}/policy`,
                        { policy },
                        "Salvar função e permissões",
                        "PUT",
                      )
                    }
                  />
                </article>
              ))}
            </div>
          </section>
        )}
        {step === "distribution" && account && (
          <section className="card">
            <h3>Distribuir novos atendimentos</h3>
            <div className="notice">
              <strong>Vinki e janela de 24 horas:</strong> a janela é aberta
              pelo cliente e pertence ao número que recebeu a mensagem. O
              rodízio prioriza a franquia gratuita estimada; a conversa mantém o
              mesmo número. Nas permissões da linha, selecione{" "}
              <strong>Somente franquia gratuita</strong> para bloquear excedente
              de serviço. Linhas sem saldo e com essa opção ligada saem da
              seleção de novos atendimentos. O contador local não garante uma
              fatura sem cobrança.
            </div>
            <p>
              Um grupo pertence a uma conta Meta. A escolha ocorre no início do
              atendimento e fica vinculada a ele. Grupos podem compartilhar
              números; o consumo do número continua único. Apenas números que
              permitem participar do roteamento são escolhidos. Permitir
              templates no grupo não libera templates em um número que os
              bloqueia.
            </p>
            {!numbers.length && (
              <p className="notice">
                Adicione números na área Números antes de criar um grupo.
              </p>
            )}
            {!data.pools.some((p: Row) => p.account_id === accountId) && (
              <p>
                Nenhum grupo nesta conta. Crie um grupo abaixo para alternar os
                números a cada novo atendimento.
              </p>
            )}
            {data.pools
              .filter((p: Row) => p.account_id === accountId)
              .map((p: Row) => (
                <div className="router-pool" key={p.id}>
                  <strong>{p.name}</strong>
                  <span>
                    {p.members.length} números ·{" "}
                    {p.enabled ? "Ativo" : "Pausado"} ·{" "}
                    {p.allow_paid
                      ? "Modelos pagos permitidos com autorização"
                      : "Somente atendimento"}
                  </span>
                  <button
                    disabled={!!busy}
                    onClick={() =>
                      setPoolForm({
                        ...p,
                        public_enabled: !!p.public_token,
                        enabled: !!p.enabled,
                        allow_paid: !!p.allow_paid,
                      })
                    }
                  >
                    Editar grupo
                  </button>
                  <details className="router-technical-details">
                    <summary>Identificador para integração</summary>
                    <CopyValue value={p.id} />
                  </details>
                  {p.public_token && (
                    <>
                      <small>
                        Link para o cliente iniciar contato num número
                        disponível
                      </small>
                      <CopyValue
                        value={
                          location.origin +
                          "/api/public/whatsapp/" +
                          p.public_token
                        }
                      />
                    </>
                  )}
                </div>
              ))}
            <details
              open={
                !!poolForm.id ||
                !data.pools.some((p: Row) => p.account_id === accountId)
              }
            >
              <summary>
                {poolForm.id
                  ? "Editar grupo selecionado"
                  : "Criar grupo de roteamento"}
              </summary>
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  const r = await write(
                    "router/pools",
                    { ...poolForm, account_id: accountId },
                    "Salvar grupo",
                  );
                  if (r)
                    setPoolForm({
                      name: "",
                      strategy: "round_robin",
                      members: [],
                      enabled: false,
                      allow_paid: false,
                      public_enabled: false,
                    });
                }}
              >
                <div className="router-fields">
                  <label>
                    Nome do grupo
                    <input
                      required
                      maxLength={100}
                      value={poolForm.name}
                      onChange={(e) =>
                        setPoolForm({ ...poolForm, name: e.target.value })
                      }
                    />
                  </label>
                  <label>
                    Distribuição dos novos atendimentos
                    <select value="round_robin" disabled>
                      <option value="round_robin">
                        Rodízio com prioridade à franquia gratuita
                      </option>
                    </select>
                  </label>
                </div>
                <div className="router-checks">
                  {numbers.map((n: Row) => (
                    <label className="check-line" key={n.id}>
                      <input
                        type="checkbox"
                        checked={poolForm.members.includes(n.id)}
                        onChange={(e) =>
                          setPoolForm({
                            ...poolForm,
                            members: e.target.checked
                              ? [...poolForm.members, n.id]
                              : poolForm.members.filter(
                                  (id: string) => id !== n.id,
                                ),
                          })
                        }
                      />
                      {n.name} · +{n.number}
                    </label>
                  ))}
                </div>
                {[
                  ["enabled", "Ativar este grupo"],
                  [
                    "public_enabled",
                    "Criar link público de entrada pelo WhatsApp",
                  ],
                  [
                    "allow_paid",
                    "Permitir modelos pagos, somente com autorização explícita em cada envio",
                  ],
                ].map(([field, label]) => (
                  <label className="check-line" key={field}>
                    <input
                      type="checkbox"
                      checked={!!poolForm[field]}
                      onChange={(e) =>
                        setPoolForm({ ...poolForm, [field]: e.target.checked })
                      }
                    />
                    {label}
                  </label>
                ))}
                <button disabled={!!busy || !numbers.length} type="submit">
                  Salvar grupo
                </button>
                {poolForm.id && (
                  <button
                    type="button"
                    onClick={() =>
                      setPoolForm({
                        name: "",
                        strategy: "round_robin",
                        members: [],
                        enabled: false,
                        allow_paid: false,
                        public_enabled: false,
                      })
                    }
                  >
                    Cancelar edição
                  </button>
                )}
              </form>
            </details>
          </section>
        )}
        {step === "access" && (
          <>
            <section className="card">
              <h3>Quais números cada sistema pode usar</h3>
              <p>
                Cadastre Vinki, Fagoo ou outro sistema em{" "}
                <strong>Integrações</strong>, com acesso a este perfil. Depois
                escolha aqui os números ou grupos que ele poderá usar. O
                pareamento por código temporário fica em Integrações; a
                autorização de linhas continua limitada pelas permissões abaixo.
              </p>
              <p className="muted">
                As permissões abaixo abrangem todas as contas Meta deste perfil.
              </p>
              {!data.applications.length && (
                <p className="notice">
                  Nenhum sistema cadastrado. Abra Integrações para cadastrar uma
                  aplicação primeiro.
                </p>
              )}
              <label>
                Sistema
                <select
                  disabled={!!busy}
                  value={appId}
                  onChange={(e) => selectApp(e.target.value)}
                >
                  <option value="">Selecione</option>
                  {data.applications.map((a: Row) => (
                    <option value={a.id} key={a.id}>
                      {a.name}
                      {a.disabled ? " · desativada" : ""}
                    </option>
                  ))}
                </select>
              </label>
              {appId && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    write(
                      "router/grants",
                      { app_id: appId, ...grants, enable_scopes: true },
                      "Salvar permissões",
                      "PUT",
                    );
                  }}
                >
                  <h4>Número escolhido diretamente</h4>
                  {data.numbers.map((n: Row) => (
                    <label key={n.id} className="check-line">
                      <input
                        type="checkbox"
                        checked={grants.numbers.includes(n.id)}
                        onChange={() => toggle("numbers", n.id)}
                      />
                      {n.name} · +{n.number}
                    </label>
                  ))}
                  <h4>Grupos autorizados</h4>
                  {data.pools.map((p: Row) => (
                    <label key={p.id} className="check-line">
                      <input
                        type="checkbox"
                        checked={grants.pools.includes(p.id)}
                        onChange={() => toggle("pools", p.id)}
                      />
                      {p.name}
                    </label>
                  ))}
                  <label className="check-line">
                    <input
                      type="checkbox"
                      checked={grants.allow_paid}
                      onChange={(e) =>
                        setGrants({ ...grants, allow_paid: e.target.checked })
                      }
                    />
                    Permitir modelos pagos nestas origens. Cada pedido ainda
                    exige allow_paid: true e consentimento.
                  </label>
                  <p>
                    Salvar também autoriza a aplicação a consultar o roteador e
                    operar conversas deste perfil. Autorizar um grupo permite
                    seus membros atuais e futuros; a escolha direta de um número
                    exige a autorização individual.
                  </p>
                  <button disabled={!!busy} type="submit">
                    Salvar acesso do sistema
                  </button>
                </form>
              )}
            </section>
            <section className="card">
              <details>
                <summary>
                  Para quem desenvolve a integração: enviar pela API
                </summary>
                <p>
                  Use a chave Bearer no servidor do programa integrador e uma{" "}
                  <code>Idempotency-Key</code> por pedido. Escolha{" "}
                  <code>number_id</code> ou <code>pool_id</code>. O retorno 202
                  confirma a fila; acompanhe a entrega na conversa e nos
                  webhooks.
                </p>
                <CopyValue
                  value={location.origin + "/api/" + root + "/router/messages"}
                />
                <h4>
                  Atendimento: exige mensagem recente do cliente neste número
                </h4>
                <pre>
                  {JSON.stringify(
                    {
                      ...exampleSource,
                      to: "5511999991111",
                      external_id: "pedido-123",
                      text: "Olá! Como podemos ajudar?",
                    },
                    null,
                    2,
                  )}
                </pre>
                <h4>Modelo pago: autorização e consentimento por envio</h4>
                <pre>
                  {JSON.stringify(
                    {
                      ...exampleSource,
                      to: "5511999991111",
                      external_id: "pedido-456",
                      allow_paid: true,
                      consent: {
                        granted: true,
                        category: "utility",
                        reference: "Comprovante do aceite no pedido 456",
                      },
                      template: {
                        name: "seu_modelo_aprovado",
                        language: "pt_BR",
                        components: [
                          {
                            type: "body",
                            parameters: [{ type: "text", text: "456" }],
                          },
                        ],
                      },
                    },
                    null,
                    2,
                  )}
                </pre>
                <p>
                  Não altere o identificador externo durante o atendimento para
                  forçar troca de remetente. Um resultado sem confirmação exige
                  reconciliação; repetir com outro número pode duplicar a
                  mensagem.
                </p>
                <a href="/api-docs">Abrir documentação da API</a>
              </details>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
function CopyValue({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="router-copy">
      <code>{value}</code>
      <button
        type="button"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
          } catch {
            setCopied(false);
          }
        }}
      >
        {copied ? "Copiado" : "Copiar"}
      </button>
    </div>
  );
}
