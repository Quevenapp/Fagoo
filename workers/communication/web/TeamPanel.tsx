import React, { useEffect, useRef, useState } from "react";
import { Bot, MessageCircle, Send, Users } from "lucide-react";

type Row = Record<string, any>;
const demoTeam = [
  { id: "demo-user", kind: "user", name: "Administrador", online: true },
  { id: "demo-person", kind: "user", name: "Ana · Atendimento", online: false },
  {
    id: "bot:demo-bot",
    kind: "bot",
    name: "Atendente",
    online: true,
    bot_id: "demo-bot",
  },
];
const statuses: Record<string, string> = {
  queued: "Aguardando o bot",
  running: "Bot respondendo…",
  starting: "Iniciando resposta…",
  failed: "O bot não conseguiu responder",
  unknown: "Resposta sem confirmação",
  cancelled: "Resposta cancelada",
};
export function TeamPanel({
  api,
  root,
  demo,
  me,
}: {
  api: any;
  root: string;
  demo: boolean;
  me: Row;
}) {
  const [team, setTeam] = useState<Row[]>(demo ? demoTeam : []),
    [chats, setChats] = useState<Row[]>([]),
    [selected, setSelected] = useState<Row | null>(null),
    [detail, setDetail] = useState<Row | null>(null);
  const [text, setText] = useState(""),
    [query, setQuery] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const active = useRef<string | null>(null),
    mounted = useRef(true),
    intents = useRef(new Map<string, string>()),
    pending = useRef<{ path: string; body: Row; key: string } | null>(null);
  async function write(path: string, body: Row, key?: string) {
    const intent = path + JSON.stringify(body);
    if (!intents.current.has(intent))
      intents.current.set(intent, key || crypto.randomUUID());
    try {
      const result = await api(
        root + path,
        "POST",
        body,
        undefined,
        intents.current.get(intent),
      );
      intents.current.delete(intent);
      return result;
    } catch (e: any) {
      if (
        e.status >= 400 &&
        e.status < 500 &&
        !["operation_unknown", "idempotency_conflict"].includes(e.code)
      )
        intents.current.delete(intent);
      throw e;
    }
  }
  async function refreshDirectory() {
    if (demo) return;
    const [t, c] = await Promise.all([
      api(root + "/team"),
      api(root + "/internal-chats"),
    ]);
    if (mounted.current) {
      setTeam(t.data);
      setChats(c.data);
    }
  }
  async function refreshChat(id: string) {
    const next = await api(root + "/internal-chats/" + id);
    if (mounted.current && active.current === id) setDetail(next);
  }
  useEffect(() => {
    mounted.current = true;
    let loading = false;
    const refresh = async () => {
      if (document.hidden || loading || demo) return;
      loading = true;
      try {
        await refreshDirectory();
        if (active.current) await refreshChat(active.current);
      } catch (e: any) {
        if (mounted.current) setError(e.message);
      } finally {
        loading = false;
      }
    };
    refresh();
    const timer = setInterval(refresh, 4000);
    return () => {
      mounted.current = false;
      clearInterval(timer);
    };
  }, [root, demo]);
  async function open(peer: Row) {
    if (busy || pending.current) return;
    setBusy(true);
    setError("");
    setText("");
    setDetail(null);
    setSelected(peer);
    active.current = null;
    try {
      if (demo) {
        setDetail({
          id: "demo-chat",
          peer,
          messages: [
            {
              id: "example",
              author: peer.id,
              text: "Esta conversa acontece dentro do Wabotia. As mensagens não são enviadas ao cliente no WhatsApp.",
              created: Date.now(),
            },
          ],
        });
      } else {
        const chat = await write("/internal-chats", { peer_id: peer.id });
        active.current = chat.id;
        await refreshChat(chat.id);
        await refreshDirectory();
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function openHistory(chat: Row) {
    if (busy || pending.current) return;
    setBusy(true);
    setError("");
    setText("");
    setDetail(null);
    setSelected(chat.peer);
    active.current = chat.id;
    try {
      await refreshChat(chat.id);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function send() {
    if (!detail || (!text.trim() && !pending.current)) return;
    if (demo) {
      setNotice("Demonstração: nenhuma mensagem foi enviada.");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    pending.current ||= {
      path: `/internal-chats/${detail.id}/messages`,
      body: { text: text.trim() },
      key: crypto.randomUUID(),
    };
    try {
      const request = pending.current;
      await write(request.path, request.body, request.key);
      pending.current = null;
      setText("");
      await refreshChat(detail.id);
      await refreshDirectory();
    } catch (e: any) {
      if (
        e.status >= 400 &&
        e.status < 500 &&
        !["operation_unknown", "idempotency_conflict"].includes(e.code)
      )
        pending.current = null;
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const current = team.find((p) => p.id === selected?.id) || selected;
  return (
    <div className="team-panel">
      <section className="card">
        <div className="section-heading">
          <div>
            <h2>Equipe e conversas internas</h2>
            <p>
              Converse com pessoas e bots do perfil. Estas mensagens ficam
              dentro do Wabotia.
            </p>
          </div>
        </div>
        <p>
          O estado das pessoas acompanha sua disponibilidade. Para bots,
          acompanha a habilitação e a conexão com o Hermes.
        </p>
        {error && (
          <div className="notice error" role="alert">
            {error}
          </div>
        )}
        {notice && (
          <div className="notice" role="status">
            {notice}
          </div>
        )}
      </section>
      <div className="team-layout">
        <section className="card team-directory">
          <label>
            Buscar contato interno
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Pessoa ou bot"
            />
          </label>
          <div className="team-contact-list">
            {team
              .filter(
                (p) =>
                  p.id !== me.id &&
                  p.name
                    .toLocaleLowerCase()
                    .includes(query.toLocaleLowerCase()),
              )
              .map((p) => (
                <button
                  className={
                    "team-contact " + (selected?.id === p.id ? "selected" : "")
                  }
                  key={p.id}
                  disabled={busy || !!pending.current}
                  onClick={() => open(p)}
                >
                  <span className="team-avatar">
                    {p.kind === "bot" ? <Bot size={20} /> : <Users size={20} />}
                  </span>
                  <span>
                    <strong>{p.name}</strong>
                    <small>
                      <i
                        className={
                          "presence-dot " + (p.online ? "online" : "offline")
                        }
                      />
                      {p.online ? "Online" : "Offline"} ·{" "}
                      {p.kind === "bot" ? "Bot" : "Pessoa"}
                    </small>
                  </span>
                </button>
              ))}
            {!team.length && (
              <p>Nenhum contato interno disponível neste perfil.</p>
            )}
          </div>
          {!!chats.length && (
            <>
              <h3>Conversas recentes</h3>
              <div className="team-contact-list">
                {chats.map((chat) => (
                  <button
                    className="team-contact"
                    key={chat.id}
                    disabled={busy || !!pending.current}
                    onClick={() => openHistory(chat)}
                  >
                    <MessageCircle size={18} />
                    <span>
                      <strong>
                        {chat.peer?.name || "Contato indisponível"}
                      </strong>
                      <small>
                        {new Date(chat.updated).toLocaleString("pt-BR", {
                          dateStyle: "short",
                          timeStyle: "short",
                        })}
                      </small>
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}
        </section>
        <section className="card internal-chat">
          {current ? (
            <>
              <header className="section-heading">
                <div>
                  <h2>{current.name}</h2>
                  <small>
                    {current.kind === "bot"
                      ? "Conversa com bot"
                      : "Conversa entre pessoas"}{" "}
                    · {current.online ? "Online" : "Offline"}
                  </small>
                </div>
                <MessageCircle size={22} />
              </header>
              <div
                className="internal-messages"
                aria-label="Mensagens internas"
                aria-live="polite"
              >
                {(detail?.messages || []).map((message: Row) => (
                  <article
                    key={message.id}
                    className={
                      "internal-message " +
                      (message.author === me.id ? "own" : "")
                    }
                  >
                    <small>
                      {message.author === me.id ? "Você" : current.name}
                    </small>
                    <p>{message.text}</p>
                    <small>
                      {new Date(message.created).toLocaleString("pt-BR", {
                        dateStyle: "short",
                        timeStyle: "short",
                      })}
                      {statuses[message.status] &&
                        ` · ${statuses[message.status]}`}
                    </small>
                  </article>
                ))}
                {detail && !detail.messages?.length && (
                  <p>Inicie a conversa com {current.name}.</p>
                )}
                {!detail && <p>Abrindo conversa…</p>}
              </div>
              <form
                className="internal-composer"
                onSubmit={(e) => {
                  e.preventDefault();
                  send();
                }}
              >
                <label>
                  Mensagem interna
                  <textarea
                    maxLength={12000}
                    rows={3}
                    value={text}
                    disabled={busy || !!pending.current || !detail}
                    onChange={(e) => setText(e.target.value)}
                    placeholder="Escreva para este contato"
                  />
                </label>
                <button
                  className="primary"
                  disabled={
                    busy || !detail || (!text.trim() && !pending.current)
                  }
                >
                  <Send size={16} />
                  {pending.current ? "Tentar novamente" : "Enviar"}
                </button>
              </form>
              {pending.current && !busy && (
                <p>
                  O envio ainda não foi confirmado. Tentar novamente reutiliza o
                  mesmo pedido para evitar duplicação.
                </p>
              )}
            </>
          ) : (
            <div className="internal-empty">
              <MessageCircle size={38} />
              <h3>Sua equipe, em uma conversa</h3>
              <p>Selecione uma pessoa ou bot para conversar internamente.</p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
