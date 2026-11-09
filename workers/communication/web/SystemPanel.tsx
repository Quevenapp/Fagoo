import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Bell,
  Check,
  Cloud,
  Download,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  X,
} from "lucide-react";

type Api = (
  path: string,
  method?: string,
  body?: any,
  signal?: AbortSignal,
) => Promise<any>;
type Data = { updates: any; cloudflare: any; deployments: any[] };
const demoData: Data = {
  updates: {
    installed: { version: "0.10.0", commit: "exemplo" },
    method: "direct",
    installation_ready: true,
    configured: true,
    available: false,
  },
  cloudflare: { configured: false, account_id: "", zone_id: "", domain: "" },
  deployments: [],
};
type PushMode = "off" | "gateway" | "fcm";
type PushPreview = "preview" | "minimal";
type PushConfig = {
  mode: PushMode;
  gateway_url: string;
  gateway_secret_configured?: boolean;
  fcm_configured: boolean;
  fcm_project_id: string;
  preview: PushPreview;
  ticket_alert_minutes: number;
};
type PushForm = {
  mode: PushMode;
  gateway_url: string;
  gateway_secret: string;
  fcm_service_account: string;
  preview: PushPreview;
  ticket_alert_minutes: string;
};
const DEFAULT_GATEWAY = "https://push.wabotia.queven.app";
const demoPush: PushConfig = {
  mode: "gateway",
  gateway_url: DEFAULT_GATEWAY,
  gateway_secret_configured: false,
  fcm_configured: false,
  fcm_project_id: "",
  preview: "minimal",
  ticket_alert_minutes: 60,
};
const isPushMode = (v: string): v is PushMode =>
  v === "off" || v === "gateway" || v === "fcm";
const isPushPreview = (v: string): v is PushPreview =>
  v === "preview" || v === "minimal";
function pushForm(config: PushConfig): PushForm {
  return {
    mode: config.mode,
    gateway_url: config.gateway_url || DEFAULT_GATEWAY,
    gateway_secret: "",
    fcm_service_account: "",
    preview: config.preview,
    ticket_alert_minutes: String(config.ticket_alert_minutes ?? 60),
  };
}
const when = (n: number) =>
  new Date(n).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });

function useSystem(api: Api, demo: boolean) {
  const [data, setData] = useState<Data | null>(demo ? demoData : null);
  const [error, setError] = useState("");
  const alive = useRef(true);
  const readBusy = useRef(false);
  const refresh = useCallback(async () => {
    if (demo || readBusy.current) return;
    readBusy.current = true;
    try {
      const result = await api(
        "v1/system",
        "GET",
        undefined,
        AbortSignal.timeout(20000),
      );
      if (alive.current) {
        setData(result);
        setError("");
      }
    } catch (e) {
      if (alive.current)
        setError(
          e instanceof Error
            ? e.message
            : "Não foi possível consultar o sistema.",
        );
    } finally {
      readBusy.current = false;
    }
  }, [api, demo]);
  useEffect(() => {
    alive.current = true;
    void refresh();
    const timer = setInterval(refresh, 5000);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, [refresh]);
  return { data, error, refresh };
}
function useAction(demo: boolean) {
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const lock = useRef(false);
  async function run(label: string, task: () => Promise<void>) {
    if (lock.current) return;
    if (demo) {
      setMessage(
        "Tela de referência. Entre na sua instalação para usar esta opção.",
      );
      return;
    }
    lock.current = true;
    setBusy(label);
    setMessage("");
    setError("");
    try {
      await task();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Não foi possível concluir. Confira o andamento antes de repetir.",
      );
    } finally {
      lock.current = false;
      setBusy("");
    }
  }
  return { busy, message, error, run, setMessage };
}
function Feedback({
  busy,
  message,
  error,
}: {
  busy: string;
  message: string;
  error: string;
}) {
  return (
    <>
      {busy && (
        <p className="connection-progress" role="status">
          <Loader2 className="spin" size={16} /> {busy}
        </p>
      )}
      {message && (
        <p className="connection-result" role="status">
          {message}
        </p>
      )}
      {error && (
        <p className="connection-result error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
function Input({
  label,
  ...props
}: { label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="field">
      <span>{label}</span>
      <input {...props} />
    </label>
  );
}

function AutomaticUpdates({
  api,
  demo,
  updates,
  refresh,
}: {
  api: Api;
  demo: boolean;
  updates: any;
  refresh: () => Promise<void>;
}) {
  const initial = updates.automatic || {
    enabled: false,
    hour: 3,
    window_hours: 2,
  };
  const [form, setForm] = useState({
    enabled: !!initial.enabled,
    hour: Number(initial.hour),
    window_hours: Number(initial.window_hours),
  });
  const dirty = useRef(false);
  const action = useAction(demo);
  useEffect(() => {
    if (!dirty.current)
      setForm({
        enabled: !!initial.enabled,
        hour: Number(initial.hour),
        window_hours: Number(initial.window_hours),
      });
  }, [initial.enabled, initial.hour, initial.window_hours]);
  const update = (patch: Partial<typeof form>) => {
    dirty.current = true;
    setForm((old) => ({ ...old, ...patch }));
  };
  const statuses: Record<string, string> = {
    off: "Desligadas",
    scheduled: "Aguardando a janela diária",
    checking: "Consultando a versão oficial",
    queued: "Atualização agendada",
    running: "Atualização em andamento",
    awaiting_confirmation: "Aguardando confirmação da publicação",
    retry_wait: "Aguardando nova tentativa",
    blocked: "Revisão necessária",
    up_to_date: "Nenhuma versão mais nova disponível",
    release_requires_review: "Versão exige revisão manual",
    check_failed: "Não foi possível consultar a versão",
  };
  return (
    <section className="card system-card">
      <div className="section-heading">
        <h2>
          <RefreshCw size={22} /> Atualizações automáticas
        </h2>
        <span className="badge">
          {initial.enabled ? "Ligadas" : "Desligadas"}
        </span>
      </div>
      <p>
        O Wabotia pode consultar e instalar versões oficiais mais novas durante
        uma janela diária. Usa a autorização Cloudflare já configurada nesta
        instalação.
      </p>
      <form
        className="system-form"
        onSubmit={(event) => {
          event.preventDefault();
          void action.run("Salvando atualização automática…", async () => {
            await api(
              "v1/system/updates/automatic",
              "POST",
              form,
              AbortSignal.timeout(45000),
            );
            dirty.current = false;
            await refresh();
            action.setMessage(
              form.enabled
                ? "Atualização automática ligada para a janela escolhida."
                : "Atualização automática desligada. Trabalhos já iniciados terminam normalmente.",
            );
          });
        }}
      >
        <label className="check-field">
          <input
            type="checkbox"
            checked={form.enabled}
            disabled={!!action.busy || (!updates.configured && !form.enabled)}
            onChange={(e) => update({ enabled: e.target.checked })}
          />
          Instalar novas versões automaticamente
        </label>
        {!updates.configured && (
          <p>
            Primeiro configure a atualização direta no cartão acima. Esta opção
            não utiliza o fluxo antigo de Deploy Hook.
          </p>
        )}
        <div className="system-grid">
          <label className="field">
            <span>Início da janela · horário de Brasília</span>
            <select
              value={form.hour}
              disabled={!!action.busy}
              onChange={(e) => update({ hour: Number(e.target.value) })}
            >
              {Array.from({ length: 24 }, (_, hour) => (
                <option key={hour} value={hour}>
                  {String(hour).padStart(2, "0")}:00
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Duração da janela</span>
            <select
              value={form.window_hours}
              disabled={!!action.busy}
              onChange={(e) => update({ window_hours: Number(e.target.value) })}
            >
              {[1, 2, 3, 4, 5, 6].map((hours) => (
                <option key={hours} value={hours}>
                  {hours} {hours === 1 ? "hora" : "horas"}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p>
          Uma consulta por janela, com até três tentativas se o serviço estiver
          indisponível. Desligar cancela o início de novos trabalhos; uma
          atualização já iniciada continua até sua confirmação. A janela define
          o início, não interrompe uma publicação em andamento.
        </p>
        <button className="button" disabled={!!action.busy || !dirty.current}>
          Salvar atualização automática
        </button>
      </form>
      <Feedback {...action} />
      <dl className="system-facts">
        <div>
          <dt>Estado</dt>
          <dd>
            {statuses[
              initial.status || (initial.enabled ? "scheduled" : "off")
            ] || initial.status}
          </dd>
        </div>
        <div>
          <dt>Última consulta automática</dt>
          <dd>
            {initial.last_checked_at
              ? when(initial.last_checked_at)
              : "Ainda não realizada"}
          </dd>
        </div>
        {initial.attempt && (
          <div>
            <dt>Tentativa de instalação</dt>
            <dd>
              {initial.attempt} de {initial.max_attempts || 3}
            </dd>
          </div>
        )}
        {(initial.retry_at || initial.check_retry_at) && (
          <div>
            <dt>Nova tentativa a partir de</dt>
            <dd>
              {when(initial.retry_at || initial.check_retry_at)} · dentro da
              janela
            </dd>
          </div>
        )}
      </dl>
      {initial.enabled && initial.error && (
        <div className="notice error" role="status">
          {initial.error}
        </div>
      )}
      <p className="muted">
        O pacote é conferido antes de publicar. Migrações incompatíveis e
        publicações sem confirmação precisam de revisão no cartão de
        atualização. Esta opção atualiza o servidor e o painel; os processos
        Hermes e QR são mantidos separadamente.
      </p>
    </section>
  );
}

export function SystemPanel({ api, demo }: { api: Api; demo: boolean }) {
  const system = useSystem(api, demo),
    action = useAction(demo);
  const [updateToken, setUpdateToken] = useState("");
  const [stopped, setStopped] = useState(false);
  const [cf, setCf] = useState({ account_id: "", zone_id: "", token: "" });
  const [editingCf, setEditingCf] = useState(false);
  const [editingHook, setEditingHook] = useState(false);
  const data = system.data;
  if (!data)
    return (
      <Feedback
        busy={system.error ? "" : "Carregando configurações…"}
        message=""
        error={system.error}
      />
    );
  const u = data.updates,
    state = u.state;
  const updating =
    state &&
    ["pending", "sending", "requested", "unknown"].includes(state.status);
  const mutate = (path: string, body: any) =>
    api("v1/system/" + path, "POST", body, AbortSignal.timeout(45000));
  return (
    <div className="system-stack">
      <Feedback {...action} error={action.error || system.error} />
      <section className="card system-card">
        <div className="section-heading">
          <h2>
            <RefreshCw size={22} /> Atualizar Wabotia
          </h2>
          <span className="badge active">v{u.installed.version}</span>
        </div>
        <p>
          Instale as versões oficiais publicadas do Wabotia. A atualização
          direta na Cloudflare mantém seu banco, mídias, domínios e credenciais.
        </p>
        <dl className="system-facts">
          <div>
            <dt>Versão instalada</dt>
            <dd>
              <code>{u.installed.commit.slice(0, 12)}</code>
            </dd>
          </div>
          <div>
            <dt>Última consulta</dt>
            <dd>
              {u.latest ? when(u.latest.checked_at) : "Ainda não consultada"}
            </dd>
          </div>
        </dl>
        {u.latest && (
          <p>
            {u.available
              ? "Atualização disponível"
              : "Você está na versão consultada"}
            :{" "}
            <a
              className="text-link"
              href={u.latest.url}
              target="_blank"
              rel="noreferrer"
            >
              v{u.latest.version} · {u.latest.commit.slice(0, 12)}
            </a>
          </p>
        )}
        <div className="card-actions">
          <button
            className="button secondary"
            disabled={!!action.busy}
            onClick={() =>
              action.run("Consultando versão oficial…", async () => {
                await api("v1/system/updates/check");
                await system.refresh();
                action.setMessage(
                  "Consulta concluída. O resultado é atualizado a cada cinco minutos.",
                );
              })
            }
          >
            <RefreshCw size={16} /> Verificar atualização
          </button>
          {u.available && u.configured && !updating && (
            <button
              className="button"
              disabled={!!action.busy}
              onClick={() =>
                action.run("Solicitando atualização…", async () => {
                  await mutate("updates/start", { commit: u.latest.commit });
                  await system.refresh();
                  action.setMessage(
                    "Pedido registrado. Acompanhe a confirmação abaixo; você pode continuar usando o painel.",
                  );
                })
              }
            >
              Atualizar Wabotia <ArrowRight size={16} />
            </button>
          )}
        </div>
        {updating && (
          <div className="callout" role="status">
            <strong>
              {state.status === "unknown"
                ? "Pedido sem confirmação"
                : "Atualização em andamento"}
            </strong>
            <p>
              {state.error ||
                "A Cloudflare está preparando a versão. O painel confirmará quando o novo código estiver no ar. Isso pode levar alguns minutos."}
            </p>
            <small>
              {state.phase && (
                <>
                  Etapa:{" "}
                  {(
                    {
                      download: "baixando pacote",
                      prepare: "verificando instalação",
                      assets: "enviando arquivos",
                      migrate: "preparando banco",
                      publish: "publicando",
                    } as Record<string, string>
                  )[state.phase] || state.phase}{" "}
                  ·{" "}
                </>
              )}
              Versão solicitada: {state.target.slice(0, 12)} ·{" "}
              {when(state.created)}
            </small>
          </div>
        )}
        {state?.status === "completed" && (
          <div className="connection-result">
            <strong>
              <Check size={17} /> Atualização publicada e verificada.
            </strong>
            <p>Reabra o painel para carregar as novas telas.</p>
            <button
              className="button secondary"
              onClick={() => location.reload()}
            >
              Reabrir painel atualizado
            </button>
          </div>
        )}
        {(u.review_required || state?.status === "failed") && (
          <div className="callout">
            <p>
              {state.error} Abra seu Worker na Cloudflare, confira a aba
              Implantações e resolva o erro exibido.
            </p>
            <label className="check-field">
              <input
                type="checkbox"
                checked={stopped}
                onChange={(e) => setStopped(e.target.checked)}
              />{" "}
              Conferi a versão instalada e a publicação anterior já terminou.
            </label>
            <button
              className="button secondary"
              disabled={!stopped || !!action.busy}
              onClick={() =>
                action.run("Liberando nova tentativa…", async () => {
                  await mutate("updates/reset", {
                    confirmed_build_stopped: stopped,
                  });
                  setStopped(false);
                  await system.refresh();
                })
              }
            >
              Liberar nova tentativa
            </button>
          </div>
        )}
        <button
          className="text-link"
          onClick={() => setEditingHook(!editingHook)}
        >
          {u.configured
            ? "Alterar configuração de atualização"
            : "Configurar atualização pelo painel"}{" "}
          <ArrowRight size={16} />
        </button>
        {(editingHook || !u.configured) &&
          (u.installation_ready ? (
            <form
              className="system-form"
              onSubmit={(e) => {
                e.preventDefault();
                void action.run(
                  "Verificando autorização da atualização…",
                  async () => {
                    await mutate("updates/configure", { token: updateToken });
                    setUpdateToken("");
                    setEditingHook(false);
                    await system.refresh();
                    action.setMessage("Atualização direta autorizada.");
                  },
                );
              }}
            >
              <p>
                Instalação: <strong>{u.worker_name}</strong>. O instalador já
                configura a atualização. Use este campo para renovar ou
                substituir o token.
              </p>
              <p>
                Na Cloudflare, abra My Profile → API Tokens → Create Token →
                Custom Token. Permissão de conta:{" "}
                <strong>Workers Scripts: Edit</strong>. Limite à conta desta
                instalação. Esse token permite publicar Workers nessa conta.
                Banco, mídias e credenciais continuam na sua Cloudflare.
              </p>
              <Input
                label="Token Cloudflare para atualizações"
                type="password"
                autoComplete="new-password"
                value={updateToken}
                onChange={(e) => setUpdateToken(e.target.value)}
                required
              />
              <button className="button" disabled={!!action.busy || updating}>
                Verificar e salvar token
              </button>
            </form>
          ) : (
            <div className="callout">
              <p>
                Esta instalação foi criada pelo fluxo anterior.
                {u.method === "legacy" &&
                  " O hook existente continua disponível até a migração."}
                Use o instalador novo para criar uma instalação sem repositório
                próprio.
              </p>
              <a href="/install#reinstalar" className="text-link">
                Ver o roteiro de reinstalação
              </a>
            </div>
          ))}
      </section>
      <AutomaticUpdates
        api={api}
        demo={demo}
        updates={u}
        refresh={system.refresh}
      />
      <section className="card system-card">
        <div className="section-heading">
          <h2>
            <Cloud size={22} /> Preparação do Hermes na Cloudflare
          </h2>
          <span
            className={
              "badge " + (data.cloudflare.configured ? "active" : "paused")
            }
          >
            {data.cloudflare.configured ? "Autorizado" : "Configuração inicial"}
          </span>
        </div>
        <p>
          Autorize esta instalação a criar um túnel, os endereços DNS e a
          proteção Access para seu Hermes. Depois, use{" "}
          <strong>Conexões → Preparar Hermes na Cloudflare</strong>.
        </p>
        {data.cloudflare.configured && (
          <>
            <p>
              Domínio autorizado: <strong>{data.cloudflare.domain}</strong>
            </p>
            <button
              className="text-link"
              onClick={() => {
                setCf({ ...data.cloudflare, token: "" });
                setEditingCf(!editingCf);
              }}
            >
              Alterar autorização Cloudflare
            </button>
          </>
        )}
        {(!data.cloudflare.configured || editingCf) && (
          <form
            className="system-form"
            onSubmit={(e) => {
              e.preventDefault();
              void action.run(
                "Verificando autorização Cloudflare…",
                async () => {
                  await mutate("cloudflare/configure", cf);
                  setCf({ ...cf, token: "" });
                  setEditingCf(false);
                  await system.refresh();
                  action.setMessage(
                    "Conta e domínio verificados. Abra Conexões para preparar o Hermes.",
                  );
                },
              );
            }}
          >
            <details>
              <summary>Onde encontrar os dados e criar o token</summary>
              <ol className="plain-steps">
                <li>
                  Ative o plano Zero Trust e mantenha seu domínio ativo na
                  Cloudflare. Essas adesões são feitas uma vez na sua conta.
                </li>
                <li>
                  Abra o domínio na Cloudflare. Em Overview/Visão geral, copie{" "}
                  <strong>Account ID</strong> e <strong>Zone ID</strong>.
                </li>
                <li>
                  Em My Profile → API Tokens → Create Token → Custom Token,
                  limite o acesso à sua conta e ao domínio escolhido.
                </li>
                <li>
                  Permissões de conta: <strong>Cloudflare Tunnel: Edit</strong>,{" "}
                  <strong>Access: Apps and Policies: Edit</strong> e{" "}
                  <strong>Access: Service Tokens: Edit</strong>. Permissões da
                  zona: <strong>Zone: Read</strong> e <strong>DNS: Edit</strong>
                  .
                </li>
                <li>
                  Copie o token de API para baixo. Ele será guardado
                  criptografado. O Client ID/Client Secret do Access que você já
                  possui são outros dados.
                </li>
              </ol>
            </details>
            <div className="system-grid">
              <Input
                label="Account ID da Cloudflare"
                name="cloudflare_account_id"
                autoComplete="off"
                value={cf.account_id}
                onChange={(e) =>
                  setCf({ ...cf, account_id: e.target.value.trim() })
                }
                pattern="[a-f0-9]{32}"
                required
              />
              <Input
                label="Zone ID do domínio"
                name="cloudflare_zone_id"
                autoComplete="off"
                value={cf.zone_id}
                onChange={(e) =>
                  setCf({ ...cf, zone_id: e.target.value.trim() })
                }
                pattern="[a-f0-9]{32}"
                required
              />
            </div>
            <Input
              label={
                data.cloudflare.configured
                  ? "Novo token de API (vazio mantém o atual)"
                  : "Token de API da Cloudflare"
              }
              type="password"
              autoComplete="new-password"
              value={cf.token}
              onChange={(e) => setCf({ ...cf, token: e.target.value.trim() })}
              required={!data.cloudflare.configured}
            />
            <button className="button" disabled={!!action.busy}>
              <ShieldCheck size={17} /> Verificar e salvar autorização
            </button>
          </form>
        )}
      </section>
      <PushSection api={api} demo={demo} />
    </div>
  );
}

function PushSection({ api, demo }: { api: Api; demo: boolean }) {
  const action = useAction(demo);
  const [config, setConfig] = useState<PushConfig | null>(
    demo ? demoPush : null,
  );
  const [form, setForm] = useState<PushForm>(pushForm(demoPush));
  const [loadError, setLoadError] = useState("");
  const alive = useRef(true);
  const load = useCallback(async () => {
    if (demo) return;
    try {
      const result: PushConfig = await api(
        "v1/system/push",
        "GET",
        undefined,
        AbortSignal.timeout(20000),
      );
      if (alive.current) {
        setConfig(result);
        setForm(pushForm(result));
        setLoadError("");
      }
    } catch (e) {
      if (alive.current)
        setLoadError(
          e instanceof Error
            ? e.message
            : "Não foi possível consultar as notificações.",
        );
    }
  }, [api, demo]);
  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
  }, [load]);
  const set = <K extends keyof PushForm>(name: K, value: PushForm[K]) =>
    setForm((f) => ({ ...f, [name]: value }));
  const statusLabel =
    !config || config.mode === "off"
      ? "Desligado"
      : config.mode === "gateway"
        ? "Gateway"
        : config.fcm_configured
          ? "FCM direto"
          : "FCM sem conta";
  return (
    <section className="card system-card">
      <div className="section-heading">
        <h2>
          <Smartphone size={22} /> Notificações dos aplicativos
        </h2>
        <span
          className={
            "badge " + (config && config.mode !== "off" ? "active" : "paused")
          }
        >
          {statusLabel}
        </span>
      </div>
      <p>
        Os aplicativos Wabotia para Android e iOS, disponíveis nas lojas, se
        conectam a esta instalação informando o endereço do servidor e o login
        de atendente. Aqui você define como este servidor envia avisos de
        mensagens, fila, transferências, protocolos e ligações aos aparelhos.
        Detalhes em <code>docs/MOBILE.md</code>.
      </p>
      <Feedback {...action} error={action.error || loadError} />
      {!config && !loadError ? (
        <p className="connection-progress" role="status">
          <Loader2 className="spin" size={16} /> Carregando notificações…
        </p>
      ) : (
        <form
          className="system-form"
          onSubmit={(e) => {
            e.preventDefault();
            void action.run("Salvando notificações…", async () => {
              const minutes = Number(form.ticket_alert_minutes);
              if (!Number.isInteger(minutes) || minutes < 0)
                throw Error("Informe os minutos do alerta como inteiro ≥ 0.");
              if (form.mode === "fcm" && form.fcm_service_account.trim()) {
                try {
                  JSON.parse(form.fcm_service_account);
                } catch {
                  throw Error(
                    "A conta de serviço FCM precisa ser um JSON válido.",
                  );
                }
              }
              const body: Record<string, unknown> = {
                mode: form.mode,
                preview: form.preview,
                ticket_alert_minutes: minutes,
              };
              if (form.mode === "gateway") {
                body.gateway_url = form.gateway_url.trim() || DEFAULT_GATEWAY;
                if (form.gateway_secret)
                  body.gateway_secret = form.gateway_secret;
              }
              if (form.mode === "fcm" && form.fcm_service_account.trim())
                body.fcm_service_account = form.fcm_service_account.trim();
              const result: PushConfig = await api(
                "v1/system/push/configure",
                "POST",
                body,
                AbortSignal.timeout(45000),
              );
              setConfig(result);
              setForm(pushForm(result));
              action.setMessage(
                result.mode === "off"
                  ? "Notificações desligadas. Os aplicativos continuam funcionando em primeiro plano."
                  : "Notificações salvas. Use “Enviar teste” para conferir nos aparelhos conectados.",
              );
            });
          }}
        >
          <div className="system-grid">
            <label className="field">
              <span>Modo</span>
              <select
                value={form.mode}
                onChange={(e) => {
                  if (isPushMode(e.target.value)) set("mode", e.target.value);
                }}
              >
                <option value="off">Desligado</option>
                <option value="gateway">Gateway Wabotia</option>
                <option value="fcm">FCM direto</option>
              </select>
            </label>
            <label className="field">
              <span>Conteúdo das notificações</span>
              <select
                value={form.preview}
                onChange={(e) => {
                  if (isPushPreview(e.target.value))
                    set("preview", e.target.value);
                }}
              >
                <option value="minimal">Mínimo (apenas “Nova mensagem”)</option>
                <option value="preview">Prévia (nome e trecho do texto)</option>
              </select>
            </label>
            <Input
              label="Alerta de protocolo (minutos antes do prazo; 0 desativa)"
              type="number"
              min="0"
              max="10080"
              step="1"
              value={form.ticket_alert_minutes}
              onChange={(e) => set("ticket_alert_minutes", e.target.value)}
              required
            />
          </div>
          <small>
            O conteúdo das notificações passa pelo provedor de push (Google e
            Apple) e, no modo gateway, também pelo gateway escolhido. O modo
            mínimo não envia nomes nem trechos de mensagens; é o recomendado ao
            usar um gateway de terceiros.
          </small>
          {form.mode === "gateway" && (
            <>
              <p>
                O gateway guarda as credenciais Firebase do aplicativo publicado
                e repassa as notificações sem receber as credenciais desta
                instalação. O padrão é operado pela Queven; quem compila o
                próprio aplicativo pode publicar um gateway próprio.
              </p>
              <div className="system-grid">
                <Input
                  label="URL do gateway"
                  type="url"
                  autoComplete="off"
                  placeholder={DEFAULT_GATEWAY}
                  value={form.gateway_url}
                  onChange={(e) => set("gateway_url", e.target.value.trim())}
                  required
                />
                <Input
                  label={
                    config?.gateway_secret_configured
                      ? "Segredo do gateway (configurado; vazio mantém)"
                      : "Segredo do gateway (opcional)"
                  }
                  type="password"
                  autoComplete="new-password"
                  value={form.gateway_secret}
                  onChange={(e) => set("gateway_secret", e.target.value)}
                />
              </div>
              <small>
                Preencha o segredo somente se o gateway foi publicado com{" "}
                <code>GATEWAY_SHARED_SECRET</code>. Ele é guardado criptografado
                e não volta a ser exibido.
              </small>
            </>
          )}
          {form.mode === "fcm" && (
            <>
              <p>
                {config?.fcm_configured ? (
                  <>
                    Conta configurada: projeto{" "}
                    <strong>
                      {config.fcm_project_id || "sem identificação"}
                    </strong>
                    . Cole um novo JSON somente para substituí-la.
                  </>
                ) : (
                  <>
                    Cole o JSON da conta de serviço do seu projeto Firebase com
                    o papel <strong>Firebase Cloud Messaging API Admin</strong>.
                    Esse modo exige um aplicativo compilado com o mesmo projeto;
                    o aplicativo das lojas usa o gateway.
                  </>
                )}
              </p>
              <label className="field">
                <span>
                  {config?.fcm_configured
                    ? "Nova conta de serviço FCM (JSON; vazio mantém a atual)"
                    : "Conta de serviço FCM (JSON)"}
                </span>
                <textarea
                  rows={6}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder='{"type":"service_account","project_id":"…"}'
                  value={form.fcm_service_account}
                  onChange={(e) => set("fcm_service_account", e.target.value)}
                  required={!config?.fcm_configured}
                />
              </label>
              <small>
                A conta é guardada criptografada e nunca é exibida de volta.
              </small>
            </>
          )}
          <div className="card-actions">
            <button className="button" disabled={!!action.busy}>
              <Check size={17} /> Salvar notificações
            </button>
            <button
              type="button"
              className="button secondary"
              disabled={!!action.busy || !config || config.mode === "off"}
              onClick={() =>
                action.run("Enviando notificação de teste…", async () => {
                  const result: { sent: number; devices: number } = await api(
                    "v1/system/push/test",
                    "POST",
                    {},
                    AbortSignal.timeout(45000),
                  );
                  const devices = Number(result?.devices ?? 0),
                    sent = Number(result?.sent ?? 0);
                  action.setMessage(
                    devices === 0
                      ? "Nenhum dispositivo registrado para a sua conta. Entre no aplicativo neste servidor e repita o teste."
                      : `Teste enviado: ${sent} de ${devices} dispositivo${devices === 1 ? "" : "s"} aceito${sent === 1 ? "" : "s"} pelo provedor.`,
                  );
                })
              }
            >
              <Bell size={16} /> Enviar teste
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(
    new Blob([text], { type: "text/plain;charset=utf-8" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function connectorScript(
  value: { token: string; tunnel_id: string },
  mode: string,
) {
  if (
    !/^[a-f0-9-]{32,36}$/.test(value.tunnel_id) ||
    !/^[A-Za-z0-9_+/=-]{40,2048}$/.test(value.token)
  )
    throw Error("Credencial do conector inválida.");
  const id = value.tunnel_id;
  const base = `#!/usr/bin/env bash\nset -euo pipefail\numask 077\n# Este arquivo contém uma credencial. Guarde-o em local privado.\nwabotia_dir="$HOME/.config/wabotia/tunnels/${id}"\nwabotia_unit="cloudflared-wabotia-${id}.service"\n`;
  const token = `mkdir -p "$wabotia_dir"\nif [ -e "$wabotia_dir/token" ]; then echo "Já existe um token para este túnel. A instalação existente foi preservada."; exit 1; fi\ncat > "$wabotia_dir/token" <<'WABOTIA_TOKEN'\n${value.token}\nWABOTIA_TOKEN\nchmod 600 "$wabotia_dir/token"\n`;
  if (mode === "docker")
    return (
      base +
      `command -v docker >/dev/null || { echo "Instale Docker antes de continuar."; exit 1; }\n[ "$(uname -s)" = "Linux" ] || { echo "Esta opção Docker requer Linux com rede do host. Em macOS use o conector nativo."; exit 1; }\n` +
      token +
      `docker run -d --name "cloudflared-wabotia-${id}" --restart unless-stopped --network host --user "$(id -u):$(id -g)" -v "$wabotia_dir:/etc/wabotia:ro" cloudflare/cloudflared:latest tunnel --no-autoupdate run --token-file /etc/wabotia/token\n`
    );
  const check = `wabotia_bin="$(command -v cloudflared || true)"\n[ -n "$wabotia_bin" ] || { echo "Instale cloudflared seguindo https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/ e execute novamente."; exit 1; }\n`;
  if (mode === "macos")
    return (
      base +
      check +
      token +
      `echo "Conector em execução. Mantenha este terminal aberto. Para iniciar novamente:"\nprintf '%s\\n' "cloudflared tunnel --no-autoupdate run --token-file \\"$wabotia_dir/token\\""\nexec "$wabotia_bin" tunnel --no-autoupdate run --token-file "$wabotia_dir/token"\n`
    );
  return (
    base +
    check +
    `systemctl --user show-environment >/dev/null || { echo "Ative systemd (no WSL2, na mesma distribuição do Hermes) antes de continuar, ou use o conector em terminal."; exit 1; }\n[ ! -e "$HOME/.config/systemd/user/$wabotia_unit" ] || { echo "Serviço já existe; preservado."; exit 1; }\n` +
    token +
    `mkdir -p "$HOME/.config/systemd/user"\ncat > "$HOME/.config/systemd/user/$wabotia_unit" <<WABOTIA_UNIT\n[Unit]\nDescription=Tunnel Wabotia ${id}\nAfter=network-online.target\n[Service]\nExecStart="$wabotia_bin" tunnel --no-autoupdate run --token-file "$wabotia_dir/token"\nRestart=on-failure\nRestartSec=5\n[Install]\nWantedBy=default.target\nWABOTIA_UNIT\nsystemctl --user daemon-reload\nsystemctl --user enable --now "$wabotia_unit"\nsystemctl --user is-active "$wabotia_unit"\necho "Conector iniciado. Em uma VPS, habilite permanência após logout: sudo loginctl enable-linger $(id -un)"\necho "Volte ao Wabotia: ative a conexão, teste e encontre os bots."\n`
  );
}

export function CloudflareDeploy({
  api,
  demo,
  profile,
  openSystem,
  refreshConnections,
}: {
  api: Api;
  demo: boolean;
  profile: string;
  openSystem: () => void;
  refreshConnections: () => Promise<void>;
}) {
  const system = useSystem(api, demo),
    action = useAction(demo);
  const [open, setOpen] = useState(false),
    [review, setReview] = useState(false);
  const [mode, setMode] = useState("linux");
  const [form, setForm] = useState({
    admin_hostname: "",
    api_hostname: "",
    remote_profile: "wabotia",
    admin_port: 9119,
    api_port: 8642,
    dashboard_token: "",
    profile_key: "",
    prerequisites_confirmed: false,
  });
  const set = (name: string, value: any) => {
    setForm((f) => ({ ...f, [name]: value }));
    setReview(false);
  };
  const jobs =
    system.data?.deployments.filter((job) => job.profile_id === profile) || [];
  const configured = system.data?.cloudflare.configured;
  const domain = system.data?.cloudflare.domain || "seudominio.com";
  return (
    <section className="card system-card cloudflare-deploy">
      <div className="section-heading">
        <div>
          <h2>
            <Cloud size={21} /> Hermes na Cloudflare
          </h2>
          <p>
            Prepare o acesso seguro ao Hermes que está na sua máquina ou VPS.
          </p>
        </div>
        <button
          className="button secondary"
          onClick={() => {
            setOpen(!open);
            setReview(false);
          }}
        >
          {open ? (
            <>
              <X size={16} /> Fechar assistente
            </>
          ) : (
            <>
              <Cloud size={16} /> Preparar Hermes na Cloudflare
            </>
          )}
        </button>
      </div>
      <Feedback {...action} error={action.error || system.error} />
      {open &&
        (!system.data ? (
          <p>Carregando autorização…</p>
        ) : !configured ? (
          <div className="callout">
            <strong>Primeiro, autorize sua conta Cloudflare.</strong>
            <p>
              Você precisará de um token de API com acesso ao domínio, ao Access
              e aos túneis. Essa preparação é feita uma vez.
            </p>
            <button className="button" onClick={openSystem}>
              Configurar autorização Cloudflare <ArrowRight size={16} />
            </button>
          </div>
        ) : (
          <form
            className="system-form"
            onSubmit={(e) => {
              e.preventDefault();
              setReview(true);
            }}
          >
            <p>
              Use endereços novos no domínio <strong>{domain}</strong>. Se esta
              máquina já está conectada, use “Testar conexão” no cartão
              existente.
            </p>
            <div className="system-grid">
              <Input
                label="Endereço para descobrir bots"
                placeholder={`hermes-local.${domain}`}
                value={form.admin_hostname}
                onChange={(e) =>
                  set("admin_hostname", e.target.value.trim().toLowerCase())
                }
                required
              />
              <Input
                label="Endereço da API do bot"
                placeholder={`api-hermes-local.${domain}`}
                value={form.api_hostname}
                onChange={(e) =>
                  set("api_hostname", e.target.value.trim().toLowerCase())
                }
                required
              />
            </div>
            <div className="system-grid">
              <Input
                label="Nome exato do perfil no Hermes"
                value={form.remote_profile}
                pattern="[a-z0-9][a-z0-9_-]{0,63}"
                onChange={(e) => set("remote_profile", e.target.value)}
                required
              />
              <Input
                label="Porta do administrador Hermes"
                type="number"
                min="1"
                max="65535"
                value={form.admin_port}
                onChange={(e) => set("admin_port", Number(e.target.value))}
                required
              />
              <Input
                label="Porta da API Hermes"
                type="number"
                min="1"
                max="65535"
                value={form.api_port}
                onChange={(e) => set("api_port", Number(e.target.value))}
                required
              />
            </div>
            <div className="system-grid">
              <Input
                label="Token administrativo Hermes"
                type="password"
                autoComplete="new-password"
                minLength={16}
                value={form.dashboard_token}
                onChange={(e) => set("dashboard_token", e.target.value)}
                required
              />
              <Input
                label="Chave da API do perfil Hermes (API_SERVER_KEY)"
                type="password"
                autoComplete="new-password"
                minLength={16}
                value={form.profile_key}
                onChange={(e) => set("profile_key", e.target.value)}
                required
              />
            </div>
            <p>
              Essas duas chaves já devem existir no Hermes. Veja{" "}
              <a className="text-link" href="/install#hermes" target="_blank">
                como preparar o perfil e ligar a API
              </a>
              . As chaves MASTER_KEY e SETUP_TOKEN do Wabotia têm outra
              finalidade.
            </p>
            <label className="check-field">
              <input
                type="checkbox"
                checked={form.prerequisites_confirmed}
                onChange={(e) =>
                  set("prerequisites_confirmed", e.target.checked)
                }
                required
              />{" "}
              Ativei Zero Trust. O perfil e as duas APIs do Hermes estão
              ligados, nas portas acima, na mesma máquina em que vou executar o
              conector.
            </label>
            {!review && (
              <button className="button" disabled={!!action.busy}>
                Revisar configuração <ArrowRight size={16} />
              </button>
            )}
            {review && (
              <div className="callout deployment-review">
                <strong>Será criado nesta conta Cloudflare:</strong>
                <ul>
                  <li>
                    Um túnel exclusivo para o perfil{" "}
                    <strong>{form.remote_profile}</strong>.
                  </li>
                  <li>
                    Duas aplicações Access e uma credencial Service Auth válida
                    por um ano.
                  </li>
                  <li>
                    DNS <strong>{form.admin_hostname}</strong> e{" "}
                    <strong>{form.api_hostname}</strong>, com acesso somente à
                    descoberta de perfis e à API do bot escolhido.
                  </li>
                  <li>
                    Uma conexão pausada neste perfil de atendimento do Wabotia.
                  </li>
                </ul>
                <p>
                  Depois, baixe e execute o conector na máquina do Hermes.
                  Recursos existentes serão preservados; endereços já usados
                  impedem o deploy.
                </p>
                <button
                  type="button"
                  className="button"
                  disabled={!!action.busy}
                  onClick={() =>
                    action.run("Registrando deploy do Hermes…", async () => {
                      await api(
                        "v1/system/cloudflare/deploy",
                        "POST",
                        { ...form, profile_id: profile },
                        AbortSignal.timeout(45000),
                      );
                      setForm((f) => ({
                        ...f,
                        dashboard_token: "",
                        profile_key: "",
                      }));
                      setOpen(false);
                      setReview(false);
                      await system.refresh();
                      action.setMessage(
                        "Preparação iniciada. Acompanhe as etapas abaixo.",
                      );
                    })
                  }
                >
                  <Cloud size={17} /> Fazer deploy da configuração
                </button>
              </div>
            )}
          </form>
        ))}
      {jobs.length > 0 && (
        <div className="deployment-list">
          {jobs.map((job) => (
            <article key={job.id} className="deployment-job">
              <div className="section-heading">
                <strong>Hermes · {job.remote_profile}</strong>
                <span className={"badge " + job.status}>
                  {
                    (
                      {
                        ready: "Configuração pronta",
                        pending: "Preparando",
                        running: "Preparando",
                        failed: "Etapa falhou",
                        unknown: "Conferência necessária",
                      } as any
                    )[job.status]
                  }
                </span>
              </div>
              <p>
                {job.admin_hostname}
                <br />
                {job.api_hostname}
              </p>
              <progress
                max={job.total}
                value={job.step}
                aria-label="Etapas concluídas"
              />
              <p>
                {job.step} de {job.total} etapas · {job.label}
              </p>
              {job.error && (
                <div className="connection-result error" role="alert">
                  {job.error}
                </div>
              )}
              {job.status === "failed" && (
                <button
                  className="button secondary"
                  disabled={!!action.busy}
                  onClick={() =>
                    action.run("Retomando preparação…", async () => {
                      await api("v1/system/cloudflare/retry", "POST", {
                        id: job.id,
                      });
                      await system.refresh();
                    })
                  }
                >
                  Retomar após corrigir
                </button>
              )}
              {job.status === "unknown" && (
                <p>
                  Abra o dashboard Cloudflare e confira o recurso da etapa
                  indicada. O sistema não repetirá a criação sem confirmação.
                  Use o{" "}
                  <a
                    className="text-link"
                    href="/install#hermes"
                    target="_blank"
                  >
                    procedimento manual
                  </a>{" "}
                  para concluir a conexão com os recursos já criados.
                </p>
              )}
              {job.status === "ready" && (
                <div className="connector-steps">
                  <strong>Agora ligue o conector na máquina do Hermes</strong>
                  <p>
                    Instale{" "}
                    <a
                      className="text-link"
                      href="https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/"
                      target="_blank"
                      rel="noreferrer"
                    >
                      cloudflared
                    </a>{" "}
                    (ou Docker, se escolher essa opção). No Docker, publique as
                    APIs do Hermes nas portas locais informadas acima.
                  </p>
                  <label className="field">
                    Como o conector será executado
                    <select
                      value={mode}
                      onChange={(e) => setMode(e.target.value)}
                    >
                      <option value="linux">
                        Linux / VPS / WSL2 com systemd
                      </option>
                      <option value="docker">Docker no Linux</option>
                      <option value="macos">macOS ou terminal aberto</option>
                    </select>
                  </label>
                  <button
                    className="button secondary"
                    disabled={!!action.busy}
                    onClick={() =>
                      action.run(
                        "Preparando arquivo privado do conector…",
                        async () => {
                          const result = await api(
                            `v1/system/cloudflare/${job.id}/connector`,
                          );
                          download(
                            `wabotia-conector-${mode}.sh`,
                            connectorScript(result, mode),
                          );
                          await refreshConnections();
                          action.setMessage(
                            "Arquivo baixado. Ele contém uma credencial: guarde-o em local privado e execute na máquina do Hermes.",
                          );
                        },
                      )
                    }
                  >
                    <Download size={16} /> Baixar instalador do conector
                  </button>
                  <p>
                    No terminal da máquina do Hermes, entre na pasta onde salvou
                    o arquivo e execute:
                  </p>
                  <pre>
                    <code>bash wabotia-conector-{mode}.sh</code>
                  </pre>
                  <p>
                    Em uma VPS, envie esse arquivo de forma privada para o
                    servidor e execute lá. O instalador cria um serviço
                    separado. Em macOS/terminal, mantenha a janela aberta. Volte
                    ao cartão da conexão, clique em{" "}
                    <strong>Ativar → Testar conexão → Descobrir bots</strong>,
                    escolha o Atendente na Equipe Bot e só depois ative o
                    atendimento.
                  </p>
                  <small>
                    Credencial Access: válida por um ano. Programe a renovação
                    no Cloudflare antes do vencimento e atualize a conexão.
                  </small>
                </div>
              )}
              <details>
                <summary>Identificadores dos recursos para suporte</summary>
                <p>Túnel: {job.tunnel_name}</p>
                <pre>{JSON.stringify(job.resources, null, 2)}</pre>
              </details>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
