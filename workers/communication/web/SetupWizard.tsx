import React, { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  Check,
  ChevronRight,
  Headphones,
  Loader2,
  MessageCircle,
  RefreshCw,
  Settings,
  ShieldCheck,
} from "lucide-react";

type Row = Record<string, any>;
type Api = (
  path: string,
  method?: string,
  body?: any,
  signal?: AbortSignal,
  idempotencyKey?: string,
) => Promise<any>;
type Props = {
  api: Api;
  root: string;
  demo: boolean;
  hasProfile: boolean;
  onNavigate: (page: string) => void;
  onConnect: (kind: string) => void;
  onCreateProfile: () => void;
  onRefresh: () => void | Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
  refreshKey?: number;
};
type Snapshot = {
  status: Row;
  bots: Row[];
  connections: Row[];
  lines: Row[];
  menus: Row[];
};
type Rules = {
  attendant_bot: string;
  instructions: string;
  absence_instructions: string;
  protocol_response_hours: string;
  surveys_enabled: boolean;
  jev_enabled: boolean;
  telegram_connection: string;
  telegram_group: string;
  reply_mode: string;
};
const steps = [
  { title: "WhatsApp", caption: "Conta e números", icon: MessageCircle },
  { title: "Atendimento", caption: "Bots e especialistas", icon: Bot },
  { title: "Equipe humana", caption: "Pessoas e Telegram", icon: Headphones },
  { title: "Regras", caption: "Prazos e decisões", icon: Settings },
  {
    title: "Menus e sistemas",
    caption: "Destinos e integrações",
    icon: ChevronRight,
  },
  { title: "Revisão", caption: "Conferir e testar", icon: ShieldCheck },
];
const rows = (value: any): Row[] =>
  Array.isArray(value) ? value : Array.isArray(value?.data) ? value.data : [];
const rulesFrom = (settings: Row): Rules => ({
  attendant_bot: settings.attendant_bot || "",
  instructions: settings.instructions || "",
  absence_instructions: settings.absence_instructions || "",
  protocol_response_hours:
    settings.protocol_response_hours == null
      ? ""
      : String(settings.protocol_response_hours),
  surveys_enabled: !!settings.surveys_enabled,
  jev_enabled: !!settings.jev_enabled,
  telegram_connection: settings.telegram_connection || "",
  telegram_group: settings.telegram_group || "",
  reply_mode: settings.reply_mode || "command",
});
const demoSnapshot: Snapshot = {
  status: {
    enabled: false,
    settings: {
      attendant_bot: "demo-bot",
      instructions: "Acolha o cliente e responda com clareza.",
      absence_instructions:
        "Nossa equipe está ausente. Abrimos um protocolo para acompanhar sua solicitação.",
      protocol_response_hours: 24,
      surveys_enabled: false,
      jev_enabled: false,
    },
  },
  bots: [{ id: "demo-bot", name: "Atendente", enabled: 1 }],
  connections: [],
  lines: [],
  menus: [],
};
function savedStep(root: string) {
  try {
    const value = Number(sessionStorage.getItem("wabotia:setup-step:" + root));
    return Number.isInteger(value) && value >= 0 && value < steps.length
      ? value
      : 0;
  } catch {
    return 0;
  }
}
function Action({
  children,
  onClick,
  secondary = false,
  disabled = false,
}: {
  children: React.ReactNode;
  onClick: () => void;
  secondary?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={"button" + (secondary ? " secondary" : "")}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

export function SetupWizard({
  api,
  root,
  demo,
  hasProfile,
  onNavigate,
  onConnect,
  onCreateProfile,
  onRefresh,
  onDirtyChange,
  refreshKey = 0,
}: Props) {
  const [step, setStep] = useState(() => savedStep(root));
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [draft, setDraft] = useState<Rules>(rulesFrom({}));
  const [loading, setLoading] = useState(false),
    [saving, setSaving] = useState(false);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const dirty = useRef(false),
    sequence = useRef(0),
    currentRoot = useRef(root),
    alive = useRef(true);
  const intents = useRef(new Map<string, string>());
  const previousRefreshKey = useRef(refreshKey);
  const notifyDirty = useRef(onDirtyChange);
  const stepHeading = useRef<HTMLHeadingElement>(null);
  const focusStepHeading = useRef(false);
  currentRoot.current = root;
  notifyDirty.current = onDirtyChange;

  async function refresh() {
    if (!hasProfile) return;
    const request = ++sequence.current,
      requestRoot = root;
    setLoading(true);
    setError("");
    try {
      const next = demo
        ? demoSnapshot
        : await (async () => {
            const [status, bots, connections, lines, menus] = await Promise.all(
              [
                api(root + "/status"),
                api(root + "/bots"),
                api(root + "/connections"),
                api(root + "/lines"),
                api(root + "/menus"),
              ],
            );
            return {
              status,
              bots: rows(bots),
              connections: rows(connections),
              lines: rows(lines),
              menus: rows(menus),
            };
          })();
      if (
        !alive.current ||
        currentRoot.current !== requestRoot ||
        request !== sequence.current
      )
        return;
      setSnapshot(next);
      if (!dirty.current) setDraft(rulesFrom(next.status.settings || {}));
    } catch (e: any) {
      if (
        alive.current &&
        currentRoot.current === requestRoot &&
        request === sequence.current
      )
        setError(
          e.message ||
            "Não foi possível consultar a configuração. Tente novamente.",
        );
    } finally {
      if (
        alive.current &&
        currentRoot.current === requestRoot &&
        request === sequence.current
      )
        setLoading(false);
    }
  }
  useEffect(() => {
    alive.current = true;
    dirty.current = false;
    notifyDirty.current?.(false);
    focusStepHeading.current = false;
    setSnapshot(null);
    setDraft(rulesFrom({}));
    setStep(savedStep(root));
    setNotice("");
    setSaving(false);
    void refresh();
    return () => {
      alive.current = false;
      sequence.current++;
      notifyDirty.current?.(false);
    };
  }, [root, demo, hasProfile]);
  useEffect(() => {
    if (previousRefreshKey.current === refreshKey) return;
    previousRefreshKey.current = refreshKey;
    void refresh();
  }, [refreshKey]);
  useEffect(() => {
    if (!focusStepHeading.current) return;
    focusStepHeading.current = false;
    stepHeading.current?.focus();
  }, [step]);
  function go(next: number) {
    focusStepHeading.current = next !== step;
    setStep(next);
    setNotice("");
    try {
      sessionStorage.setItem("wabotia:setup-step:" + root, String(next));
    } catch {
      /* Navigation also works without storage. */
    }
  }
  function change<K extends keyof Rules>(key: K, value: Rules[K]) {
    dirty.current = true;
    notifyDirty.current?.(true);
    setDraft((old) => ({ ...old, [key]: value }));
    setNotice("");
  }
  async function saveRules() {
    if (saving || !snapshot) return;
    if (demo) {
      setNotice(
        "Demonstração: as regras não foram gravadas. Você pode continuar explorando as etapas.",
      );
      return;
    }
    const hours =
      draft.protocol_response_hours === ""
        ? null
        : Number(draft.protocol_response_hours);
    if (
      hours !== null &&
      (!Number.isFinite(hours) || hours <= 0 || hours > 8760)
    ) {
      setError(
        "Informe um prazo maior que zero e de até 8.760 horas, ou deixe em branco para não definir prazo.",
      );
      return;
    }
    const requestRoot = root;
    const body = { ...draft, protocol_response_hours: hours };
    const intent = requestRoot + JSON.stringify(body);
    if (!intents.current.has(intent))
      intents.current.set(intent, crypto.randomUUID());
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const result = await api(
        root + "/settings",
        "PUT",
        body,
        undefined,
        intents.current.get(intent),
      );
      intents.current.delete(intent);
      if (!alive.current || currentRoot.current !== requestRoot) return;
      dirty.current = false;
      notifyDirty.current?.(false);
      setSnapshot((old) =>
        old ? { ...old, status: { ...old.status, settings: result } } : old,
      );
      setDraft(rulesFrom(result));
      setNotice(
        "Regras salvas neste perfil. O estado do atendimento permanece como estava.",
      );
      void Promise.resolve(onRefresh()).catch(() => {});
    } catch (e: any) {
      if (
        e.status >= 400 &&
        e.status < 500 &&
        !["operation_unknown", "idempotency_conflict"].includes(e.code)
      )
        intents.current.delete(intent);
      if (alive.current && currentRoot.current === requestRoot)
        setError(e.message || "Não foi possível salvar as regras.");
    } finally {
      if (alive.current && currentRoot.current === requestRoot)
        setSaving(false);
    }
  }

  const cfg = snapshot?.status.settings || {};
  const hermes = snapshot?.connections.filter((c) => c.kind === "hermes") || [];
  const telegram =
    snapshot?.connections.filter((c) => c.kind === "telegram") || [];
  const attendant = snapshot?.bots.find((b) => b.id === cfg.attendant_bot);
  const chosenBot = snapshot?.bots.find((b) => b.id === draft.attendant_bot);
  const current = steps[step];
  const Icon = current.icon;
  const summary = snapshot
    ? [
        [
          "WhatsApp",
          `${snapshot.lines.length} linha(s) cadastrada(s)`,
          "router",
        ],
        [
          "Bot principal",
          attendant
            ? `${attendant.name}${attendant.enabled ? "" : " · desabilitado"}`
            : "Não selecionado; confira o atendimento por linha",
          "bots",
        ],
        [
          "Ponte Telegram",
          cfg.telegram_connection && cfg.telegram_group
            ? "Conexão e grupo selecionados"
            : "Não configurada nas regras",
          "connections",
        ],
        [
          "Menus",
          `${snapshot.menus.filter((m) => m.enabled).length} opção(ões) habilitada(s)`,
          "menus",
        ],
        [
          "Prazo de resposta",
          cfg.protocol_response_hours
            ? `${cfg.protocol_response_hours} hora(s)`
            : "Sem prazo padrão",
          "settings",
        ],
        [
          "Avaliações",
          cfg.surveys_enabled ? "Solicitar ao concluir" : "Desligadas",
          "surveys",
        ],
        ["Decisão JEV", cfg.jev_enabled ? "Ligada" : "Desligada", "settings"],
      ]
    : [];

  return (
    <div className="setup-wizard">
      <section className="setup-intro">
        <div>
          <span className="setup-eyebrow">CONFIGURAÇÃO GUIADA</span>
          <h2>Um passo de cada vez.</h2>
          <p>
            Conecte os canais, escolha quem atende e defina o caminho do
            cliente. Você pode voltar a qualquer etapa.
          </p>
        </div>
        {hasProfile && (
          <Action
            secondary
            disabled={loading || saving}
            onClick={() => void refresh()}
          >
            <RefreshCw size={16} className={loading ? "spin" : ""} /> Verificar
            configuração
          </Action>
        )}
      </section>
      {!hasProfile ? (
        <section className="card setup-welcome">
          <MessageCircle size={30} />
          <h3>Primeiro, dê um nome ao seu atendimento</h3>
          <p>
            O perfil reúne números de WhatsApp, bots, equipe e regras. Por
            exemplo: “Atendimento da empresa”.
          </p>
          <Action onClick={onCreateProfile}>
            Criar meu atendimento <ArrowRight size={16} />
          </Action>
        </section>
      ) : (
        <>
          <nav className="setup-steps" aria-label="Etapas de configuração">
            {steps.map((item, index) => (
              <button
                key={item.title}
                type="button"
                aria-current={index === step ? "step" : undefined}
                className={index === step ? "active" : ""}
                onClick={() => go(index)}
                disabled={saving}
              >
                <span className="setup-step-number">{index + 1}</span>
                <span>
                  <strong>{item.title}</strong>
                  <small>{item.caption}</small>
                </span>
              </button>
            ))}
          </nav>
          <div aria-live="polite">
            {loading && (
              <p className="setup-loading">
                <Loader2 className="spin" size={16} /> Consultando a
                configuração salva…
              </p>
            )}
            {error && (
              <div className="notice error" role="alert">
                {error}
                <Action
                  secondary
                  disabled={loading || saving}
                  onClick={() => void refresh()}
                >
                  Tentar consultar novamente
                </Action>
              </div>
            )}
            {notice && (
              <div className="notice" role="status">
                {notice}
              </div>
            )}
          </div>
          <section
            className="card setup-content"
            aria-labelledby="setup-step-title"
          >
            <header className="setup-content-heading">
              <span className="setup-symbol">
                <Icon size={23} />
              </span>
              <div>
                <small>
                  Etapa {step + 1} de {steps.length}
                </small>
                <h2 id="setup-step-title" ref={stepHeading} tabIndex={-1}>
                  {current.title}
                </h2>
              </div>
            </header>
            {step === 0 && (
              <>
                <h3>Traga os números da sua conta Meta</h3>
                <p>
                  Uma conta reúne os números do WhatsApp da empresa. O Wabotia
                  recebe as mensagens e encaminha cada conversa para o
                  atendimento escolhido.
                </p>
                <ol className="setup-instructions">
                  <li>
                    Prepare a conta e o aplicativo seguindo o guia da Meta.
                  </li>
                  <li>
                    Cadastre a conta no Wabotia e configure o endereço de
                    recebimento de mensagens mostrado na tela.
                  </li>
                  <li>
                    Use <strong>Buscar números na Meta</strong> e adicione os
                    números que deseja usar.
                  </li>
                  <li>
                    Em <strong>Quem atende cada linha</strong>, escolha uma
                    pessoa, um bot específico ou o bot principal.
                  </li>
                </ol>
                <div className="setup-status">
                  {snapshot
                    ? `${snapshot.lines.length} linha(s) cadastrada(s) neste perfil. O cadastro não confirma o recebimento de mensagens.`
                    : "Os números ainda não foram consultados."}
                </div>
                <div className="setup-actions">
                  <Action onClick={() => onNavigate("router")}>
                    Configurar conta e números <ArrowRight size={16} />
                  </Action>
                  <Action secondary onClick={() => onNavigate("lines")}>
                    Quem atende cada linha
                  </Action>
                  <a
                    className="text-link"
                    href="/install#meta-whatsapp"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Ver o guia da Meta ↗
                  </a>
                </div>
                <details className="setup-detail">
                  <summary>Já uso WhatsApp por QR code ou pelo Hermes</summary>
                  <p>
                    Esses canais continuam disponíveis. Use uma conexão
                    existente ou cadastre o canal em Conexões.
                  </p>
                  <Action secondary onClick={() => onNavigate("connections")}>
                    Abrir conexões
                  </Action>
                </details>
              </>
            )}
            {step === 1 && (
              <>
                <h3>
                  Um bot conversa com o cliente. Especialistas ajudam por
                  dentro.
                </h3>
                <p>
                  O bot principal acolhe e interpreta a solicitação. No Hermes,
                  os bots especialistas acessam os sistemas com as permissões
                  que já possuem.
                </p>
                <div
                  className="setup-flow"
                  aria-label="Exemplo de atendimento interno"
                >
                  <span>Cliente pede segunda via</span>
                  <ArrowRight size={18} aria-hidden="true" />
                  <span>Bot atendente</span>
                  <ArrowRight size={18} aria-hidden="true" />
                  <span>Hermes · bot financeiro Fagoo</span>
                </div>
                <p>
                  O especialista retorna o resultado ao atendente, que responde
                  ao cliente. Cadastre uma <strong>ação de especialista</strong>{" "}
                  para definir quando ele pode ser consultado. As credenciais
                  financeiras ficam configuradas no bot especialista do Hermes.
                </p>
                <ol className="setup-instructions">
                  <li>Cadastre e teste a conexão com o Hermes.</li>
                  <li>
                    Use <strong>Descobrir bots</strong> na conexão e habilite os
                    bots desejados.
                  </li>
                  <li>
                    Escolha o bot principal na etapa Regras. Configure
                    especialistas em Bots e ações internas.
                  </li>
                </ol>
                <div className="setup-status">
                  {snapshot
                    ? `${hermes.length} conexão(ões) Hermes cadastrada(s) · ${snapshot.bots.filter((b) => b.enabled).length} bot(s) habilitado(s).`
                    : "O Hermes e os bots ainda não foram consultados."}
                </div>
                <div className="setup-actions">
                  <Action
                    onClick={() =>
                      hermes.length
                        ? onNavigate("connections")
                        : onConnect("hermes")
                    }
                  >
                    {hermes.length
                      ? "Testar Hermes e descobrir bots"
                      : "Conectar Hermes"}{" "}
                    <ArrowRight size={16} />
                  </Action>
                  <Action secondary onClick={() => onNavigate("bots")}>
                    Bots e ações internas
                  </Action>
                  <Action secondary onClick={() => onNavigate("lines")}>
                    Atendimento por linha
                  </Action>
                </div>
                <p className="setup-help">
                  Se a linha for atendida apenas por pessoas, você pode
                  continuar sem escolher um bot principal.
                </p>
              </>
            )}
            {step === 2 && (
              <>
                <h3>Escolha como a equipe recebe as conversas</h3>
                <p>
                  As pessoas podem atender pelo painel. Para trabalhar pelo
                  Telegram, conecte um bot dedicado e um grupo privado com
                  tópicos.
                </p>
                <ol className="setup-instructions">
                  <li>
                    Cadastre as pessoas que podem atender. Para o Telegram,
                    vincule o ID de cada atendente.
                  </li>
                  <li>
                    Crie um bot no BotFather, adicione-o como administrador do
                    grupo e cadastre a conexão Telegram.
                  </li>
                  <li>
                    Na conexão, use <strong>Ligar recebimento Telegram</strong>.
                    Na próxima etapa, selecione a conexão e informe o grupo.
                  </li>
                  <li>
                    Cada pessoa marca presença em Disponibilidade antes de
                    atender. No Telegram, use <code>/presente</code>.
                  </li>
                </ol>
                <div className="setup-status">
                  {snapshot
                    ? `${telegram.length} conexão(ões) Telegram cadastrada(s). O atendimento pelo painel pode ser usado sem Telegram.`
                    : "As conexões Telegram ainda não foram consultadas."}
                </div>
                <div className="setup-actions">
                  <Action onClick={() => onNavigate("users")}>
                    Cadastrar pessoas <ArrowRight size={16} />
                  </Action>
                  <Action
                    secondary
                    onClick={() =>
                      telegram.length
                        ? onNavigate("connections")
                        : onConnect("telegram")
                    }
                  >
                    {telegram.length
                      ? "Configurar recebimento Telegram"
                      : "Conectar Telegram"}
                  </Action>
                  <Action secondary onClick={() => onNavigate("presence")}>
                    Disponibilidade
                  </Action>
                </div>
                <p className="setup-help">
                  Sem pessoas presentes, solicitações encaminhadas para a equipe
                  geram protocolo. Abrir o painel não marca presença
                  automaticamente.
                </p>
              </>
            )}
            {step === 3 && (
              <>
                <h3>Como o atendimento deve funcionar?</h3>
                <p>
                  Estas opções são salvas no perfil atual. Menus, especialistas
                  e permissões já cadastrados são preservados.
                </p>
                <form
                  className="setup-rules"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void saveRules();
                  }}
                >
                  <fieldset disabled={!snapshot || loading || saving}>
                    <label>
                      Bot principal
                      <select
                        value={draft.attendant_bot}
                        onChange={(e) =>
                          change("attendant_bot", e.target.value)
                        }
                      >
                        <option value="">
                          Sem bot principal · definir atendimento por linha
                        </option>
                        {snapshot?.bots.map((bot) => (
                          <option key={bot.id} value={bot.id}>
                            {bot.name}
                            {bot.enabled ? "" : " (desabilitado)"}
                          </option>
                        ))}
                        {draft.attendant_bot && !chosenBot && (
                          <option value={draft.attendant_bot}>
                            Bot salvo não encontrado
                          </option>
                        )}
                      </select>
                    </label>
                    {chosenBot && !chosenBot.enabled && (
                      <p className="setup-help">
                        Habilite este bot em Bots e ações internas antes de
                        usá-lo no atendimento.
                      </p>
                    )}
                    <label>
                      O que o bot precisa saber para atender?
                      <textarea
                        rows={4}
                        value={draft.instructions}
                        placeholder="Ex.: apresente-se, entenda o pedido e consulte o especialista financeiro para segunda via de boleto."
                        onChange={(e) => change("instructions", e.target.value)}
                      />
                    </label>
                    <div className="setup-fields">
                      <label>
                        Prazo para a primeira resposta, em horas
                        <input
                          type="number"
                          min="0.01"
                          max="8760"
                          step="any"
                          value={draft.protocol_response_hours}
                          placeholder="Ex.: 24"
                          onChange={(e) =>
                            change("protocol_response_hours", e.target.value)
                          }
                        />
                        <small>
                          Em branco: sem prazo padrão. Vale para novos
                          protocolos.
                        </small>
                      </label>
                      <label>
                        Orientação quando a equipe está ausente
                        <textarea
                          rows={3}
                          value={draft.absence_instructions}
                          onChange={(e) =>
                            change("absence_instructions", e.target.value)
                          }
                        />
                      </label>
                    </div>
                    <label className="setup-toggle">
                      <input
                        type="checkbox"
                        checked={draft.surveys_enabled}
                        onChange={(e) =>
                          change("surveys_enabled", e.target.checked)
                        }
                      />
                      <span>
                        <strong>Pedir avaliação ao concluir</strong>
                        <small>As respostas ficam em Avaliações.</small>
                      </span>
                    </label>
                    <label className="setup-toggle">
                      <input
                        type="checkbox"
                        checked={draft.jev_enabled}
                        onChange={(e) =>
                          change("jev_enabled", e.target.checked)
                        }
                      />
                      <span>
                        <strong>Usar JEV na tomada de decisão</strong>
                        <small>
                          O Atendente interpreta a solicitação; o JEV decide a
                          próxima ação. Exige a chave JEV cadastrada.
                        </small>
                      </span>
                    </label>
                    {draft.jev_enabled && (
                      <p className="setup-help">
                        Cadastre a chave nas regras de atendimento. Decisões
                        incertas ou indisponíveis são encaminhadas para uma
                        pessoa.
                      </p>
                    )}
                    <details className="setup-detail">
                      <summary>Atendimento pelo Telegram (opcional)</summary>
                      <p>
                        Selecione a conexão já cadastrada. O ID do grupo é
                        informado pelo Telegram e costuma começar com{" "}
                        <code>-100</code>.
                      </p>
                      <div className="setup-fields">
                        <label>
                          Conexão Telegram
                          <select
                            value={draft.telegram_connection}
                            onChange={(e) =>
                              change("telegram_connection", e.target.value)
                            }
                          >
                            <option value="">Não usar Telegram</option>
                            {telegram.map((connection) => (
                              <option key={connection.id} value={connection.id}>
                                {connection.name}
                              </option>
                            ))}
                            {draft.telegram_connection &&
                              !telegram.some(
                                (c) => c.id === draft.telegram_connection,
                              ) && (
                                <option value={draft.telegram_connection}>
                                  Conexão salva não encontrada
                                </option>
                              )}
                          </select>
                        </label>
                        <label>
                          ID do grupo Telegram
                          <input
                            value={draft.telegram_group}
                            placeholder="-100…"
                            onChange={(e) =>
                              change("telegram_group", e.target.value)
                            }
                          />
                        </label>
                      </div>
                      <label>
                        Como a pessoa responde ao cliente
                        <select
                          value={draft.reply_mode}
                          onChange={(e) => change("reply_mode", e.target.value)}
                        >
                          <option value="command">
                            Usando /responder (texto solto vira nota interna)
                          </option>
                          <option value="direct">
                            Texto direto depois de assumir a conversa
                          </option>
                        </select>
                      </label>
                    </details>
                    <button className="button" type="submit">
                      {saving ? (
                        <Loader2 size={16} className="spin" />
                      ) : (
                        <Check size={16} />
                      )}{" "}
                      Salvar regras
                    </button>
                    {dirty.current && (
                      <small className="setup-unsaved">
                        Há alterações nesta etapa que ainda não foram salvas.
                      </small>
                    )}
                  </fieldset>
                </form>
              </>
            )}
            {step === 4 && (
              <>
                <h3>Mostre ao cliente os caminhos disponíveis</h3>
                <div className="setup-option-grid">
                  <article>
                    <h4>Menus e destinos</h4>
                    <p>
                      Crie botões e submenus para setores, bots, links,
                      conteúdo, consulta de protocolos e avaliações. Escolha as
                      linhas onde cada opção aparece. Canais sem botões usam
                      texto numerado.
                    </p>
                    <Action secondary onClick={() => onNavigate("menus")}>
                      Configurar menus
                    </Action>
                  </article>
                  <article>
                    <h4>Avisos das filas</h4>
                    <p>
                      As filas e o atendimento já pertencem ao Fagoo. Configure os avisos e escolha a linha ou grupo em Integração com filas, nesta página.
                    </p>
                    <Action
                      secondary
                      onClick={() => onNavigate("queue-routing")}
                    >
                      Configurar avisos da fila
                    </Action>
                  </article>
                  <article>
                    <h4>Linhas para envio</h4>
                    <p>
                      Crie grupos de números e autorize os sistemas que podem
                      usá-los. Confira janela de atendimento, consumo e
                      permissão de envio pago antes de habilitar o roteamento.
                    </p>
                    <Action secondary onClick={() => onNavigate("router")}>
                      Configurar roteamento
                    </Action>
                  </article>
                  <article>
                    <h4>Contatos</h4>
                    <p>
                      Use o cadastro único de contatos do Fagoo para identificar as conversas.
                    </p>
                    <Action secondary onClick={() => onNavigate("contacts")}>
                      Abrir contatos
                    </Action>
                  </article>
                </div>
                <p className="setup-help">
                  O cliente pode consultar protocolos pelo menu, pelo bot ou
                  digitando o número. No WhatsApp, o telefone identifica os
                  protocolos do próprio cliente, inclusive em outras linhas
                  deste perfil.
                </p>
              </>
            )}
            {step === 5 && (
              <>
                <h3>Confira a configuração antes de começar</h3>
                <p>
                  Este resumo mostra o que está salvo. Para confirmar o
                  funcionamento, faça um atendimento de teste pelo WhatsApp.
                </p>
                <div className="setup-review">
                  {summary.map(([label, value, destination]) => (
                    <button
                      key={label}
                      type="button"
                      onClick={() => onNavigate(destination)}
                    >
                      <span>
                        <strong>{label}</strong>
                        <small>{value}</small>
                      </span>
                      <ChevronRight size={17} />
                    </button>
                  ))}
                  {!snapshot && (
                    <p>Use Verificar configuração para carregar o resumo.</p>
                  )}
                </div>
                <ol className="setup-instructions">
                  <li>
                    Envie uma mensagem de outro telefone para o número
                    conectado.
                  </li>
                  <li>
                    Confira a resposta do bot, as opções de menu e a consulta
                    interna a um especialista.
                  </li>
                  <li>
                    Peça uma pessoa e teste o recebimento pelo painel ou
                    Telegram.
                  </li>
                  <li>
                    Teste ausência da equipe, protocolo com prazo e avaliação de
                    conclusão.
                  </li>
                </ol>
                <div className="setup-status">
                  {snapshot
                    ? `Atendimento ${snapshot.status.enabled ? "ativo" : "pausado"}. A navegação pelo assistente não altera esse estado.`
                    : "O estado do atendimento ainda não foi consultado."}
                </div>
                <div className="setup-actions">
                  <Action onClick={() => onNavigate("settings")}>
                    Revisar e controlar atendimento <ArrowRight size={16} />
                  </Action>
                  <Action secondary onClick={() => onNavigate("conversations")}>
                    Abrir conversas
                  </Action>
                </div>
                <details className="setup-detail">
                  <summary>Manter o Fagoo atualizado</summary>
                  <p>
                    Em Sistema e atualizações, habilite as atualizações
                    automáticas e escolha o horário. Na janela escolhida, o
                    Wabotia verifica versões oficiais e instala usando a
                    autorização já cadastrada. Você também pode verificar e
                    atualizar manualmente.
                  </p>
                  <Action secondary onClick={() => onNavigate("system")}>
                    Sistema e atualizações
                  </Action>
                </details>
              </>
            )}
            <footer className="setup-footer">
              <Action
                secondary
                disabled={step === 0 || saving}
                onClick={() => go(step - 1)}
              >
                <ArrowLeft size={16} /> Voltar
              </Action>
              <span>
                Etapa {step + 1} de {steps.length}
              </span>
              {step < steps.length - 1 ? (
                <Action disabled={saving} onClick={() => go(step + 1)}>
                  Continuar <ArrowRight size={16} />
                </Action>
              ) : (
                <Action secondary onClick={() => onNavigate("overview")}>
                  Ir para o início
                </Action>
              )}
            </footer>
          </section>
        </>
      )}
    </div>
  );
}
