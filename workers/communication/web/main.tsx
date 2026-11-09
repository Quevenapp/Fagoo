import { WhatsAppConversation } from "./WhatsAppConversation";
import {ApiDocumentationLink} from './ApiDocumentation';
import { NumberRouter } from "./NumberRouter";
import {
  LinesPanel,
  MenusPanel,
  BotLinesEditor,
  ConversationMenu,
} from "./ServicePanels";
import { TeamPanel } from "./TeamPanel";
import { RouterGuide } from "./RouterGuide";
import { MetaGuide } from "./MetaGuide";
import { WhatsAppGroups, GroupControls } from "./WhatsAppGroups";
import { callStatus } from "./WhatsAppCalls";
import { DirectInstall } from "./DirectInstall";
import React, { useEffect, useRef, useState } from "react";

import { HermesInstall } from "./hermes-install";
import { CloudflarePrerequisites } from "./cloudflare-prerequisites";
import {
  ArrowUpRight,
  ArrowRight,
  BookOpen,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Cloud,
  Code2,
  Download,
  FileText,
  Headphones,
  LayoutDashboard,
  Link2,
  Loader2,
  LogOut,
  Menu,
  MessageCircle,
  Plus,
  Phone,
  Search,
  Send,
  Settings,
  ShieldCheck,
  Star,
  Users,
  X,
  Activity,
  Copy,
  Plug,
  Zap,
  Globe,
} from "lucide-react";
import { InstallKeys } from "./InstallKeys";
import { ConnectionDiagnostics } from "./ConnectionDiagnostics";
import { CloudflareDeploy, SystemPanel } from "./SystemPanel";
import { MaintenanceGuide } from "./maintenance-guide";
import { ContactGuide } from "./ContactGuide";
import { WhatsAppGuide } from "./WhatsAppGuide";
import { ContactsPanel, ContactEditor, demoContacts } from "./ContactsPanel";
import { SetupWizard } from "./SetupWizard";
import { PairingPanel } from "./PairingPanel";
import {
  sections,
  visibleGroups,
  canOpenPage,
  pageDescriptions,
  type PanelMode,
  type PageId,
} from "./workspace-navigation";
type Row = Record<string, any>;
async function legacyApi(
  path: string,
  method = "GET",
  body?: any,
  signal?: AbortSignal,
  idempotencyKey?: string,
): Promise<any> {
  const response = await fetch("/api/" + path, {
    method,
    credentials: "same-origin",
    signal,
    headers: {
      ...(body instanceof FormData
        ? {}
        : { "Content-Type": "application/json" }),
      ...(method !== "GET"
        ? { "Idempotency-Key": idempotencyKey || crypto.randomUUID() }
        : {}),
    },
    body:
      body === undefined
        ? undefined
        : body instanceof FormData
          ? body
          : JSON.stringify(body),
  });
  const data: any = await response.json();
  if (!response.ok)
    throw Object.assign(
      new Error(data.error?.message || "Não foi possível concluir."),
      {
        status: response.status,
        code: data.error?.code,
      },
    );
  return data;
}
const api=legacyApi;
const date = (n: number) =>
  n
    ? new Date(n).toLocaleString("pt-BR", {
        timeZone: "America/Sao_Paulo",
        dateStyle: "short",
        timeStyle: "short",
      })
    : "—";
const parse = (v: any, f: any = {}) => {
  if (typeof v !== "string") return v || f;
  try {
    return JSON.parse(v);
  } catch {
    return f;
  }
};
const statusNames: Row = {
  ai: "Com a IA",
  waiting: "Na fila",
  human: "Com atendente",
  closed: "Concluído",
  open: "Aberto",
  in_progress: "Em andamento",
  active: "Conectado",
  enabled: "Habilitado",
  disabled: "Desabilitado",
  paused: "Pausado",
  pending: "Pendente",
  sent: "Enviado",
  failed: "Falhou",
  unknown: "Conferir entrega",
  ready: "Disponível",
  unavailable: "Indisponível",
  queued: "Na fila",
  completed: "Concluído",
  running: "Em execução",
  granted: "Autorizado",
  revoked: "Revogado",
  answered: "Respondida",
};
function Badge({ value }: { value: string }) {
  return (
    <span className={"badge " + value}>{statusNames[value] || value}</span>
  );
}
function Logo({ light = false }: { light?: boolean }) {
  return (
    <a className={"logo " + (light ? "light" : "")} href="/">
      <span className="logo-icon">
        <MessageCircle size={19} fill="currentColor" />
        <span />
      </span>
      wabotia<span className="logo-dot">.</span>
    </a>
  );
}
function Button({
  children,
  onClick,
  secondary = false,
  disabled = false,
  type = "button",
}: any) {
  return (
    <button
      type={type}
      disabled={disabled}
      className={secondary ? "button secondary" : "button"}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
function Field({
  label,
  value,
  onChange,
  type = "text",
  options,
  placeholder,
  required = false,
}: any) {
  return (
    <label className="field">
      <span>{label}</span>
      {options ? (
        <select
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value)}
          required={required}
        >
          <option value="">Selecione...</option>
          {options.map((o: any) => (
            <option key={o.id ?? o[0]} value={o.id ?? o[0]}>
              {o.name ?? o[1]}
            </option>
          ))}
        </select>
      ) : type === "textarea" ? (
        <textarea
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
        />
      ) : (
        <input
          type={type}
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          required={required}
        />
      )}
    </label>
  );
}
function Modal({ title, children, close }: any) {
  const dialog = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const focusable = () =>
      Array.from(
        dialog.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]',
        ) || [],
      ).filter((element) => element.getClientRects().length);
    (focusable()[0] || dialog.current)?.focus();
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (!items.length) {
        event.preventDefault();
        return;
      }
      const first = items[0],
        last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    dialog.current?.addEventListener("keydown", keyboard);
    const element = dialog.current;
    return () => {
      element?.removeEventListener("keydown", keyboard);
      previous?.focus();
    };
  }, []);
  return (
    <div className="modal-backdrop" onClick={close}>
      <section
        className="modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={dialog}
        tabIndex={-1}
      >
        <header>
          <h2>{title}</h2>
          <button className="icon-button" onClick={close} aria-label="Fechar">
            <X />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}
function Empty({
  title = "Tudo pronto para começar",
  description = "Os registros aparecerão aqui quando seu atendimento começar.",
}: any) {
  return (
    <div className="empty">
      <span>
        <MessageCircle size={28} />
      </span>
      <h3>{title}</h3>
      <p>{description}</p>
    </div>
  );
}
function CopyButton({ value }: any) {
  const [copied, set] = useState(false);
  return (
    <button
      className="icon-button"
      aria-label="Copiar"
      onClick={() =>
        navigator.clipboard.writeText(value).then(() => {
          set(true);
          setTimeout(() => set(false), 2000);
        })
      }
    >
      {copied ? <Check size={16} /> : <Copy size={16} />}
    </button>
  );
}
function Landing() {
  return (
    <div className="landing">
      <nav className="landing-nav">
        <Logo />
        <div>
          <a href="#como-funciona">Como funciona</a>
          <a href="/install">Instalação</a>
          <ApiDocumentationLink>Para desenvolvedores</ApiDocumentationLink>
        </div>
        <a className="button small" href="/app">
          Abrir painel <ArrowUpRight size={16} />
        </a>
      </nav>
      <main>
        <section className="hero">
          <div className="hero-copy">
            <div className="eyebrow">
              <span /> CÓDIGO ABERTO · FEITO PARA O HERMES
            </div>
            <h1>
              Conversas que
              <br />
              chegam ao
              <br />
              <em>lugar certo.</em>
            </h1>
            <p>
              Seus bots, sua equipe e seus clientes. Um atendimento conectado no
              WhatsApp, com a inteligência do Hermes e o controle nas suas mãos.
            </p>
            <div className="hero-actions">
              <a className="button" href="/install#nodejs">
                Publicar na Cloudflare <Cloud size={19} />
              </a>
              <a className="text-link" href="/install">
                Ver passo a passo <ArrowRight size={17} />
              </a>
            </div>
            <div className="hero-proof">
              <ShieldCheck size={16} /> Na sua conta Cloudflare. Com os seus
              dados.
            </div>
          </div>
          <div className="hero-visual">
            <div className="orbit orbit1" />
            <div className="orbit orbit2" />
            <div className="connection-chip chip-hermes">
              <Bot /> Hermes <span>Inteligência</span>
            </div>
            <div className="connection-chip chip-team">
              <Users /> Sua equipe <span>Atendimento humano</span>
            </div>
            <div className="connection-chip chip-api">
              <Code2 /> Seus sistemas <span>API aberta</span>
            </div>
            <div className="hero-card">
              <div className="hero-card-top">
                <span className="mini-logo">
                  <MessageCircle size={18} />
                </span>
                <strong>Um atendimento, conectado.</strong>
                <span className="online-dot" />
              </div>
              <div className="hero-chat customer">
                Olá! Preciso de ajuda com meu pedido.
                <span>Cliente · WhatsApp</span>
              </div>
              <div className="hero-chat assistant">
                Claro! Vou consultar as informações e ajudar você.
                <span>Atendente · Hermes</span>
              </div>
              <div className="handoff">
                <Check size={14} /> Contexto preservado, do bot à equipe.
              </div>
              <div className="hero-card-bottom">
                <span>WhatsApp</span>
                <span>Telegram</span>
                <span>Web + API</span>
              </div>
            </div>
            <span className="visual-caption">
              Uma visão de como seu atendimento se conecta.
            </span>
          </div>
        </section>
        <section className="feature-band" id="como-funciona">
          <div>
            <span className="step-no">01</span>
            <h3>Conecte seu Hermes</h3>
            <p>
              Local, em Docker ou na sua VPS. Ligue seus bots ao painel por uma
              conexão segura.
            </p>
          </div>
          <div>
            <span className="step-no">02</span>
            <h3>Organize o atendimento</h3>
            <p>Conversas, protocolos, conhecimento e equipe no mesmo lugar.</p>
          </div>
          <div>
            <span className="step-no">03</span>
            <h3>Integre seus sistemas</h3>
            <p>
              Uma API documentada para mensagens, chamados e execução de bots.
            </p>
          </div>
        </section>
        <section className="landing-bottom">
          <div>
            <div className="eyebrow">SIMPLES DE OPERAR. SEU PARA EVOLUIR.</div>
            <h2>Comece com um guia ao seu lado.</h2>
            <p>
              Do primeiro deploy à primeira conversa, com instruções em
              português.
            </p>
          </div>
          <a className="button secondary" href="/install">
            Abrir guia de instalação <ArrowRight size={18} />
          </a>
        </section>
      </main>
      <footer>
        <Logo />
        <span>MIT · Quevenapp</span>
        <a href="https://github.com/Quevenapp/Wabotia">
          Código no GitHub <ArrowUpRight size={14} />
        </a>
      </footer>
    </div>
  );
}
const installSteps = [
  [
    "Prepare a Cloudflare",
    "Ative R2, confira D1 e Workers e prepare Zero Trust para o túnel do Hermes.",
  ],
  [
    "Execute o instalador",
    "Baixe o instalador oficial. Informe Account ID, token Cloudflare e um nome novo. Ele publica os recursos e gera as chaves.",
  ],
  [
    "Crie seu administrador",
    "Abra a URL exibida e use SETUP_TOKEN do arquivo chaves.local.json para criar sua conta individual.",
  ],
  [
    "Conecte o Hermes",
    "Cadastre as APIs e as chaves do Hermes. Teste a conexão, descubra os bots e selecione o Atendente.",
  ],
  [
    "Escolha seus canais",
    "Conecte Meta ou QR e configure o bot Telegram dedicado. Use apenas um modo por número.",
  ],
  [
    "Teste e atualize pelo painel",
    "Confira mensagens e tomada humana antes de ativar. As próximas versões oficiais são instaladas em Sistema e atualizações.",
  ],
];
function Install() {
  useEffect(() => {
    const showStep = () => {
      if (
        [
          "#nodejs",
          "#nodejs-erros",
          "#instalar",
          "#reinstalar",
          "#requisitos",
          "#servicos-cloudflare",
          "#hermes",
          "#cloudflare-hermes",
          "#deploy-hermes",
          "#atualizacoes",
          "#agenda",
          "#meta-whatsapp",
          "#whatsapp-recursos",
          "#roteador",
        ].includes(location.hash)
      ) {
        const target = document.getElementById(location.hash.slice(1));
        if (target instanceof HTMLDetailsElement) target.open = true;
        target?.scrollIntoView();
      }
    };
    const frame = requestAnimationFrame(showStep);
    window.addEventListener("load", showStep, { once: true });
    window.addEventListener("hashchange", showStep);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("load", showStep);
      window.removeEventListener("hashchange", showStep);
    };
  }, []);
  return (
    <div className="guide-page">
      <nav className="landing-nav">
        <Logo />
        <a href="/" className="text-link">
          Voltar ao início
        </a>
      </nav>
      <main>
        <div className="eyebrow">GUIA DE INSTALAÇÃO</div>
        <h1>
          Seu primeiro atendimento,
          <br />
          <em>passo a passo.</em>
        </h1>
        <p className="lead">
          Você configura uma vez. Depois, tudo acontece pelo painel.
        </p>
        <DirectInstall />
        <CloudflarePrerequisites />
        <div className="guide-actions">
          <a
            className="button secondary"
            href="/guide/wabotia-instalacao.pdf"
            download
          >
            Baixar guia em PDF <Download size={18} />
          </a>
        </div>
        <details>
          <summary>
            Gerador de chaves para configuração manual (opcional)
          </summary>
          <InstallKeys />
        </details>
        <div className="guide-grid">
          {installSteps.map(([title, desc], i) => (
            <article key={title}>
              <span className="step-no">0{i + 1}</span>
              <h2>{title}</h2>
              <p>{desc}</p>
              {i === 0 && (
                <div className="inline-links">
                  <a href="https://dash.cloudflare.com/">Cloudflare ↗</a>
                </div>
              )}
            </article>
          ))}
        </div>
        <HermesInstall />
        <MaintenanceGuide />
        <ContactGuide />
        <MetaGuide />
        <WhatsAppGuide />
        <RouterGuide />
        <aside className="callout">
          <ShieldCheck />
          <div>
            <strong>Guarde suas chaves com cuidado</strong>
            <p>
              Tokens e senhas ficam nos campos protegidos. Não publique esses
              valores no GitHub nem envie em mensagens de suporte.
            </p>
          </div>
        </aside>
        <div className="guide-links">
          <a href="/app">
            Abrir painel <ArrowRight size={17} />
          </a>
          <ApiDocumentationLink>
            Documentação da API <Code2 size={17} />
          </ApiDocumentationLink>
          <a href="/app?demo=1">
            Conhecer as telas com dados fictícios <ArrowUpRight size={17} />
          </a>
        </div>
      </main>
    </div>
  );
}
function ApiDocs() {
  const [spec, setSpec] = useState<any>(null),
    [selected, setSelected] = useState(""),
    [token, setToken] = useState(""),
    [path, setPath] = useState("/profiles"),
    [result, setResult] = useState("");
  useEffect(() => {
    api("openapi.json")
      .then(setSpec)
      .catch((e) => setResult(e.message));
  }, []);
  return (
    <div className="guide-page">
      <nav className="landing-nav">
        <Logo />
        <a href="/install">Guia de instalação</a>
      </nav>
      <main>
        <div className="eyebrow">PARA DESENVOLVEDORES</div>
        <h1>
          Atendimento dentro
          <br />
          do seu sistema.
        </h1>
        <p className="lead">
          API REST v1, bots assíncronos e webhooks assinados. Crie uma aplicação
          no painel para começar.
        </p>
        <div className="api-layout">
          <section className="card">
            <h2>Explore os recursos</h2>
            {spec &&
              Object.entries(spec.paths).map(([p, methods]: any) =>
                Object.entries(methods).map(([method, op]: any) => (
                  <button
                    className={
                      "endpoint " + (selected === method + p ? "selected" : "")
                    }
                    key={method + p}
                    onClick={() => {
                      setSelected(method + p);
                      setPath(p);
                    }}
                  >
                    <b>{method.toUpperCase()}</b>
                    <span>{p}</span>
                    <small>{op.summary}</small>
                  </button>
                )),
              )}
          </section>
          <section>
            <div className="card">
              <h2>Testar consulta</h2>
              <p>
                O token fica somente nesta tela. Este explorador executa
                consultas GET; use os exemplos para operações de escrita.
              </p>
              <Field
                label="Chave de integração"
                type="password"
                value={token}
                onChange={setToken}
              />
              <Field
                label="Caminho após /api/v1"
                value={path}
                onChange={setPath}
              />
              <Button
                onClick={async () => {
                  if (!path.startsWith("/") || path.includes("://")) return;
                  try {
                    const r = await fetch("/api/v1" + path, {
                      headers: { Authorization: `Bearer ${token}` },
                    });
                    setResult(JSON.stringify(await r.json(), null, 2));
                  } catch (e: any) {
                    setResult(e.message);
                  }
                }}
              >
                Executar consulta <ArrowRight size={16} />
              </Button>
              <pre>{result || "O resultado da consulta aparecerá aqui."}</pre>
            </div>
            <div className="card">
              <h3>Operações seguras para repetir</h3>
              <p>
                Envie <code>Idempotency-Key</code> em pedidos de escrita. Uma
                chave repetida com outro conteúdo retorna conflito.
              </p>
              <h3>Execução de bots</h3>
              <p>
                POST /bot-runs retorna 202. Consulte o identificador até
                concluir ou receba um webhook.
              </p>
              <h3>Assinatura dos webhooks</h3>
              <p>
                Valide HMAC-SHA256 sobre <code>timestamp.corpo_original</code> e
                deduplique o ID do evento.
              </p>
              <a href="/api/openapi.json">Baixar OpenAPI 3.1 ↗</a>
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
const demoProfile = {
  id: "demo",
  name: "Atendimento Queven",
  settings: {
    attendant_bot: "demo-bot",
    instructions: "Acolha o cliente e responda com clareza.",
    protocol_response_hours: 24,
    reply_mode: "command",
    capabilities: [],
    menus: [],
    apps: [],
  },
};
const demoConversations = [
  {
    id: "demo-1",
    external_id: "Cliente de exemplo",
    phone: "Cliente de exemplo",
    state: "waiting",
    updated: Date.now() - 600000,
    last_customer: Date.now() - 600000,
  },
  {
    id: "demo-2",
    external_id: "Conversa de demonstração",
    phone: "Conversa de demonstração",
    state: "ai",
    updated: Date.now() - 1800000,
    last_customer: Date.now() - 1800000,
  },
];
function Login({ ready }: any) {
  const [setup, setSetup] = useState(false),
    [configured, setConfigured] = useState(true),
    [form, setForm] = useState<Row>({}),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    api("auth/status")
      .then((s) => {
        setSetup(!s.initialized);
        setConfigured(s.configured);
      })
      .catch((e) => setError(e.message));
  }, []);
  return (
    <div className="login-page">
      <div className="login-brand">
        <Logo light />
        <h1>
          Seu atendimento.
          <br />
          <em>Bem conectado.</em>
        </h1>
        <p>
          Inteligência quando ajuda.
          <br />
          Pessoas quando importa.
        </p>
        <div className="login-symbol">
          <MessageCircle size={140} />
        </div>
      </div>
      <main>
        <div className="login-form">
          <div className="eyebrow">BEM-VINDO AO WABOTIA</div>
          <h2>
            {setup ? "Crie sua conta de administrador" : "Vamos continuar?"}
          </h2>
          <p>
            {setup
              ? "Esta etapa é feita somente uma vez, na sua instalação."
              : "Entre para acompanhar suas conversas e sua equipe."}
          </p>
          {!configured && (
            <div className="notice error">
              Configure MASTER_KEY e SETUP_TOKEN nos secrets do Worker antes de
              começar.
            </div>
          )}
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError("");
              try {
                if (setup) await api("auth/setup", "POST", form);
                await api("auth/login", "POST", form);
                ready();
              } catch (e: any) {
                setError(e.message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {setup && (
              <>
                <Field
                  label="Seu nome"
                  value={form.name}
                  onChange={(name: string) => setForm({ ...form, name })}
                  required
                />
                <Field
                  label="Código de instalação (SETUP_TOKEN)"
                  type="password"
                  value={form.token}
                  onChange={(token: string) => setForm({ ...form, token })}
                  required
                />
              </>
            )}
            <Field
              label="E-mail"
              type="email"
              value={form.email}
              onChange={(email: string) => setForm({ ...form, email })}
              required
            />
            <Field
              label="Senha"
              type="password"
              value={form.password}
              onChange={(password: string) => setForm({ ...form, password })}
              required
            />
            {setup && <small>Use pelo menos 12 caracteres.</small>}
            {error && <div className="notice error">{error}</div>}
            <Button type="submit" disabled={busy}>
              {busy ? (
                <Loader2 className="spin" size={18} />
              ) : setup ? (
                "Criar conta e entrar"
              ) : (
                "Entrar no painel"
              )}
              <ArrowRight size={17} />
            </Button>
          </form>
          <a href="/install" className="text-link">
            Precisa de ajuda para instalar?
          </a>
        </div>
      </main>
    </div>
  );
}
export function App({managedContext}: {managedContext?:any} = {}) {
  const api=managedContext?.api || legacyApi;
  const demo = !managedContext && new URLSearchParams(location.search).has("demo");
  const [me, setMe] = useState<Row | null>(
      demo ? { name: "Administrador", role: "admin", id: "demo-user" } : null,
    ),
    [checked, setChecked] = useState(demo),
    [page, setPage] = useState(
      managedContext?.initialPage || (new URLSearchParams(location.search).has("pair")
        ? "applications"
        : "overview"),
    ),
    [profiles, setProfiles] = useState<Row[]>(demo ? [demoProfile] : []),
    [profile, setProfile] = useState(demo ? "demo" : ""),
    [pageData, setPageData] = useState<{
      scope: string;
      rows: any;
      nextCursor: string | null;
    }>({ scope: "", rows: [], nextCursor: null }),
    [overview, setOverview] = useState<any>({}),
    [bots, setBots] = useState<Row[]>([]),
    [settings, setSettings] = useState<Row>({}),
    [modal, setModal] = useState(""),
    [form, setForm] = useState<Row>({}),
    [notice, setNotice] = useState(""),
    [error, setError] = useState(""),
    [refreshError, setRefreshError] = useState(""),
    [busy, setBusy] = useState(false),
    [selection, setSelection] = useState<Row | null>(null),
    [contactEditing, setContactEditing] = useState(false),
    [reply, setReply] = useState(""),
    [search, setSearch] = useState(""),
    [departmentFilter, setDepartmentFilter] = useState(""),
    [mobile, setMobile] = useState(false),
    [section, setSection] = useState("tickets"),
    [cursor, setCursor] = useState("");
  const [ringingCalls, setRingingCalls] = useState<Row[]>([]);
  const [panelMode, setPanelMode] = useState<PanelMode>(() => {
    try {
      return localStorage.getItem("wabotia:panel-mode") === "advanced"
        ? "advanced"
        : "guided";
    } catch {
      return "guided";
    }
  });
  const [setupActive, setSetupActive] = useState(false);
  const [setupRevision, setSetupRevision] = useState(0);
  const [setupDirty, setSetupDirty] = useState(false);
  const [pendingNavigation, setPendingNavigation] = useState<{
    page?: string;
    profile?: string;
    conversation?: string;
  } | null>(null);
  const [settingsDirty, setSettingsDirty] = useState(false);
  const settingsDirtyRef = useRef(false);
  const settingsChanges = useRef<Row>({});
  settingsDirtyRef.current = settingsDirty;
  useEffect(() => {
    if (!settingsDirty && !setupDirty) return;
    const preventLoss = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", preventLoss);
    return () => window.removeEventListener("beforeunload", preventLoss);
  }, [settingsDirty, setupDirty]);
  function navigate(next: string, discard = false) {
    if(managedContext && ["users","contacts","system","queue-routing"].includes(next)){if(settingsDirty || setupDirty){setPendingNavigation({page:next});if(!discard)return;}const target:Record<string,string>={users:"/configurar?step=pessoas",contacts:"/cadastros-reais?cadastro=contacts",system:"/preferencias/sistema/atualizacoes","queue-routing":"/filas?unit="+encodeURIComponent(profile)+"&tab=configuracao"};window.location.assign(target[next]);return;}
    if (!me || !canOpenPage(next, me.role) || (managedContext && ["users","contacts","system"].includes(next))) return;
    if (next === page) {
      setMobile(false);
      return;
    }
    if (!discard && (settingsDirty || setupDirty)) {
      setPendingNavigation({ page: next });
      return;
    }
    if (next === "setup") setSetupActive(true);
    setPage(next);
    setCursor("");
    setSelection(null);
    setContactEditing(false);
    setMobile(false);
    setSearch("");
    setError("");
    setRefreshError("");
    setNotice("");
    setSettingsDirty(false);
    settingsDirtyRef.current = false;
    settingsChanges.current = {};
  }
  useEffect(()=>{if(managedContext?.initialPage) navigate(managedContext.initialPage);},[managedContext?.initialPage]);
  function chooseProfile(next: string, discard = false) {
    if (next === profile) return;
    if (!discard && (settingsDirty || setupDirty)) {
      setPendingNavigation({ profile: next });
      return;
    }
    setProfile(next);
    setDepartmentFilter("");
    setCursor("");
    setSelection(null);
    setContactEditing(false);
    setSettingsDirty(false);
    setSetupDirty(false);
    settingsDirtyRef.current = false;
    settingsChanges.current = {};
    setSettings({});
    setOverview({});
    setBots([]);
    setError("");
    setRefreshError("");
    setNotice("");
  }
  function changeMode(mode: PanelMode) {
    setPanelMode(mode);
    try {
      localStorage.setItem("wabotia:panel-mode", mode);
    } catch {
      /* optional preference */
    }
    if (
      page !== "setup" &&
      !visibleGroups(me?.role || "operator", mode).some((group) =>
        group.pages.includes(page as PageId),
      )
    )
      navigate("overview");
  }
  function editSettings(patch: Row) {
    settingsChanges.current = { ...settingsChanges.current, ...patch };
    settingsDirtyRef.current = true;
    setSettingsDirty(true);
    setSettings((current) => ({ ...current, ...patch }));
  }
  const loadScope = JSON.stringify([
    profile,
    page,
    section,
    cursor,
    departmentFilter,
    search,
  ]);
  const currentScope = useRef(loadScope);
  const latestLoad = useRef(0);
  const transferKeys = useRef(new Map<string, string>());
  currentScope.current = loadScope;
  // Never render a previous page's records as a different resource type.
  const rows = pageData.scope === loadScope ? pageData.rows : [];
  const nextCursor = pageData.scope === loadScope ? pageData.nextCursor : null;
  const setRows = (data: any, nextCursor: string | null = null) =>
    setPageData({ scope: loadScope, rows: data, nextCursor });
  const root = "v1/profiles/" + profile;
  const change = (key: string, value: any) =>
    setForm((f) => ({ ...f, [key]: value }));
  async function init() {
    try {
      setMe(await api("v1/me"));
      const p = await api("v1/profiles");
      setProfiles(p);
      setProfile((old) => old || p[0]?.id || "");
    } catch {
      setMe(null);
    } finally {
      setChecked(true);
    }
  }
  useEffect(() => {
    if (!demo) init();
  }, []);
  useEffect(() => {
    if (me && !canOpenPage(page, me.role)) setPage("overview");
  }, [me?.role, page]);
  const run = async (
    fn: () => Promise<any>,
    success = "Salvo com sucesso.",
  ) => {
    if (demo) {
      setNotice(
        "Estas são telas de referência com dados fictícios. Entre na sua instalação para salvar alterações.",
      );
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await fn();
      setNotice(success);
      return result;
    } catch (e: any) {
      if(e?.name!=='AbortError')setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  async function load() {
    const request = ++latestLoad.current;
    if (demo) {
      setOverview({
        enabled: false,
        conversations: [
          { state: "waiting", count: 1 },
          { state: "ai", count: 1 },
        ],
        connections: [],
      });
      setBots([
        {
          id: "demo-bot",
          name: "Atendente",
          remote_profile: "atendente",
          enabled: 1,
        },
      ]);
      if (!settingsDirtyRef.current) setSettings(demoProfile.settings);
      setRows(
        page === "conversations"
          ? demoConversations
          : page === "tickets"
            ? [
                {
                  id: "ticket-demo",
                  number: "WA-EXEMPLO",
                  title: "Dúvida sobre pedido",
                  status: "open",
                  created: Date.now(),
                  response_due_at: Date.now() + 86400000,
                },
              ]
            : page === "presence"
              ? [{ actor: "demo-user", name: "Administrador", present: 0 }]
              : page === "bots"
                ? [
                    {
                      id: "demo-bot",
                      name: "Atendente",
                      remote_profile: "atendente",
                      enabled: 1,
                    },
                  ]
                : page === "applications"
                  ? { applications: [], keys: [], scopes: [] }
                  : page === "reports"
                    ? { data: [], count: 0 }
                    : [],
      );
      return;
    }
    if (!profile && !["users", "applications"].includes(page)) {
      setRows([]);
      return;
    }
    try {
      const [o, b] = profile
        ? await Promise.all([api(root + "/status"), api(root + "/bots")])
        : [{}, []];
      let data: any = [];
      if (page === "users" || page === "applications")
        data = await api("v1/" + page);
      else if (page === "conversations")
        data = await api(
          root +
            "/conversations?q=" +
            encodeURIComponent(search) +
            "&department_id=" +
            encodeURIComponent(departmentFilter) +
            "&cursor=" +
            encodeURIComponent(cursor),
        );
      else if (page === "reports")
        data = await api(
          root +
            "/reports?section=" +
            section +
            "&cursor=" +
            encodeURIComponent(cursor),
        );
      else if (
        ![
          "overview",
          "settings",
          "system",
          "contacts",
          "router",
          "lines",
          "menus",
          "team",
          "setup",
        ].includes(page)
      )
        data = await api(
          root +
            "/" +
            page +
            "?cursor=" +
            encodeURIComponent(cursor) +
            (page === "tickets" ? "&q=" + encodeURIComponent(search) : ""),
        );
      if (currentScope.current !== loadScope || request !== latestLoad.current)
        return;
      setOverview(o);
      if (!settingsDirtyRef.current) setSettings(o.settings || {});
      setBots(b.data || b);
      setRows(
        page === "reports" ? data : data.data || data,
        data.next_cursor || null,
      );
      setRefreshError("");
    } catch (e: any) {
      if (e?.name!=='AbortError' && currentScope.current === loadScope && request === latestLoad.current)
        setRefreshError(e.message);
    }
  }
  useEffect(() => {
    if (me) {
      load();
      const timer = setInterval(load, 15000);
      return () => clearInterval(timer);
    }
  }, [profile, page, me, section, cursor, departmentFilter, search]);
  useEffect(() => {
    if (!me || !profile || demo) return;
    let alive = true;
    setRingingCalls([]);
    const check = async () => {
      try {
        const result = await api(root + "/calls?limit=30");
        if (alive)
          setRingingCalls(
            (result.data || []).filter(
              (call: Row) =>
                call.status === "ringing" &&
                (!call.actor || call.actor === me.id),
            ),
          );
      } catch {
        /* The panel keeps working while reconnecting. */
      }
    };
    check();
    const timer = setInterval(check, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [profile, me?.id, demo]);
  async function openConversation(row: Row) {
    if (demo) {
      setSelection({
        conversation: row,
        contact: row.contact_id
          ? demoContacts.find((c) => c.id === row.contact_id)
          : null,
        messages: [
          {
            id: 1,
            direction: "customer",
            author: "Cliente",
            text: "Olá! Preciso de ajuda com meu pedido.",
            created: Date.now() - 600000,
          },
          {
            id: 2,
            direction: "outbound",
            author: "Atendente",
            text: "Vou encaminhar sua solicitação para nossa equipe.",
            created: Date.now() - 580000,
          },
        ],
        deliveries: [],
      });
      return;
    }
    setSelection(await api(root + "/conversations/" + row.id));
  }
  function open(kind: string, values: Row = {}) {
    setForm(values);
    setModal(kind);
    setError("");
  }
  async function saveModal() {
    const result = await run(async () => {
      if (modal === "profile") return api("v1/profiles", "POST", form);
      if (modal === "user")
        return api("v1/users", "POST", {
          ...form,
          role: form.role || "operator",
          profiles: form.profiles || [profile],
        });
      if (modal === "application")
        return api("v1/applications", "POST", {
          ...form,
          profiles: form.profiles || [profile],
          scopes: form.scopes || [
            "conversations:read",
            "tickets:read",
            "bots:read",
          ],
          bots: form.bots || [],
        });
      if (modal === "key")
        return api(`v1/applications/${form.app_id}/keys`, "POST", {
          days: Number(form.days) || 90,
        });
      if (modal === "connection") {
        const config: Row = {},
          secrets: Row = {};
        config.groups_enabled = !!form.groups_enabled;
        for (const k of [
          "url",
          "api_url",
          "phone_id",
          "waba_id",
          "group",
          "number",
          "platform",
        ])
          if (form[k]) config[k] = form[k];
        for (const k of [
          "token",
          "app_secret",
          "verify_token",
          "dashboard_token",
          "access_client_id",
          "access_client_secret",
        ])
          if (form[k]) secrets[k] = form[k];
        if (form.profile_key)
          secrets.profile_keys = {
            [form.remote_profile || "default"]: form.profile_key,
          };
        if (form.profile_keys_json)
          secrets.profile_keys = JSON.parse(form.profile_keys_json);
        return api(root + "/connections", "POST", {
          id: form.id,
          name: form.name,
          kind: form.kind || "hermes",
          mode: form.kind === "hermes-whatsapp" ? "hermes" : "direct",
          config,
          secrets,
        });
      }
      if (modal === "transfer") {
        const path = root + `/conversations/${form.conversation_id}/actions`;
        const body = { action: "transfer", target: form.target };
        const intent = path + JSON.stringify(body);
        if (!transferKeys.current.has(intent))
          transferKeys.current.set(intent, crypto.randomUUID());
        try {
          const result = await api(
            path,
            "POST",
            body,
            undefined,
            transferKeys.current.get(intent),
          );
          transferKeys.current.delete(intent);
          return result;
        } catch (error: any) {
          if (
            error.status >= 400 &&
            error.status < 500 &&
            !["operation_unknown", "idempotency_conflict"].includes(error.code)
          )
            transferKeys.current.delete(intent);
          throw error;
        }
      }
      if (modal === "jev") return api(root + "/jev", "POST", { key: form.key });
      if (modal === "user-edit")
        return api("v1/users/" + form.id, "PATCH", form);
      if (modal === "knowledge") {
        let mediaId;
        const file = (
          document.querySelector("#knowledge-file") as HTMLInputElement
        )?.files?.[0];
        if (file) {
          const fd = new FormData();
          fd.set("file", file);
          mediaId = (await api(root + "/media", "POST", fd)).id;
        }
        return api(root + "/knowledge", "POST", {
          ...form,
          kind: file ? "file" : form.kind || "text",
          media_id: mediaId,
        });
      }
      if (modal === "ticket")
        return api(root + "/tickets/" + form.id, "PATCH", {
          status: form.status,
          owner: form.owner || undefined,
          text: form.text,
          response_due_at: form.deadline
            ? Date.parse(form.deadline)
            : undefined,
        });
      if (modal === "capability") {
        const next = {
          ...settings,
          capabilities: [
            ...(settings.capabilities || []),
            { ...form, id: crypto.randomUUID(), enabled: true },
          ],
        };
        return api(root + "/settings", "PUT", next);
      }
      if (modal === "menu") {
        return api(root + "/settings", "PUT", {
          ...settings,
          menus: [
            ...(settings.menus || []),
            { ...form, id: crypto.randomUUID(), enabled: true },
          ],
        });
      }
      if (modal === "reconcile-run")
        return api(root + `/bot-runs/${form.id}/reconcile`, "POST", {
          remote_id: form.remote_id,
        });
      if (modal === "reconcile-delivery")
        return api(root + `/deliveries/${form.id}/reconcile`, "POST", {
          status: form.status,
          allow_paid: form.allow_paid === true,
        });
      if (modal === "webhook")
        return api(root + "/webhook-subscriptions", "POST", {
          app_id: form.app_id,
          url: form.url,
          events: form.events || [
            "message.received",
            "ticket.updated",
            "bot.run.completed",
          ],
        });
      return {};
    });
    if (result) {
      if (result.token || result.signing_secret) {
        setForm({ token: result.token || result.signing_secret });
        setModal("secret");
      } else {
        setModal("");
        if (modal === "profile" && result.id) chooseProfile(result.id);
        setSetupRevision((revision) => revision + 1);
        await init();
        await load();
      }
    }
  }
  if (!checked)
    return (
      <div className="loading">
        <Loader2 className="spin" /> Abrindo seu atendimento...
      </div>
    );
  if (!me) return managedContext ? <p role="alert">Não foi possível abrir o atendimento. Entre novamente pelo Fagoo.</p> : <Login ready={init} />;
  const nav = sections.find((s) => s[0] === page)!;
  const groups = visibleGroups(me.role, panelMode).map(group=>({...group,pages:group.pages.filter(p=>!managedContext || !["users","contacts","system"].includes(p))})).filter(group=>group.pages.length);
  const activeGroup = groups.find((group) =>
    group.pages.includes(page as PageId),
  );
  const list = Array.isArray(rows) ? rows : [];
  const total = (overview.conversations || []).reduce(
    (a: number, b: any) => a + b.count,
    0,
  );
  const count = (state: string) =>
    (overview.conversations || []).find((x: any) => x.state === state)?.count ||
    0;
  return (
    <div className={"app-shell"+(managedContext?" fagoo-managed":"")}>
      {mobile && (
        <button
          className="mobile-nav-backdrop"
          aria-label="Fechar menu de navegação"
          onClick={() => setMobile(false)}
        />
      )}
      <aside
        id="workspace-sidebar"
        className={"sidebar " + (mobile ? "visible" : "")}
      >
        {managedContext ? <strong className="logo">Atendimento</strong> : <Logo light />}
        <div className="workspace">
          <span className="workspace-avatar">Q</span>
          <div>
            <strong>Seu atendimento</strong>
            <small>
              {profiles.find((item) => item.id === profile)?.name || (managedContext ? "Fagoo" : "Wabotia")}
            </small>
          </div>
          <ChevronDown size={15} />
        </div>
        <div className="panel-mode">
          <span>Modo do painel</span>
          <div role="group" aria-label="Modo do painel">
            <button
              aria-pressed={panelMode === "guided"}
              onClick={() => changeMode("guided")}
            >
              Simplificado
            </button>
            <button
              aria-pressed={panelMode === "advanced"}
              onClick={() => changeMode("advanced")}
            >
              Avançado
            </button>
          </div>
        </div>
        <nav aria-label="Navegação principal">
          {me.role === "admin" && (
            <button
              className={"setup-nav " + (page === "setup" ? "active" : "")}
              aria-current={page === "setup" ? "page" : undefined}
              onClick={() => navigate("setup")}
            >
              <Zap size={18} />
              <span>Configuração guiada</span>
            </button>
          )}
          {groups.map(({ id, label, icon: Icon, pages }) => (
            <button
              key={id}
              onClick={() => navigate(pages[0])}
              className={activeGroup?.id === id ? "active" : ""}
              aria-current={activeGroup?.id === id ? "page" : undefined}
            >
              <Icon size={18} />
              <span>{label}</span>
              {id === "service" && count("waiting") > 0 && (
                <b aria-label={`${count("waiting")} conversas na fila`}>
                  {count("waiting")}
                </b>
              )}
              {id === "service" && ringingCalls.length > 0 && (
                <Phone size={14} aria-label="Ligação recebida" />
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <a href="/install">
            <BookOpen size={16} /> Guia de instalação <ArrowUpRight size={14} />
          </a>
          <div className="user-card">
            <span className="avatar">{me.name[0]}</span>
            <div>
              <strong>{me.name}</strong>
              <small>
                {me.role === "admin" ? "Administrador" : "Atendente"}
              </small>
            </div>
            <button
              className="icon-button"
              aria-label="Sair"
              onClick={() =>
                run(() => api("v1/logout", "POST", {})).then(
                  () => !demo && setMe(null),
                )
              }
            >
              <LogOut size={17} />
            </button>
          </div>
        </div>
      </aside>
      <main className="main-panel">
        <header className="topbar">
          <button
            className="icon-button mobile-toggle"
            onClick={() => setMobile(!mobile)}
            aria-label="Abrir menu"
            aria-expanded={mobile}
            aria-controls="workspace-sidebar"
          >
            <Menu />
          </button>
          <div className="breadcrumbs">
            {activeGroup?.label || "Primeiros passos"}{" "}
            <ChevronRight size={14} />
            <strong>{nav[1]}</strong>
          </div>
          <div className="topbar-actions">
            <span className="connection-indicator">
              <span
                className={overview.enabled ? "online-dot" : "offline-dot"}
              />
              {overview.enabled ? "Atendimento ativo" : "Atendimento pausado"}
            </span>
            <ApiDocumentationLink title="Documentação da API">
              <Code2 size={19} />
            </ApiDocumentationLink>
            <span className="avatar small-avatar">{me.name[0]}</span>
          </div>
        </header>
        {demo && (
          <div className="demo-banner">
            TELAS DE REFERÊNCIA · Dados fictícios. Nenhuma mensagem real é
            enviada.
          </div>
        )}
        <div className="page-content">
          {ringingCalls.length > 0 &&
            !(
              page === "conversations" &&
              selection?.conversation.id === ringingCalls[0].conversation_id
            ) && (
              <div className="notice" role="status">
                <Phone size={18} /> Você está recebendo uma ligação pelo
                WhatsApp.{" "}
                <button
                  onClick={() => {
                    if (settingsDirty || setupDirty) {
                      setPendingNavigation({
                        page: "conversations",
                        conversation: ringingCalls[0].conversation_id,
                      });
                      return;
                    }
                    navigate("conversations");
                    openConversation({
                      id: ringingCalls[0].conversation_id,
                    }).catch((e) => setError(e.message));
                  }}
                >
                  Abrir ligação
                </button>
              </div>
            )}
          <div className="page-heading">
            <div>
              <div className="eyebrow">SEU CENTRO DE ATENDIMENTO</div>
              <h1>{nav[1]}</h1>
              <p>
                {pageDescriptions[page as PageId] ||
                  "Organize seu atendimento com clareza."}
              </p>
            </div>
            <div className="heading-actions">
              <select
                aria-label="Perfil de atendimento"
                value={profile}
                onChange={(e) => chooseProfile(e.target.value)}
              >
                <option value="">Escolha um perfil</option>
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              {me.role === "admin" && (
                <button
                  className="icon-button"
                  title="Novo perfil"
                  onClick={() => open("profile")}
                >
                  <Plus size={19} />
                </button>
              )}
            </div>
          </div>
          {activeGroup && activeGroup.pages.length > 1 && (
            <nav
              className="workspace-tabs"
              aria-label={`Áreas de ${activeGroup.label}`}
            >
              {activeGroup.pages.map((id) => {
                const [, label, Icon] = sections.find(
                  (item) => item[0] === id,
                )!;
                return (
                  <button
                    key={id}
                    aria-current={page === id ? "page" : undefined}
                    onClick={() => navigate(id)}
                  >
                    <Icon size={16} />
                    {label}
                    {id === "calls" && ringingCalls.length > 0 && (
                      <b>{ringingCalls.length}</b>
                    )}
                  </button>
                );
              })}
            </nav>
          )}
          {setupActive && page !== "setup" && me.role === "admin" && (
            <div className="setup-return">
              <span>
                Você abriu uma etapa da configuração. Ao terminar, continue pelo
                assistente.
              </span>
              <button className="text-link" onClick={() => navigate("setup")}>
                Voltar à configuração guiada <ArrowRight size={14} />
              </button>
              <button
                className="icon-button"
                aria-label="Fechar lembrete de configuração"
                onClick={() => setSetupActive(false)}
              >
                <X size={15} />
              </button>
            </div>
          )}
          {(error || refreshError) && (
            <div role="alert" className="notice error">
              {error || refreshError}
              <button onClick={() => {setError("");setRefreshError("");}}>
                <X size={15} />
              </button>
            </div>
          )}
          {notice && (
            <div role="status" className="notice">
              {notice}
              <button onClick={() => setNotice("")}>
                <X size={15} />
              </button>
            </div>
          )}
          {!profile &&
          !["users", "applications", "system", "setup"].includes(page) ? (
            <div className="card">
              <Empty
                title="Vamos criar seu primeiro perfil?"
                description="Um perfil organiza os bots, os canais e a equipe de um atendimento."
              />
              {me.role === "admin" ? (
                <Button onClick={() => navigate("setup")}>
                  <Zap size={17} /> Começar configuração guiada
                </Button>
              ) : (
                <p>
                  Peça ao administrador para liberar seu acesso a um perfil.
                </p>
              )}
            </div>
          ) : (
            <>
              {page === "setup" && me.role === "admin" && (
                <SetupWizard
                  key={profile}
                  api={api}
                  root={root}
                  demo={demo}
                  hasProfile={!!profile}
                  onNavigate={navigate}
                  onConnect={(kind: string) => open("connection", { kind })}
                  onCreateProfile={() => open("profile")}
                  onRefresh={load}
                  refreshKey={setupRevision}
                  onDirtyChange={setSetupDirty}
                />
              )}
              {page === "system" && me.role === "admin" && (
                <SystemPanel api={api} demo={demo} />
              )}
              {page === "router" && me.role === "admin" && (
                <NumberRouter key={profile} api={api} root={root} demo={demo} />
              )}
              {page === "lines" && me.role === "admin" && (
                <LinesPanel key={profile} api={api} root={root} demo={demo} />
              )}
              {page === "menus" && me.role === "admin" && (
                <MenusPanel key={profile} api={api} root={root} demo={demo} />
              )}
              {page === "team" && (
                <TeamPanel
                  key={profile}
                  api={api}
                  root={root}
                  demo={demo}
                  me={me}
                />
              )}
              {page === "contacts" && (
                <ContactsPanel
                  key={profile}
                  api={api}
                  root={root}
                  demo={demo}
                  openConversation={(row) => {
                    setPage("conversations");
                    setSearch("");
                    setCursor("");
                    openConversation(row).catch((e) => setError(e.message));
                  }}
                />
              )}
              {page === "overview" && (
                <>
                  {me.role === "admin" && (
                    <section className="card welcome-card">
                      <div>
                        <h2>
                          {overview.enabled
                            ? "Seu atendimento, em um só lugar"
                            : "Vamos preparar seu atendimento?"}
                        </h2>
                        <p>
                          Conecte o WhatsApp, escolha quem atende e organize os
                          caminhos do cliente. O assistente acompanha cada
                          etapa.
                        </p>
                      </div>
                      <Button onClick={() => navigate("setup")}>
                        <Zap size={17} /> Abrir configuração guiada
                      </Button>
                    </section>
                  )}
                  <div className="workspace-quick-actions">
                    {[
                      [
                        "conversations",
                        MessageCircle,
                        "Atender clientes",
                        "Abra as conversas e assuma quem aguarda na fila.",
                      ],
                      [
                        "tickets",
                        FileText,
                        "Acompanhar protocolos",
                        "Veja solicitações e prazos de resposta.",
                      ],
                      [
                        "presence",
                        Headphones,
                        "Marcar disponibilidade",
                        "Avise a equipe quando você pode atender.",
                      ],
                    ].map(([target, Icon, title, description]: any) => (
                      <button key={target} onClick={() => navigate(target)}>
                        <Icon size={21} />
                        <span>
                          <strong>{title}</strong>
                          <small>{description}</small>
                        </span>
                      </button>
                    ))}
                  </div>
                  <div className="metric-grid">
                    {[
                      [
                        MessageCircle,
                        "Conversas",
                        total,
                        "Todos os atendimentos",
                      ],
                      [
                        Headphones,
                        "Aguardando equipe",
                        count("waiting"),
                        "Prontas para assumir",
                      ],
                      [Bot, "Com o bot", count("ai"), "Atendidas pelos bots"],
                      [
                        Check,
                        "Concluídas",
                        count("closed"),
                        "Conversas resolvidas",
                      ],
                    ].map(([Icon, label, value, sub]: any) => (
                      <div className="metric-card" key={label}>
                        <div>
                          <span>{label}</span>
                          <Icon size={19} />
                        </div>
                        <strong>{value}</strong>
                        <small>{sub}</small>
                      </div>
                    ))}
                  </div>
                  <div className="overview-grid">
                    <section className="card getting-started">
                      <div className="section-heading">
                        <div>
                          <h2>Como o atendimento funciona</h2>
                          <p>Cada parte tem um papel claro.</p>
                        </div>
                        <span className="soft-icon">
                          <Zap size={20} />
                        </span>
                      </div>
                      <div
                        className="service-flow"
                        aria-label="Fluxo de atendimento"
                      >
                        <span>Cliente no WhatsApp</span>
                        <ArrowRight size={16} />
                        <span>Menu ou Bot Atendente</span>
                        <ArrowRight size={16} />
                        <span>Resposta ou equipe humana</span>
                      </div>
                      <p className="workspace-help">
                        O Atendente pode consultar especialistas pelo Hermes,
                        como o bot financeiro do Fagoo, e trazer o resultado
                        para o cliente. As credenciais dos sistemas ficam com os
                        especialistas.
                      </p>
                      <p className="workspace-help">
                        Quando a equipe está ausente, uma solicitação
                        encaminhada gera um protocolo para acompanhamento.
                      </p>
                    </section>
                    <section className="card status-card">
                      <div className="section-heading">
                        <h2>Suas conexões</h2>
                        <Link2 size={18} />
                      </div>
                      {overview.connections?.length ? (
                        overview.connections.map((co: any) => (
                          <div className="connection-row" key={co.id}>
                            <div>
                              <strong>{co.name}</strong>
                              <small>{co.kind}</small>
                            </div>
                            <Badge value={co.status} />
                          </div>
                        ))
                      ) : (
                        <Empty
                          title="O primeiro elo começa aqui"
                          description="Conecte o Hermes e seus canais para acompanhar o estado de cada serviço."
                        />
                      )}
                      {me.role === "admin" && (
                        <Button
                          secondary
                          onClick={() => navigate("connections")}
                        >
                          Conferir canais <ArrowRight size={16} />
                        </Button>
                      )}
                    </section>
                  </div>
                  <div className="bottom-note">
                    <ShieldCheck size={18} />
                    <span>
                      Você tem o controle. Assumir uma conversa pausa as
                      respostas da IA.
                    </span>
                    <ApiDocumentationLink>
                      Conheça a API <ArrowUpRight size={14} />
                    </ApiDocumentationLink>
                  </div>
                </>
              )}
              {page === "conversations" && (
                <div className="inbox-layout">
                  <section className="card inbox-list">
                    <div className="search-box">
                      <Search size={17} />
                      <input
                        placeholder="Buscar cliente ou telefone"
                        value={search}
                        onChange={(e) => {
                          setSearch(e.target.value);
                          setCursor("");
                        }}
                        onKeyDown={(e) => e.key === "Enter" && load()}
                      />
                    </div>
                    {(settings.departments || []).length > 0 && (
                      <label className="field">
                        Setor de atendimento
                        <select
                          aria-label="Filtrar conversas por setor"
                          value={departmentFilter}
                          onChange={(e) => {
                            setDepartmentFilter(e.target.value);
                            setCursor("");
                          }}
                        >
                          <option value="">Todos os setores</option>
                          {(settings.departments || []).map((d: Row) => (
                            <option key={d.id} value={d.id}>
                              {d.name}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                    {list.length ? (
                      list.map((row) => (
                        <button
                          className={
                            "conversation-row " +
                            (selection?.conversation.id === row.id
                              ? "selected"
                              : "")
                          }
                          key={row.id}
                          onClick={() => openConversation(row)}
                        >
                          <span className="avatar">
                            {String(row.phone || row.external_id || "?").slice(
                              -2,
                            )}
                          </span>
                          <div>
                            <strong>
                              {row.title ||
                                row.contact_name ||
                                row.phone ||
                                row.external_id}
                            </strong>
                            <small>{date(row.updated)}</small>
                            {row.department_id && (
                              <small>
                                {(settings.departments || []).find(
                                  (d: Row) => d.id === row.department_id,
                                )?.name || "Setor indisponível"}
                              </small>
                            )}
                          </div>
                          <Badge value={row.state} />
                        </button>
                      ))
                    ) : (
                      <Empty
                        title="Sua caixa de entrada está pronta"
                        description="As mensagens dos canais conectados aparecerão aqui."
                      />
                    )}
                  </section>
                  <section className="card conversation-detail">
                    {selection ? (
                      <>
                        <header>
                          <div>
                            <h2>
                              {selection.conversation.title ||
                                selection.contact?.name ||
                                selection.conversation.phone ||
                                selection.conversation.external_id}
                            </h2>
                            <Badge value={selection.conversation.state} />
                          </div>
                          <div className="contact-actions">
                            <Button
                              secondary
                              disabled={
                                selection.conversation.chat_type === "group"
                              }
                              onClick={() => setContactEditing(true)}
                            >
                              {selection.contact
                                ? "Editar contato"
                                : "Salvar contato"}
                            </Button>
                            <Button
                              secondary
                              disabled={busy}
                              onClick={() =>
                                run(() =>
                                  api(
                                    root +
                                      `/conversations/${selection.conversation.id}/actions`,
                                    "POST",
                                    { action: "claim" },
                                  ),
                                ).then(() =>
                                  openConversation(selection.conversation),
                                )
                              }
                            >
                              Assumir conversa
                            </Button>
                          </div>
                        </header>
                        <WhatsAppConversation
                          key={selection.conversation.id}
                          selection={selection}
                          api={api}
                          root={root}
                          me={me}
                          refresh={() =>
                            openConversation(selection.conversation)
                          }
                          demo={demo}
                        />
                        {selection.conversation.chat_type === "group" &&
                          !demo && (
                            <GroupControls
                              api={api}
                              root={root}
                              c={selection.conversation}
                              refresh={() =>
                                openConversation(selection.conversation)
                              }
                            />
                          )}
                        <div className="reply-box">
                          <div className="inline-links">
                            <button
                              onClick={() =>
                                (demo
                                  ? Promise.resolve({
                                      data: [
                                        {
                                          id: "demo-person",
                                          name: "Ana",
                                          online: false,
                                          kind: "user",
                                        },
                                        {
                                          id: "bot:demo-bot",
                                          name: "Atendente",
                                          online: true,
                                          kind: "bot",
                                        },
                                      ],
                                    })
                                  : api(root + "/team")
                                )
                                  .then(({ data }:any) =>
                                    open("transfer", {
                                      conversation_id:
                                        selection.conversation.id,
                                      people: data.map((contact: Row) => ({
                                        ...contact,
                                        actor: contact.id,
                                        present: contact.online,
                                        name: `${contact.name} · ${contact.kind === "bot" ? "Bot" : "Pessoa"} · ${contact.online ? "Online" : "Offline"}`,
                                      })),
                                    }),
                                  )
                                  .catch((e: Error) => setError(e.message))
                              }
                            >
                              Transferir
                            </button>
                            {[
                              ["resolve", "Concluir"],
                              ["resume", "Retomar IA"],
                            ].map(([action, label]) => (
                              <button
                                key={action}
                                onClick={() =>
                                  run(() =>
                                    api(
                                      root +
                                        `/conversations/${selection.conversation.id}/actions`,
                                      "POST",
                                      { action },
                                    ),
                                  ).then(() =>
                                    openConversation(selection.conversation),
                                  )
                                }
                              >
                                {label}
                              </button>
                            ))}
                            <button
                              onClick={() =>
                                run(() =>
                                  api(root + "/tickets", "POST", {
                                    conversation_id: selection.conversation.id,
                                    title: "Solicitação de atendimento",
                                  }),
                                )
                              }
                            >
                              Abrir protocolo
                            </button>
                            {selection.conversation.chat_type !== "group" && (
                              <button
                                onClick={() =>
                                  run(() =>
                                    api(root + "/consents/request", "POST", {
                                      conversation_id:
                                        selection.conversation.id,
                                    }),
                                  )
                                }
                              >
                                Solicitar consentimento
                              </button>
                            )}
                          </div>
                          <ConversationMenu
                            key={selection.conversation.id}
                            api={api}
                            root={root}
                            demo={demo}
                            conversation={selection.conversation}
                            refresh={() =>
                              openConversation(selection.conversation)
                            }
                          />
                        </div>
                      </>
                    ) : (
                      <Empty
                        title="Cada conversa tem uma história"
                        description="Selecione um atendimento para ver o contexto e responder."
                      />
                    )}
                  </section>
                </div>
              )}
              {page === "groups" && (
                <WhatsAppGroups
                  api={api}
                  root={root}
                  rows={list}
                  demo={demo}
                  openConversation={(row) => {
                    setPage("conversations");
                    openConversation(row);
                  }}
                />
              )}
              {page === "calls" && (
                <section className="card">
                  <h2>Ligações de voz</h2>
                  <p>
                    Chamadas pela Meta. Abra a conversa para atender, ligar ou
                    consultar o histórico.
                  </p>
                  {list.length ? (
                    list.map((row) => (
                      <button
                        className="call-history-row"
                        key={row.id}
                        onClick={() => {
                          setPage("conversations");
                          openConversation({ id: row.conversation_id });
                        }}
                      >
                        <strong>{callStatus[row.status] || row.status}</strong>
                        <span>
                          {row.direction === "inbound"
                            ? "Recebida"
                            : "Realizada"}{" "}
                          · {date(row.created)}
                        </span>
                        <span>Abrir conversa →</span>
                      </button>
                    ))
                  ) : (
                    <p>Nenhuma ligação registrada.</p>
                  )}
                </section>
              )}
              {page === "connections" && (
                <>
                  <div className="callout">
                    <Plug size={22} />
                    <div>
                      <strong>Um lugar para cada conexão</strong>
                      <p>
                        Cadastre o Hermes para usar seus bots e o Telegram para
                        a equipe humana. A conta Meta e seus telefones ficam em{" "}
                        <button
                          className="text-link"
                          onClick={() => navigate("router")}
                        >
                          Conta Meta e números
                        </button>
                        .
                      </p>
                    </div>
                  </div>
                  <details className="workspace-disclosure">
                    <summary>
                      Meu Hermes está no computador ou em uma rede privada
                    </summary>
                    <CloudflareDeploy
                      key={profile}
                      api={api}
                      demo={demo}
                      profile={profile}
                      openSystem={() => setPage("system")}
                      refreshConnections={load}
                    />
                  </details>
                  <div className="toolbar">
                    <p>
                      Hermes fornece a inteligência. Os canais trazem as
                      conversas.
                    </p>
                    {panelMode === "guided" ? (
                      <div className="card-actions">
                        <Button
                          onClick={() => open("connection", { kind: "hermes" })}
                        >
                          <Bot size={17} /> Conectar Hermes
                        </Button>
                        <Button
                          secondary
                          onClick={() =>
                            open("connection", { kind: "telegram" })
                          }
                        >
                          <Send size={17} /> Conectar Telegram
                        </Button>
                      </div>
                    ) : (
                      <Button
                        onClick={() => open("connection", { kind: "hermes" })}
                      >
                        <Plus size={17} /> Nova conexão
                      </Button>
                    )}
                  </div>
                  <div className="cards-grid">
                    {list.map((row) => (
                      <section className="card integration-card" key={row.id}>
                        <div className="section-heading">
                          <span className="integration-icon">
                            {row.kind === "hermes" ? <Bot /> : <Plug />}
                          </span>
                          <Badge value={row.status} />
                        </div>
                        <h2>{row.name}</h2>
                        {parse(row.config).qr && (
                          <img
                            className="qr-image"
                            src={parse(row.config).qr}
                            alt="Leia o código com o WhatsApp para conectar"
                          />
                        )}
                        <button
                          className="text-link"
                          onClick={() =>
                            row.kind === "meta" &&
                            parse(row.config).meta_account_id
                              ? navigate("router")
                              : open("connection", {
                                  ...row,
                                  ...parse(row.config),
                                })
                          }
                        >
                          Editar conexão
                        </button>
                        <p>
                          {row.kind === "hermes"
                            ? "Bots e ferramentas"
                            : row.kind === "telegram"
                              ? "Equipe humana via Telegram"
                              : row.kind === "meta"
                                ? "WhatsApp Cloud API"
                                : row.kind === "qr"
                                  ? "WhatsApp por QR"
                                  : "WhatsApp pelo Hermes"}
                        </p>
                        <small>Último contato: {date(row.last_seen)}</small>
                        <ConnectionDiagnostics
                          hermes={row.kind === "hermes"}
                          demo={demo}
                          disabled={busy}
                          request={(action, signal) =>
                            api(
                              root + `/connections/${row.id}/${action}`,
                              "POST",
                              {},
                              signal,
                            )
                          }
                          refresh={load}
                          showBots={() => {
                            setPage("bots");
                            setCursor("");
                            setError("");
                          }}
                        >
                          <Button
                            secondary
                            onClick={() =>
                              run(() =>
                                api(
                                  root + `/connections/${row.id}/state`,
                                  "PUT",
                                  {
                                    status:
                                      row.status === "active"
                                        ? "paused"
                                        : "active",
                                  },
                                ),
                              ).then(load)
                            }
                          >
                            {row.status === "active" ? "Pausar" : "Ativar"}
                          </Button>
                        </ConnectionDiagnostics>
                        {row.kind === "telegram" && (
                          <button
                            className="text-link"
                            onClick={() =>
                              run(
                                () =>
                                  api(
                                    root +
                                      `/connections/${row.id}/telegram-webhook`,
                                    "POST",
                                    {},
                                  ),
                                "Webhook configurado.",
                              )
                            }
                          >
                            Ligar recebimento Telegram
                          </button>
                        )}
                        {row.kind === "meta" && (
                          <div className="call-configuration">
                            <p>
                              Ligações de voz exigem habilitação pela Meta,
                              permissão do aplicativo e assinatura do webhook{" "}
                              <code>calls</code>. O áudio será atendido no
                              navegador.
                            </p>
                            <Button
                              secondary
                              disabled={busy}
                              onClick={() =>
                                run(() =>
                                  api(
                                    root + `/connections/${row.id}/calling`,
                                    "PUT",
                                    {
                                      enabled: !parse(row.config)
                                        .calling_enabled,
                                    },
                                  ),
                                ).then(load)
                              }
                            >
                              {parse(row.config).calling_enabled
                                ? "Desabilitar ligações"
                                : "Habilitar ligações de voz"}
                            </Button>
                          </div>
                        )}
                        {["qr", "hermes-whatsapp"].includes(row.kind) && (
                          <button
                            className="text-link"
                            onClick={() =>
                              run(() =>
                                api(
                                  root +
                                    `/connections/${row.id}/connector-token`,
                                  "POST",
                                  {},
                                ),
                              ).then((r) => {
                                if (r) open("secret", { token: r.token });
                              })
                            }
                          >
                            Gerar chave do conector
                          </button>
                        )}
                        {row.kind === "meta" && (
                          <div className="resource-id">
                            <span>
                              Webhook Meta: {location.origin}
                              {parse(row.config).meta_account_id
                                ? "/webhooks/meta-accounts/" +
                                  parse(row.config).meta_account_id
                                : "/webhooks/meta/" + row.id}
                            </span>
                            <CopyButton
                              value={
                                location.origin +
                                (parse(row.config).meta_account_id
                                  ? "/webhooks/meta-accounts/" +
                                    parse(row.config).meta_account_id
                                  : "/webhooks/meta/" + row.id)
                              }
                            />
                          </div>
                        )}
                        {panelMode === "advanced" && (
                          <small className="resource-id">
                            ID: {row.id} <CopyButton value={row.id} />
                          </small>
                        )}
                      </section>
                    ))}
                  </div>
                  {!list.length && (
                    <section className="card">
                      <Empty
                        title="Conecte seu primeiro serviço"
                        description="Comece pelo Hermes. Depois configure WhatsApp e Telegram."
                      />
                    </section>
                  )}
                </>
              )}
              {page === "bots" && (
                <>
                  <section className="card">
                    <h2>O Atendente conversa. Os especialistas executam.</h2>
                    <p className="workspace-help">
                      Escolha um bot principal para receber o cliente. Em uma
                      ação interna, ele consulta outro bot do Hermes e recebe o
                      resultado para responder. Por exemplo: o especialista
                      financeiro do Fagoo usa suas próprias credenciais para
                      buscar a segunda via de um boleto.
                    </p>
                    <div className="service-flow">
                      <span>Bot Atendente</span>
                      <ArrowRight size={16} />
                      <span>Especialista no Hermes</span>
                      <ArrowRight size={16} />
                      <span>API do sistema</span>
                    </div>
                  </section>
                  <div className="toolbar">
                    <p>
                      Selecione os bots criados no Hermes. Permissões continuam
                      no perfil original.
                    </p>
                    <Button onClick={() => open("capability")}>
                      <Plus size={17} /> Ação de especialista
                    </Button>
                  </div>
                  <div className="cards-grid">
                    {bots.map((bot) => (
                      <section className="card" key={bot.id}>
                        <div className="section-heading">
                          <span className="integration-icon">
                            <Bot />
                          </span>
                          <Badge value={bot.enabled ? "enabled" : "disabled"} />
                        </div>
                        <h2>{bot.name}</h2>
                        <p>Perfil Hermes: {bot.remote_profile}</p>
                        <Button
                          secondary
                          onClick={() =>
                            run(() =>
                              api(root + "/bots/" + bot.id, "PATCH", {
                                enabled: !bot.enabled,
                              }),
                            ).then(load)
                          }
                        >
                          {bot.enabled ? "Desabilitar" : "Habilitar"}
                        </Button>
                        <button
                          className="text-link block"
                          onClick={() =>
                            run(() =>
                              api(root + "/settings", "PUT", {
                                ...settings,
                                attendant_bot: bot.id,
                              }),
                            ).then(load)
                          }
                        >
                          {settings.attendant_bot === bot.id
                            ? "✓ Bot Atendente selecionado"
                            : "Usar como Bot Atendente"}
                        </button>
                        {panelMode === "advanced" && (
                          <small className="resource-id">
                            {bot.id}
                            <CopyButton value={bot.id} />
                          </small>
                        )}
                        {me.role === "admin" && (
                          <BotLinesEditor
                            key={bot.id}
                            bot={bot}
                            api={api}
                            root={root}
                            demo={demo}
                          />
                        )}
                      </section>
                    ))}
                  </div>
                  {!bots.length && (
                    <div className="card">
                      <Empty
                        title="Sua Equipe Bot começa no Hermes"
                        description="Cadastre a conexão Hermes e use Descobrir bots."
                      />
                    </div>
                  )}
                  <section className="card">
                    <h2>Ações internas permitidas</h2>
                    {(settings.capabilities || []).map((a: any) => (
                      <div className="connection-row" key={a.id}>
                        <div>
                          <strong>{a.name}</strong>
                          <small>{a.condition}</small>
                        </div>
                        <Button
                          secondary
                          onClick={() =>
                            run(() =>
                              api(root + "/settings", "PUT", {
                                ...settings,
                                capabilities: settings.capabilities.filter(
                                  (x: any) => x.id !== a.id,
                                ),
                              }),
                            ).then(load)
                          }
                        >
                          Remover
                        </Button>
                      </div>
                    ))}
                    {!settings.capabilities?.length && (
                      <p>
                        Adicione uma ação para permitir que o Atendente consulte
                        um especialista.
                      </p>
                    )}
                  </section>
                </>
              )}
              {page === "knowledge" && (
                <>
                  <div className="toolbar">
                    <p>Informações confiáveis para fundamentar as respostas.</p>
                    <Button onClick={() => open("knowledge", { kind: "text" })}>
                      <Plus size={17} /> Adicionar fonte
                    </Button>
                  </div>
                  <section className="card">
                    {list.length ? (
                      <Table
                        rows={list}
                        columns={[
                          ["title", "Fonte"],
                          ["kind", "Tipo"],
                          ["status", "Estado"],
                          ["error", "Observação"],
                        ]}
                        action={(row: Row) => (
                          <button
                            className="text-link"
                            onClick={() =>
                              run(() =>
                                api(root + "/knowledge/" + row.id, "DELETE"),
                              ).then(load)
                            }
                          >
                            Remover
                          </button>
                        )}
                      />
                    ) : (
                      <Empty
                        title="Conhecimento que ajuda de verdade"
                        description="Cadastre textos, páginas ou documentos para sua equipe de bots consultar."
                      />
                    )}
                  </section>
                </>
              )}
              {page === "tickets" && (
                <section className="card">
                  <div className="section-heading">
                    <h2>Protocolos de atendimento</h2>
                    <span className="muted">{list.length} registros</span>
                  </div>
                  <div className="search-box">
                    <Search size={17} />
                    <input
                      aria-label="Buscar protocolos"
                      placeholder="Número do protocolo ou telefone do cliente"
                      value={search}
                      onChange={(e) => {
                        setSearch(e.target.value);
                        setCursor("");
                      }}
                    />
                  </div>
                  {list.length ? (
                    <Table
                      rows={list}
                      columns={[
                        ["number", "Protocolo"],
                        ["title", "Solicitação"],
                        ["status", "Estado"],
                        ["response_due_at", "Prazo"],
                        ["created", "Abertura"],
                      ]}
                      action={(row: Row) => (
                        <Button secondary onClick={() => open("ticket", row)}>
                          Atualizar
                        </Button>
                      )}
                    />
                  ) : (
                    <Empty
                      title="Solicitações acompanhadas do começo ao fim"
                      description="Abra um protocolo a partir de uma conversa. Solicitações sem humanos disponíveis também geram protocolos."
                    />
                  )}
                </section>
              )}
              {page === "presence" && (
                <>
                  <div className="callout">
                    <Headphones />
                    <div>
                      <strong>Presença é uma escolha da equipe</strong>
                      <p>
                        Ficar online no painel não marca presença
                        automaticamente. Sem atendentes presentes, o cliente
                        recebe um protocolo.
                      </p>
                    </div>
                  </div>
                  <section className="card">
                    {list.map((row) => (
                      <div className="presence-row" key={row.actor}>
                        <span className="avatar">{row.name[0]}</span>
                        <div>
                          <strong>{row.name}</strong>
                          <small>
                            {row.telegram_id
                              ? "Telegram vinculado"
                              : "Atendimento pelo painel"}
                          </small>
                        </div>
                        <Badge value={row.present ? "active" : "paused"} />
                        {row.actor === me.id && (
                          <Button
                            secondary
                            onClick={() =>
                              run(() =>
                                api(root + "/presence", "PUT", {
                                  present: !row.present,
                                }),
                              ).then(load)
                            }
                          >
                            {row.present
                              ? "Marcar ausência"
                              : "Estou disponível"}
                          </Button>
                        )}
                      </div>
                    ))}
                  </section>
                </>
              )}
              {page === "settings" && (
                <div className="settings-layout">
                  <section className="card">
                    <h2>Como sua equipe atende</h2>
                    <Field
                      label="Orientações para o Bot Atendente"
                      type="textarea"
                      value={settings.instructions}
                      onChange={(v: string) =>
                        editSettings({ instructions: v })
                      }
                    />
                    <Field
                      label="Orientação quando não há humanos presentes"
                      type="textarea"
                      value={settings.absence_instructions}
                      onChange={(v: string) =>
                        editSettings({ absence_instructions: v })
                      }
                    />
                    <Field
                      label="Prazo padrão de primeira resposta (horas)"
                      type="number"
                      value={settings.protocol_response_hours}
                      onChange={(v: string) =>
                        editSettings({
                          protocol_response_hours: v === "" ? null : Number(v),
                        })
                      }
                    />
                    <Field
                      label="Respostas no Telegram"
                      options={[
                        ["command", "Comando /responder"],
                        ["direct", "Texto direto após assumir"],
                      ]}
                      value={settings.reply_mode}
                      onChange={(v: string) => editSettings({ reply_mode: v })}
                    />
                    <Field
                      label="Conexão para a equipe no Telegram"
                      options={(overview.connections || []).filter(
                        (connection: Row) => connection.kind === "telegram",
                      )}
                      value={settings.telegram_connection}
                      onChange={(v: string) =>
                        editSettings({ telegram_connection: v })
                      }
                    />
                    <Field
                      label="ID do grupo Telegram"
                      value={settings.telegram_group}
                      onChange={(v: string) =>
                        editSettings({ telegram_group: v })
                      }
                    />
                    <label className="check-field">
                      <input
                        type="checkbox"
                        checked={!!settings.surveys_enabled}
                        onChange={(e) =>
                          editSettings({
                            surveys_enabled: e.target.checked,
                          })
                        }
                      />{" "}
                      Pedir avaliação ao concluir
                    </label>
                    <label className="check-field">
                      <input
                        type="checkbox"
                        checked={!!settings.jev_enabled}
                        onChange={(e) =>
                          editSettings({ jev_enabled: e.target.checked })
                        }
                      />
                      Usar JEV na tomada de decisão
                    </label>
                    <p className="workspace-help">
                      Desligado: o Bot Atendente decide os encaminhamentos.
                      Ligado: o Atendente interpreta a solicitação e propõe uma
                      ação; o JEV decide se ela pode seguir, se é preciso
                      esclarecer ou encaminhar para uma pessoa. Se a decisão
                      falhar ou for incerta, o atendimento vai para a equipe
                      humana.
                    </p>
                    <button
                      className="text-link block"
                      onClick={() => open("jev")}
                    >
                      Cadastrar ou substituir chave JEV
                    </button>
                    <Button
                      disabled={busy || !settingsDirty}
                      onClick={async () => {
                        const patch = { ...settingsChanges.current };
                        const scope = loadScope;
                        const saved = await run(() =>
                          api(root + "/settings", "PUT", patch),
                        );
                        if (saved && currentScope.current === scope) {
                          for (const key of Object.keys(patch)) {
                            if (settingsChanges.current[key] === patch[key])
                              delete settingsChanges.current[key];
                          }
                          settingsDirtyRef.current =
                            Object.keys(settingsChanges.current).length > 0;
                          setSettingsDirty(settingsDirtyRef.current);
                          await load();
                        }
                      }}
                    >
                      {busy ? "Salvando…" : "Salvar regras"}
                    </Button>
                    {settingsDirty && (
                      <p className="workspace-help" role="status">
                        Há alterações ainda não salvas.
                      </p>
                    )}
                  </section>
                  <section>
                    <div className="card">
                      <h2>Estado do atendimento</h2>
                      <p>
                        Confira bots, canais e conhecimento antes de ativar.
                      </p>
                      <Button
                        disabled={busy || settingsDirty}
                        onClick={() =>
                          run(() =>
                            api(
                              root +
                                (overview.enabled ? "/pause" : "/activate"),
                              "POST",
                              {},
                            ),
                          ).then(load)
                        }
                      >
                        {overview.enabled
                          ? "Pausar atendimento"
                          : "Ativar atendimento"}
                      </Button>
                    </div>
                    <div className="card">
                      <h2>Precisa de orientação?</h2>
                      <p>
                        O assistente ajuda a conectar os serviços e conferir
                        cada parte antes de ativar o atendimento.
                      </p>
                      <Button secondary onClick={() => navigate("setup")}>
                        Abrir configuração guiada
                      </Button>
                    </div>
                  </section>
                </div>
              )}
              {page === "users" && (
                <>
                  <div className="toolbar">
                    <p>Acesso individual, responsabilidade clara.</p>
                    <Button onClick={() => open("user", { role: "operator" })}>
                      <Plus size={17} /> Adicionar pessoa
                    </Button>
                  </div>
                  <section className="card">
                    <Table
                      rows={list}
                      columns={[
                        ["name", "Pessoa"],
                        ["email", "E-mail"],
                        ["role", "Papel"],
                        ["telegram_id", "Telegram"],
                      ]}
                      action={(row: Row) => (
                        <div className="card-actions">
                          <Button
                            secondary
                            onClick={() =>
                              open("user-edit", {
                                ...row,
                                profiles: parse(row.profiles, []),
                              })
                            }
                          >
                            Editar
                          </Button>
                          <Button
                            secondary
                            onClick={() =>
                              run(() =>
                                api("v1/users/" + row.id, "PATCH", {
                                  disabled: !row.disabled,
                                }),
                              ).then(load)
                            }
                          >
                            {row.disabled ? "Ativar" : "Desativar"}
                          </Button>
                        </div>
                      )}
                    />
                  </section>
                </>
              )}
              {page === "applications" && (
                <>
                  {!managedContext && <PairingPanel api={api} demo={demo} profiles={profiles} />}
                  <section className="card integration-explainer">
                    <h2>Depois de conectar</h2>
                    <p>
                      {managedContext ? "Para as filas, autorize as linhas e os grupos em " : "Para o Vinki, autorize as linhas e os grupos em "}
                      <strong>
                        Conta Meta e números → Acesso dos sistemas
                      </strong>
                      . Para consultas internas do Fagoo, configure um
                      especialista no Hermes e uma ação permitida para o
                      Atendente.
                    </p>
                    <div className="card-actions">
                      <Button secondary onClick={() => navigate("router")}>
                        Configurar linhas e distribuição
                      </Button>
                      <Button secondary onClick={() => navigate("bots")}>
                        Configurar especialista Hermes
                      </Button>
                    </div>
                  </section>
                  <details className="card" open={panelMode === "advanced"}>
                    <summary>Integração manual pela API · avançado</summary>
                    <div className="toolbar">
                      <p>
                        Crie chaves com as permissões necessárias para cada
                        sistema.
                      </p>
                      <Button onClick={() => open("application")}>
                        <Plus size={17} /> Nova aplicação
                      </Button>
                    </div>
                    <section className="card">
                      {rows.applications?.length ? (
                        <Table
                          rows={rows.applications}
                          columns={[
                            ["name", "Aplicação"],
                            ["rate", "Requisições/min"],
                            ["run_limit", "Execuções simultâneas"],
                          ]}
                          action={(row: Row) => (
                            <div className="card-actions">
                              <Button
                                secondary
                                onClick={() =>
                                  run(() =>
                                    api("v1/applications/" + row.id, "PATCH", {
                                      disabled: !row.disabled,
                                    }),
                                  ).then(load)
                                }
                              >
                                {row.disabled ? "Ativar" : "Desativar"}
                              </Button>
                              <Button
                                secondary
                                onClick={() =>
                                  open("key", { app_id: row.id, days: 90 })
                                }
                              >
                                Gerar chave
                              </Button>
                              <Button
                                secondary
                                onClick={() =>
                                  open("webhook", { app_id: row.id })
                                }
                              >
                                Webhook
                              </Button>
                            </div>
                          )}
                        />
                      ) : (
                        <Empty
                          title={managedContext ? "O atendimento Fagoo dentro dos seus sistemas" : "O Wabotia dentro dos seus sistemas"}
                          description="Cadastre uma aplicação para integrar mensagens, protocolos e bots à sua operação."
                        />
                      )}
                    </section>
                    <section className="card">
                      <h2>Chaves emitidas</h2>
                      <Table
                        rows={rows.keys || []}
                        columns={[
                          ["prefix", "Identificador"],
                          ["expires", "Validade"],
                          ["created", "Criação"],
                        ]}
                        action={(row: Row) =>
                          row.revoked ? (
                            <Badge value="revoked" />
                          ) : (
                            <button
                              className="text-link"
                              onClick={() =>
                                run(() =>
                                  api("v1/keys/" + row.id, "DELETE"),
                                ).then(load)
                              }
                            >
                              Revogar
                            </button>
                          )
                        }
                      />
                    </section>
                    <ApiDocumentationLink className="bottom-note">
                      <Code2 size={20} /> Abra a referência da API{" "}
                      <ArrowUpRight size={16} />
                    </ApiDocumentationLink>
                  </details>
                </>
              )}
              {page === "reports" && (
                <section className="card">
                  <div className="toolbar">
                    <Field
                      label="Seção do relatório"
                      value={section}
                      onChange={(v: string) => {
                        setSection(v);
                        setCursor("");
                      }}
                      options={[
                        ["tickets", "Protocolos"],
                        ["conversations", "Conversas"],
                        ["deliveries", "Entregas"],
                        ["surveys", "Avaliações"],
                        ["consents", "Consentimentos"],
                        ["runs", "Execuções dos bots"],
                      ]}
                    />
                    <Button
                      secondary
                      onClick={() =>
                        run(async () => {
                          const response = await (api.raw || fetch)(
                            (api.raw ? "" : "/api/") +
                              root +
                              "/reports?section=" +
                              section +
                              "&format=jsonl",
                          );
                          if (!response.ok)
                            throw new Error("Não foi possível exportar.");
                          const blob = await response.blob();
                          const a = document.createElement("a");
                          a.href = URL.createObjectURL(blob);
                          a.download = "wabotia-" + section + ".jsonl";
                          a.click();
                          URL.revokeObjectURL(a.href);
                        })
                      }
                    >
                      <Download size={16} /> Exportar JSONL
                    </Button>
                  </div>
                  <Table
                    rows={rows.data || []}
                    columns={
                      section === "tickets"
                        ? [
                            ["number", "Protocolo"],
                            ["title", "Solicitação"],
                            ["status", "Estado"],
                            ["created", "Data"],
                          ]
                        : [
                            ["id", "Identificador"],
                            ["status", "Estado"],
                            ["created", "Data"],
                          ]
                    }
                  />
                  <p className="muted">
                    {rows.count || 0} registros nesta consulta.
                  </p>
                </section>
              )}
              {["bot-runs", "deliveries", "webhook-deliveries"].includes(
                page,
              ) && (
                <section className="card">
                  <p>
                    Consulte o resultado antes de repetir uma operação sem
                    confirmação. Webhooks mantêm o mesmo ID de evento nos
                    reenvios.
                  </p>
                  <Table
                    rows={list}
                    columns={[
                      ["id", "Identificador"],
                      ["status", "Estado"],
                      [
                        page === "webhook-deliveries" ? "attempts" : "error",
                        page === "webhook-deliveries"
                          ? "Tentativas"
                          : "Detalhes",
                      ],
                      ["created", "Data"],
                    ]}
                    action={(row: Row) => (
                      <div className="card-actions">
                        {page === "deliveries" &&
                          row.status === "pending" &&
                          row.dedupe?.startsWith("router:") &&
                          me.role === "admin" && (
                            <Button
                              secondary
                              onClick={() =>
                                run(() =>
                                  api(
                                    root + `/router/messages/${row.id}/cancel`,
                                    "POST",
                                    {},
                                  ),
                                ).then(load)
                              }
                            >
                              Cancelar envio na fila
                            </Button>
                          )}
                        {page === "webhook-deliveries" && (
                          <Button
                            secondary
                            onClick={() =>
                              run(() =>
                                api(
                                  root + `/webhook-deliveries/${row.id}/retry`,
                                  "POST",
                                  {},
                                ),
                              ).then(load)
                            }
                          >
                            Reenviar
                          </Button>
                        )}
                        {page === "bot-runs" &&
                          ["queued", "running", "starting"].includes(
                            row.status,
                          ) && (
                            <Button
                              secondary
                              onClick={() =>
                                run(() =>
                                  api(
                                    root + `/bot-runs/${row.id}/cancel`,
                                    "POST",
                                    {},
                                  ),
                                ).then(load)
                              }
                            >
                              Cancelar
                            </Button>
                          )}
                        {row.status === "unknown" &&
                          me.role === "admin" &&
                          page !== "webhook-deliveries" && (
                            <Button
                              secondary
                              onClick={() =>
                                open(
                                  page === "bot-runs"
                                    ? "reconcile-run"
                                    : "reconcile-delivery",
                                  {
                                    id: row.id,
                                    status: "cancelled",
                                    paid_template: row.kind === "template",
                                    allow_paid: false,
                                  },
                                )
                              }
                            >
                              Conferir resultado
                            </Button>
                          )}
                        {row.result && (
                          <details>
                            <summary>Resultado</summary>
                            <pre className="code-block">{row.result}</pre>
                          </details>
                        )}
                      </div>
                    )}
                  />
                </section>
              )}
              {["surveys", "consents"].includes(page) && (
                <section className="card">
                  <Table
                    rows={list}
                    columns={
                      page === "surveys"
                        ? [
                            ["score", "Nota"],
                            ["comment", "Comentário"],
                            ["status", "Estado"],
                            ["created", "Data"],
                          ]
                        : [
                            ["conversation_id", "Conversa"],
                            ["status", "Consentimento"],
                            ["created", "Data"],
                          ]
                    }
                  />
                </section>
              )}
            </>
          )}
          {(cursor || nextCursor) && (
            <div className="toolbar">
              <Button
                secondary
                disabled={!cursor}
                onClick={() => setCursor("")}
              >
                Voltar ao início
              </Button>
              <Button
                secondary
                disabled={!nextCursor}
                onClick={() => setCursor(nextCursor || "")}
              >
                Próxima página <ArrowRight size={16} />
              </Button>
            </div>
          )}
          <footer className="app-footer">
            <span>{managedContext ? "Fagoo" : "Wabotia"} · Atendimento conectado</span>
            <a href={managedContext ? "https://github.com/Quevenapp/Fagoo" : "https://github.com/Quevenapp/Wabotia"}>
              Código aberto <ArrowUpRight size={12} />
            </a>
          </footer>
        </div>
      </main>
      {pendingNavigation && (
        <Modal
          title="Alterações ainda não salvas"
          close={() => setPendingNavigation(null)}
        >
          <p>
            Suas regras foram editadas. Volte para salvá-las ou descarte as
            alterações antes de sair.
          </p>
          <div className="modal-actions">
            <Button secondary onClick={() => setPendingNavigation(null)}>
              Continuar editando
            </Button>
            <Button
              onClick={() => {
                const target = pendingNavigation;
                setPendingNavigation(null);
                setSetupDirty(false);
                if (target.page) navigate(target.page, true);
                else if (target.profile !== undefined)
                  chooseProfile(target.profile, true);
                if (target.conversation)
                  openConversation({ id: target.conversation }).catch((e) =>
                    setError(e.message),
                  );
              }}
            >
              Descartar e continuar
            </Button>
          </div>
        </Modal>
      )}
      {contactEditing && selection && (
        <ContactEditor
          key={profile + selection.conversation.id}
          api={api}
          root={root}
          demo={demo}
          contact={selection.contact}
          conversation={selection.conversation}
          close={() => setContactEditing(false)}
          saved={(message) => {
            setContactEditing(false);
            setNotice(message);
            openConversation(selection.conversation)
              .then(load)
              .catch((e) => setError(e.message));
          }}
        />
      )}
      {modal && (
        <Modal
          title={
            (
              {
                profile: "Novo perfil de atendimento",
                transfer: "Transferir atendimento",
                jev: "Chave JEV",
                "user-edit": "Editar pessoa",
                connection: "Conectar serviço",
                knowledge: "Adicionar conhecimento",
                user: "Adicionar pessoa",
                application: "Nova aplicação",
                key: "Gerar chave",
                secret: "Guarde esta chave",
                ticket: "Atualizar protocolo",
                "reconcile-run": "Vincular execução confirmada",
                "reconcile-delivery": "Conferir entrega no canal",
                capability: "Ação de especialista",
                menu: "Opção do menu",
                webhook: "Cadastrar webhook",
              } as Row
            )[modal]
          }
          close={() => setModal("")}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              saveModal();
            }}
          >
            {[
              "profile",
              "user",
              "user-edit",
              "application",
              "connection",
              "capability",
            ].includes(modal) && (
              <Field
                label="Nome"
                value={form.name}
                onChange={(v: string) => change("name", v)}
                required
              />
            )}
            {modal === "connection" && (
              <>
                <Field
                  label="Serviço"
                  value={form.kind}
                  onChange={(v: string) => change("kind", v)}
                  options={[
                    ["hermes", "Hermes"],
                    ["meta", "WhatsApp · API oficial Meta"],
                    ["qr", "WhatsApp · QR direto"],
                    ["hermes-whatsapp", "WhatsApp · pelo Hermes"],
                    ["telegram", "Telegram"],
                  ]}
                />
                {["qr", "meta", "hermes-whatsapp"].includes(form.kind) && (
                  <Field
                    label="Número com DDI (somente dígitos)"
                    value={form.number}
                    onChange={(v: string) => change("number", v)}
                    placeholder="5511999999999"
                    required
                  />
                )}
                {form.kind === "hermes-whatsapp" && (
                  <Field
                    label="Canal configurado no Hermes"
                    value={form.platform}
                    onChange={(v: string) => change("platform", v)}
                    options={[
                      ["whatsapp", "QR Hermes"],
                      ["whatsapp_cloud", "Meta Hermes"],
                    ]}
                    required
                  />
                )}
                {form.kind === "hermes" && (
                  <>
                    <Field
                      label="URL do backend administrativo Hermes"
                      value={form.url}
                      onChange={(v: string) => change("url", v)}
                      placeholder="https://hermes.seudominio.com"
                    />
                    <Field
                      label="URL da API de bots Hermes"
                      value={form.api_url}
                      onChange={(v: string) => change("api_url", v)}
                      placeholder="https://api-hermes.seudominio.com"
                    />
                    <Field
                      label="Token administrativo Hermes"
                      type="password"
                      value={form.dashboard_token}
                      onChange={(v: string) => change("dashboard_token", v)}
                    />
                    <Field
                      label="Nome do perfil Hermes"
                      value={form.remote_profile}
                      onChange={(v: string) => change("remote_profile", v)}
                      placeholder="default"
                    />
                    <Field
                      label="API_SERVER_KEY desse perfil"
                      type="password"
                      value={form.profile_key}
                      onChange={(v: string) => change("profile_key", v)}
                    />
                    <details>
                      <summary>Chaves de vários perfis Hermes</summary>
                      <p>
                        Informe um objeto JSON com nome do perfil e chave. Deixe
                        vazio para manter as chaves já cadastradas.
                      </p>
                      <Field
                        label="Chaves por perfil (JSON)"
                        type="textarea"
                        value={form.profile_keys_json}
                        onChange={(v: string) => change("profile_keys_json", v)}
                      />
                    </details>
                    <details>
                      <summary>Conexão protegida por Cloudflare Access</summary>
                      <Field
                        label="Client ID"
                        value={form.access_client_id}
                        onChange={(v: string) => change("access_client_id", v)}
                      />
                      <Field
                        label="Client Secret"
                        type="password"
                        value={form.access_client_secret}
                        onChange={(v: string) =>
                          change("access_client_secret", v)
                        }
                      />
                    </details>
                  </>
                )}
                {form.kind === "meta" && (
                  <label className="check-line">
                    <input
                      type="checkbox"
                      checked={!!form.groups_enabled}
                      onChange={(e) =>
                        change("groups_enabled", e.target.checked)
                      }
                    />
                    Minha conta Meta tem acesso à API de Grupos (OBA)
                  </label>
                )}
                {["meta", "telegram"].includes(form.kind) && (
                  <Field
                    label="Token do serviço"
                    type="password"
                    value={form.token}
                    onChange={(v: string) => change("token", v)}
                  />
                )}{" "}
                {form.kind === "meta" && (
                  <>
                    {[
                      ["phone_id", "Phone Number ID"],
                      ["waba_id", "WABA ID"],
                      ["app_secret", "App Secret"],
                      ["verify_token", "Verify Token do webhook"],
                    ].map(([key, label]) => (
                      <Field
                        key={key}
                        label={label}
                        type={
                          key.includes("secret") || key.includes("token")
                            ? "password"
                            : "text"
                        }
                        value={form[key]}
                        onChange={(v: string) => change(key, v)}
                      />
                    ))}
                  </>
                )}
                {form.kind === "telegram" && (
                  <Field
                    label="ID do grupo privado com tópicos"
                    value={form.group}
                    onChange={(v: string) => change("group", v)}
                    placeholder="-100…"
                  />
                )}
                {["qr", "hermes-whatsapp"].includes(form.kind) && (
                  <p>
                    Após salvar, gere uma chave do conector e siga o guia para
                    iniciá-lo junto do Hermes.
                  </p>
                )}
              </>
            )}
            {modal === "jev" && (
              <>
                <p>
                  A chave será guardada de forma protegida. Depois de salvar,
                  ligue ou desligue o JEV nas regras de atendimento.
                </p>
                <Field
                  label="Chave da API JEV"
                  type="password"
                  value={form.key}
                  onChange={(value: string) => change("key", value)}
                  required
                />
              </>
            )}
            {modal === "knowledge" && (
              <>
                <Field
                  label="Título da fonte"
                  value={form.title}
                  onChange={(v: string) => change("title", v)}
                  required
                />
                <Field
                  label="Tipo de fonte"
                  value={form.kind}
                  onChange={(v: string) => change("kind", v)}
                  options={[
                    ["text", "Texto"],
                    ["url", "Página da internet"],
                    ["file", "Documento"],
                    ["youtube", "Vídeo com transcrição"],
                  ]}
                />
                {form.kind === "text" ? (
                  <Field
                    label="Conteúdo"
                    type="textarea"
                    value={form.text}
                    onChange={(v: string) => change("text", v)}
                  />
                ) : form.kind === "file" ? (
                  <label className="field">
                    <span>PDF, DOCX, TXT, MD, VTT ou SRT · até 20 MB</span>
                    <input
                      id="knowledge-file"
                      type="file"
                      accept=".pdf,.docx,.txt,.md,.srt,.vtt"
                    />
                  </label>
                ) : (
                  <Field
                    label="URL pública"
                    value={form.url}
                    onChange={(v: string) => change("url", v)}
                  />
                )}
              </>
            )}
            {["user", "user-edit"].includes(modal) && (
              <>
                {modal === "user" && (
                  <Field
                    label="E-mail"
                    type="email"
                    value={form.email}
                    onChange={(v: string) => change("email", v)}
                  />
                )}
                <Field
                  label="Senha inicial (mínimo 12 caracteres)"
                  type="password"
                  value={form.password}
                  onChange={(v: string) => change("password", v)}
                />
                {modal === "user" && (
                  <Field
                    label="Papel"
                    value={form.role}
                    onChange={(v: string) => change("role", v)}
                    options={[
                      ["operator", "Atendente"],
                      ["admin", "Administrador"],
                    ]}
                  />
                )}
                <Field
                  label="ID pessoal no Telegram (opcional)"
                  value={form.telegram_id}
                  onChange={(v: string) => change("telegram_id", v)}
                />
              </>
            )}
            {["user", "user-edit", "application"].includes(modal) && (
              <fieldset className="scope-grid">
                <legend>Perfis autorizados</legend>
                {profiles.map((p) => (
                  <label className="check-field" key={p.id}>
                    <input
                      type="checkbox"
                      checked={(form.profiles || [profile]).includes(p.id)}
                      onChange={(e) =>
                        change(
                          "profiles",
                          e.target.checked
                            ? [...(form.profiles || [profile]), p.id]
                            : (form.profiles || [profile]).filter(
                                (id: string) => id !== p.id,
                              ),
                        )
                      }
                    />
                    {p.name}
                  </label>
                ))}
              </fieldset>
            )}
            {modal === "application" && (
              <>
                <p>Permissões para o perfil selecionado:</p>
                <div className="scope-grid">
                  {(
                    (rows.scopes?.length ? rows.scopes : null) || [
                      "calls:read",
                      "calls:write",
                      "groups:manage",
                      "conversations:read",
                      "conversations:write",
                      "contacts:read",
                      "contacts:write",
                      "tickets:read",
                      "tickets:write",
                      "bots:read",
                      "bots:invoke",
                      "webhooks:manage",
                    ]
                  ).map((s: string) => (
                    <label className="check-field" key={s}>
                      <input
                        type="checkbox"
                        checked={(form.scopes || []).includes(s)}
                        onChange={(e) =>
                          change(
                            "scopes",
                            e.target.checked
                              ? [...(form.scopes || []), s]
                              : (form.scopes || []).filter(
                                  (x: string) => x !== s,
                                ),
                          )
                        }
                      />
                      {s}
                    </label>
                  ))}
                </div>
                <h3>Bots que esta aplicação pode executar</h3>
                {bots.map((b) => (
                  <label className="check-field" key={b.id}>
                    <input
                      type="checkbox"
                      checked={(form.bots || []).includes(b.id)}
                      onChange={(e) =>
                        change(
                          "bots",
                          e.target.checked
                            ? [...(form.bots || []), b.id]
                            : (form.bots || []).filter(
                                (x: string) => x !== b.id,
                              ),
                        )
                      }
                    />
                    {b.name}
                  </label>
                ))}
              </>
            )}
            {modal === "key" && (
              <Field
                label="Validade em dias (até 365)"
                type="number"
                value={form.days}
                onChange={(v: string) => change("days", v)}
              />
            )}
            {modal === "secret" && (
              <>
                <p>
                  A chave é exibida somente agora. Guarde-a no sistema que fará
                  a integração.
                </p>
                <div className="secret-box">
                  <code>{form.token}</code>
                  <CopyButton value={form.token} />
                </div>
                <Button onClick={() => setModal("")}>
                  Guardei minha chave <Check size={16} />
                </Button>
              </>
            )}
            {modal === "ticket" && (
              <>
                <Field
                  label="Estado"
                  value={form.status}
                  onChange={(v: string) => change("status", v)}
                  options={[
                    ["open", "Aberto"],
                    ["in_progress", "Em andamento"],
                    ["closed", "Concluído"],
                  ]}
                />
                <Field
                  label="Responsável (ID do atendente)"
                  value={form.owner}
                  onChange={(v: string) => change("owner", v)}
                />
                <Field
                  label="Andamento para o cliente"
                  type="textarea"
                  value={form.text}
                  onChange={(v: string) => change("text", v)}
                />
                <Field
                  label="Novo prazo (antes da primeira resposta)"
                  type="datetime-local"
                  value={form.deadline}
                  onChange={(v: string) => change("deadline", v)}
                />
              </>
            )}
            {modal === "capability" && (
              <>
                <Field
                  label="Especialista Hermes"
                  value={form.bot_id}
                  onChange={(v: string) => change("bot_id", v)}
                  options={bots}
                />
                <Field
                  label="Quando consultar este especialista"
                  type="textarea"
                  value={form.condition}
                  onChange={(v: string) => change("condition", v)}
                />
                <Field
                  label="Ação permitida"
                  type="textarea"
                  value={form.instructions}
                  onChange={(v: string) => change("instructions", v)}
                />
              </>
            )}
            {modal === "menu" && (
              <>
                <Field
                  label="Texto da opção"
                  value={form.label}
                  onChange={(v: string) => change("label", v)}
                />
                <Field
                  label="Destino"
                  value={form.type}
                  onChange={(v: string) => change("type", v)}
                  options={[
                    ["human", "Atendente humano"],
                    ["bot", "Bot Hermes"],
                    ["app", "Aplicativo"],
                    ["submenu", "Submenu"],
                  ]}
                />
                <Field
                  label="ID do menu pai (opcional)"
                  value={form.parent_id}
                  onChange={(v: string) => change("parent_id", v)}
                />
                {form.type === "app" && (
                  <Field
                    label="ID do aplicativo"
                    value={form.app_id}
                    onChange={(v: string) => change("app_id", v)}
                  />
                )}
                {form.type === "bot" && (
                  <Field
                    label="Bot"
                    value={form.bot_id}
                    onChange={(v: string) => change("bot_id", v)}
                    options={bots}
                  />
                )}
              </>
            )}
            {modal === "transfer" && (
              <>
                <Field
                  label="Pessoa ou bot que receberá a conversa"
                  value={form.target}
                  onChange={(value: string) => change("target", value)}
                  options={(form.people || []).map((person: Row) => [
                    person.id,
                    person.name,
                  ])}
                  required
                />
                <p>
                  A conversa mantém o número de WhatsApp. As permissões da linha
                  e do destinatário continuam valendo.
                </p>
              </>
            )}
            {modal === "reconcile-run" && (
              <Field
                label="run_id confirmado no Hermes"
                value={form.remote_id}
                onChange={(v: string) => change("remote_id", v)}
                required
              />
            )}
            {modal === "reconcile-delivery" && (
              <>
                <p>
                  Confira a mensagem no canal. Uma nova tentativa pode duplicar
                  uma mensagem que já chegou ao destinatário.
                </p>
                <Field
                  label="Resultado conferido"
                  value={form.status}
                  onChange={(v: string) => change("status", v)}
                  options={[
                    ["cancelled", "Cancelar entrega"],
                    ["sent", "Confirmar que foi enviada"],
                    ["pending", "Autorizar nova tentativa"],
                  ]}
                />
                {form.paid_template && form.status === "pending" && (
                  <label className="check-line">
                    <input
                      type="checkbox"
                      required
                      checked={!!form.allow_paid}
                      onChange={(e) => change("allow_paid", e.target.checked)}
                    />
                    Autorizo a possível cobrança deste novo envio de modelo pela
                    Meta.
                  </label>
                )}
              </>
            )}
            {modal === "webhook" && (
              <>
                <Field
                  label="URL HTTPS do seu sistema"
                  value={form.url}
                  onChange={(v: string) => change("url", v)}
                />
                <p>
                  Receberá novas mensagens, atualizações de protocolo e
                  conclusão de bots. O segredo de assinatura será exibido após
                  salvar.
                </p>
              </>
            )}
            {modal !== "secret" && (
              <div className="modal-actions">
                <Button secondary onClick={() => setModal("")}>
                  Cancelar
                </Button>
                <Button type="submit" disabled={busy}>
                  {busy ? (
                    <Loader2 className="spin" size={17} />
                  ) : (
                    <Check size={17} />
                  )}{" "}
                  Salvar
                </Button>
              </div>
            )}
            {error && <div className="notice error">{error}</div>}
          </form>
        </Modal>
      )}
    </div>
  );
}
function Table({ rows, columns, action }: any) {
  return rows.length ? (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            {columns.map(([key, label]: any) => (
              <th key={key}>{label}</th>
            ))}
            {action && <th />}
          </tr>
        </thead>
        <tbody>
          {rows.map((row: any, i: number) => (
            <tr key={row.id || i}>
              {columns.map(([key]: any) => (
                <td key={key}>
                  {key === "status" ? (
                    <Badge value={row[key]} />
                  ) : [
                      "created",
                      "updated",
                      "expires",
                      "response_due_at",
                    ].includes(key) ? (
                    date(row[key])
                  ) : (
                    String(row[key] ?? "—")
                  )}
                </td>
              ))}
              {action && <td>{action(row)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ) : (
    <Empty
      title="Nenhum registro por aqui"
      description="Os dados aparecerão conforme sua operação começar."
    />
  );
}
