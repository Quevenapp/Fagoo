import React, { useEffect, useState, useRef } from "react";
type Row = Record<string, any>;
const parse = (v: any) => {
  try {
    return typeof v === "string" ? JSON.parse(v) : v || {};
  } catch {
    return {};
  }
};
export function WhatsAppGroups({
  api,
  root,
  rows,
  openConversation,
  demo,
}: {
  api: any;
  root: string;
  rows: Row[];
  openConversation: (r: Row) => void;
  demo: boolean;
}) {
  const [connections, setConnections] = useState<Row[]>([]),
    [connection, setConnection] = useState(""),
    [action, setAction] = useState("sync"),
    [subject, setSubject] = useState(""),
    [participants, setParticipants] = useState(""),
    [invite, setInvite] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [jobs, setJobs] = useState<Row[]>([]),
    [notice, setNotice] = useState("");
  const intent = useRef({ body: "", key: crypto.randomUUID() });
  async function load() {
    if (demo) return;
    const [status, ops] = await Promise.all([
      api(root + "/status"),
      api(root + "/group-operations"),
    ]);
    setConnections(
      status.connections.filter((c: Row) => ["meta", "qr"].includes(c.kind)),
    );
    setJobs(ops.data || []);
  }
  useEffect(() => {
    load().catch((e) => setError(e.message));
    const timer = setInterval(() => load().catch(() => {}), 5000);
    return () => clearInterval(timer);
  }, [root]);
  async function send(data: Row) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const body = JSON.stringify(data);
      if (intent.current.body !== body)
        intent.current = { body, key: crypto.randomUUID() };
      await api(
        root + "/groups/actions",
        "POST",
        data,
        undefined,
        intent.current.key,
      );
      intent.current = { body: "", key: crypto.randomUUID() };
      setNotice(
        "Operação registrada. Acompanhe o resultado abaixo; a lista de conversas será atualizada.",
      );
      await load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="groups-page">
      <section className="card">
        <h2>Grupos do WhatsApp</h2>
        <p>
          Use QR para participar de grupos existentes. Na Meta, é necessário ter
          acesso à API de Grupos; a empresa cria o grupo e convida participantes
          por link.
        </p>
        <div className="special-fields">
          <label>
            Conexão
            <select
              value={connection}
              onChange={(e) => setConnection(e.target.value)}
            >
              <option value="">Escolher conexão</option>
              {connections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} · {c.kind === "qr" ? "QR" : "Meta"}
                </option>
              ))}
            </select>
          </label>
          <label>
            O que deseja fazer?
            <select value={action} onChange={(e) => setAction(e.target.value)}>
              <option value="sync">Buscar meus grupos</option>
              <option value="create">Criar grupo</option>
              <option value="join">Entrar por convite (QR)</option>
            </select>
          </label>
        </div>
        {action === "create" && (
          <div className="special-fields">
            <label>
              Nome do grupo
              <input
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                maxLength={128}
              />
            </label>
            {connections.find((c) => c.id === connection)?.kind === "qr" && (
              <label>
                Participantes (telefones com DDI, separados por vírgula)
                <input
                  value={participants}
                  onChange={(e) => setParticipants(e.target.value)}
                  placeholder="5511999999999, 5521999999999"
                />
              </label>
            )}
          </div>
        )}
        {action === "join" && (
          <label>
            Link de convite
            <input
              value={invite}
              onChange={(e) => setInvite(e.target.value)}
              placeholder="https://chat.whatsapp.com/…"
            />
          </label>
        )}
        <button
          className="primary"
          disabled={busy || !connection || demo}
          onClick={() =>
            send({
              connection_id: connection,
              action,
              subject,
              participants: participants
                .split(",")
                .map((p) => p.trim())
                .filter(Boolean),
              invite,
            })
          }
        >
          {busy
            ? "Registrando…"
            : action === "sync"
              ? "Buscar grupos"
              : action === "create"
                ? "Criar grupo"
                : "Entrar por convite"}
        </button>
        {error && (
          <p className="notice error" role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p className="notice" role="status">
            {notice}
          </p>
        )}
        <div className="group-list">
          {rows.map((row) => (
            <button key={row.id} onClick={() => openConversation(row)}>
              <strong>{row.title || row.external_id}</strong>
              <small>
                IA:{" "}
                {row.bot_policy === "off"
                  ? "desligada"
                  : row.bot_policy === "all"
                    ? "todas as mensagens"
                    : "menção ou /bot"}
              </small>
            </button>
          ))}
        </div>
        {!rows.length && (
          <p>
            Os grupos aparecem quando chegam mensagens ou após buscar seus
            grupos.
          </p>
        )}
      </section>
      <section className="card">
        <h3>Operações recentes</h3>
        {jobs.map((job) => (
          <div className="group-job" key={job.id}>
            <strong>
              {(
                {
                  sync: "Buscar grupos",
                  create: "Criar grupo",
                  join: "Entrar por convite",
                  refresh: "Atualizar grupo",
                  invite: "Convite",
                  subject: "Nome",
                  description: "Descrição",
                  participants: "Participantes",
                  leave: "Sair do grupo",
                  announcement: "Permissões de envio",
                } as Row
              )[job.operation] || job.operation}{" "}
              ·{" "}
              {
                (
                  {
                    pending: "Aguardando conector",
                    sending: "Executando",
                    sent: "Concluída",
                    failed: "Falhou",
                    unknown: "Sem confirmação",
                  } as Row
                )[job.status]
              }
            </strong>
            {job.error && <p>{job.error}</p>}
            {job.status === "unknown" && (
              <>
                <button
                  disabled={busy}
                  onClick={async () => {
                    if (
                      confirm(
                        "Você conferiu no WhatsApp que a operação foi concluída?",
                      )
                    ) {
                      await api(
                        root + `/group-operations/${job.id}/reconcile`,
                        "POST",
                        { confirmed: true, status: "sent" },
                      );
                      load();
                    }
                  }}
                >
                  Confirmar que foi concluída
                </button>
                <button
                  disabled={busy}
                  onClick={async () => {
                    if (
                      confirm(
                        "Você conferiu no WhatsApp que nada foi alterado?",
                      )
                    ) {
                      await api(
                        root + `/group-operations/${job.id}/reconcile`,
                        "POST",
                        { confirmed: true, status: "failed" },
                      );
                      load();
                    }
                  }}
                >
                  Confirmar que não ocorreu
                </button>
              </>
            )}
            {parse(job.result).participants && (
              <p>
                {parse(job.result)
                  .participants.map((p: Row) => `${p.jid || p.id}: ${p.status}`)
                  .join(" · ")}
              </p>
            )}
            {parse(job.result).invite_link && (
              <a
                href={parse(job.result).invite_link}
                target="_blank"
                rel="noreferrer"
              >
                Abrir link de convite
              </a>
            )}
            {job.status === "sent" && parse(job.result).cursor && (
              <button
                disabled={busy}
                onClick={() =>
                  send({
                    connection_id: job.connection_id,
                    action: "sync",
                    cursor: parse(job.result).cursor,
                  })
                }
              >
                Buscar mais grupos
              </button>
            )}
          </div>
        ))}
      </section>
    </div>
  );
}
export function GroupControls({
  api,
  root,
  c,
  refresh,
}: {
  api: any;
  root: string;
  c: Row;
  refresh: () => Promise<any>;
}) {
  const [action, setAction] = useState("refresh"),
    [value, setValue] = useState(""),
    [operation, setOperation] = useState("remove"),
    [busy, setBusy] = useState(false),
    [note, setNote] = useState("");
  const intent = useRef({ body: "", key: crypto.randomUUID() });
  async function send() {
    if (
      ["leave", "participants"].includes(action) &&
      !confirm("Confirmar esta alteração no grupo do WhatsApp?")
    )
      return;
    setBusy(true);
    setNote("");
    try {
      const data = {
        action,
        subject: value,
        description: value,
        participants: value
          .split(",")
          .map((p) => p.trim())
          .filter(Boolean),
        operation,
        enabled: value === "true",
      };
      const body = JSON.stringify(data);
      if (intent.current.body !== body)
        intent.current = { body, key: crypto.randomUUID() };
      const r = await api(
        `${root}/groups/${c.id}/actions`,
        "POST",
        data,
        undefined,
        intent.current.key,
      );
      intent.current = { body: "", key: crypto.randomUUID() };
      setNote(
        r.result?.invite_link ||
          "Operação registrada. Consulte Grupos para acompanhar o resultado.",
      );
      await refresh();
    } catch (e: any) {
      setNote(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="group-controls">
      <summary>Gerenciar este grupo</summary>
      <label>
        Ação
        <select
          value={action}
          onChange={(e) => {
            setAction(e.target.value);
            setValue("");
          }}
        >
          <option value="refresh">Atualizar participantes e permissões</option>
          <option value="invite">Obter link de convite</option>
          <option value="subject">Alterar nome</option>
          <option value="description">Alterar descrição</option>
          <option value="participants">Alterar participantes</option>
          <option value="announcement">Quem pode enviar (QR)</option>
          <option value="leave">Sair do grupo (QR)</option>
        </select>
      </label>
      {action === "participants" && (
        <select
          aria-label="Operação dos participantes"
          value={operation}
          onChange={(e) => setOperation(e.target.value)}
        >
          <option value="remove">Remover</option>
          <option value="add">Adicionar (QR)</option>
          <option value="promote">Tornar administrador (QR)</option>
          <option value="demote">Remover administrador (QR)</option>
        </select>
      )}
      {["subject", "description", "participants"].includes(action) && (
        <label>
          {action === "participants"
            ? "Telefones/IDs separados por vírgula"
            : "Novo texto"}
          <input value={value} onChange={(e) => setValue(e.target.value)} />
        </label>
      )}
      {action === "announcement" && (
        <select
          aria-label="Quem pode enviar"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        >
          <option value="">Selecione</option>
          <option value="true">Só administradores</option>
          <option value="false">Todos</option>
        </select>
      )}
      <button disabled={busy} onClick={send}>
        {busy ? "Registrando…" : "Aplicar"}
      </button>
      {note && <p role="status">{note}</p>}
    </details>
  );
}
