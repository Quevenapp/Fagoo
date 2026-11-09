import React, { useEffect, useRef, useState } from "react";
import {
  BookUser,
  Download,
  Loader2,
  Plus,
  Search,
  Upload,
  X,
} from "lucide-react";

type Row = Record<string, any>;
type Api = (
  path: string,
  method?: string,
  body?: any,
  signal?: AbortSignal,
  key?: string,
) => Promise<any>;
const blank = { name: "", phone: "", email: "", company: "", notes: "" };
export const demoContacts = [
  {
    ...blank,
    id: "contact-demo-1",
    name: "Marina Oliveira",
    phone: "5511999990000",
    email: "marina@example.com",
    company: "Empresa de exemplo",
    notes: "Dados fictícios para conhecer a agenda.",
    source: "conversation",
    namespace: "team",
    version: 1,
    conversation_count: 1,
  },
  {
    ...blank,
    id: "contact-demo-2",
    name: "Pedro Santos",
    phone: "5511988880000",
    email: "pedro@example.com",
    company: "Loja de exemplo",
    source: "csv",
    namespace: "team",
    version: 1,
    conversation_count: 0,
  },
];
const sourceName = (source: string) =>
  ({ csv: "CSV", conversation: "Conversa", manual: "Cadastro manual" })[
    source
  ] || source;

function Dialog({
  title,
  close,
  busy,
  children,
  wide = false,
}: {
  title: string;
  close: () => void;
  busy: boolean;
  children: React.ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    return () => previous?.focus();
  }, []);
  return (
    <div className="modal-backdrop" onClick={() => !busy && close()}>
      <section
        className={
          "modal contacts-dialog" + (wide ? " contacts-dialog-wide" : "")
        }
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape" && !busy) close();
          if (e.key !== "Tab") return;
          const elements = Array.from(
            ref.current!.querySelectorAll<HTMLElement>(
              "button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), select:not([disabled])",
            ),
          );
          const first = elements[0],
            last = elements.at(-1);
          if (!first) {
            e.preventDefault();
            return;
          }
          if (
            e.shiftKey &&
            (document.activeElement === first ||
              document.activeElement === ref.current)
          ) {
            e.preventDefault();
            last?.focus();
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }}
      >
        <header>
          <h2>{title}</h2>
          <button
            className="icon-button"
            aria-label="Fechar"
            disabled={busy}
            onClick={close}
          >
            <X />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}

// Retrying an identical action after a lost response must use the same receipt.
function useWrite(api: Api) {
  const receipts = useRef(new Map<string, string>());
  return (path: string, method: string, body: any) => {
    const signature = JSON.stringify([path, method, body]);
    if (!receipts.current.has(signature))
      receipts.current.set(signature, crypto.randomUUID());
    return api(path, method, body, undefined, receipts.current.get(signature));
  };
}

export function ContactEditor({
  api,
  root,
  contact,
  conversation,
  conversations = [],
  demo,
  close,
  saved,
  openConversation,
}: {
  api: Api;
  root: string;
  contact?: Row | null;
  conversation?: Row;
  conversations?: Row[];
  demo: boolean;
  close: () => void;
  saved: (message: string) => void;
  openConversation?: (row: Row) => void;
}) {
  const [form, setForm] = useState<Row>(() => ({
    ...blank,
    ...contact,
    phone:
      contact?.phone ||
      (/^[+\d\s().-]+$/.test(conversation?.phone || "")
        ? conversation?.phone
        : "") ||
      "",
  }));
  const [mode, setMode] = useState("new"),
    [q, setQ] = useState(""),
    [matches, setMatches] = useState<Row[]>([]),
    [chosen, setChosen] = useState("");
  const [busy, setBusy] = useState(false),
    [searching, setSearching] = useState(false),
    [error, setError] = useState("");
  const write = useWrite(api);
  const namespace = conversation?.external_namespace?.startsWith("app:")
    ? conversation.external_namespace
    : "team";
  useEffect(() => {
    if (mode !== "existing") return;
    if (demo) {
      setMatches(
        demoContacts.filter((c) =>
          c.name.toLowerCase().includes(q.toLowerCase()),
        ),
      );
      return;
    }
    const controller = new AbortController();
    setSearching(true);
    const timer = setTimeout(() => {
      api(
        root +
          "/contacts?limit=50&namespace=" +
          encodeURIComponent(namespace) +
          "&q=" +
          encodeURIComponent(q),
        "GET",
        undefined,
        controller.signal,
      )
        .then((result) => {
          setMatches(result.data);
          setError("");
        })
        .catch((e) => {
          if (e.name !== "AbortError") setError(e.message);
        })
        .finally(() => {
          if (!controller.signal.aborted) setSearching(false);
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [q, mode, root, namespace, demo]);
  const act = async (unlink = false) => {
    if (busy || demo) return;
    setBusy(true);
    setError("");
    try {
      if (unlink)
        await write(
          root + `/conversations/${conversation!.id}/contact`,
          "DELETE",
          { expected_contact_id: contact!.id },
        );
      else if (contact)
        await write(root + "/contacts/" + contact.id, "PATCH", {
          ...Object.fromEntries(Object.keys(blank).map((k) => [k, form[k]])),
          expected_version: contact.version,
        });
      else if (conversation)
        await write(
          root + `/conversations/${conversation.id}/contact`,
          "PUT",
          mode === "existing" ? { contact_id: chosen } : form,
        );
      else await write(root + "/contacts", "POST", form);
      saved(
        unlink
          ? "Contato desvinculado. Ele continua salvo na agenda."
          : "Contato salvo na agenda.",
      );
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={
        contact
          ? "Editar contato"
          : conversation
            ? "Salvar contato da conversa"
            : "Novo contato"
      }
      close={close}
      busy={busy}
    >
      {demo && (
        <p className="notice">
          Dados fictícios. Entre na sua instalação para salvar contatos.
        </p>
      )}
      {conversation && !contact && (
        <div
          className="contact-mode"
          role="group"
          aria-label="Como salvar o contato"
        >
          <button
            type="button"
            className={mode === "new" ? "button" : "button secondary"}
            disabled={busy}
            onClick={() => {
              setMode("new");
              setError("");
            }}
          >
            Criar novo contato
          </button>
          <button
            type="button"
            className={mode === "existing" ? "button" : "button secondary"}
            disabled={busy}
            onClick={() => {
              setMode("existing");
              setError("");
            }}
          >
            Vincular contato existente
          </button>
        </div>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          act();
        }}
      >
        <fieldset disabled={busy} className="contact-fields">
          {mode === "existing" && !contact ? (
            <>
              <label className="field">
                <span>Buscar na agenda</span>
                <input
                  value={q}
                  onChange={(e) => {
                    setQ(e.target.value);
                    setChosen("");
                  }}
                  placeholder="Nome, telefone, e-mail ou empresa"
                />
              </label>
              <p>
                Escolha o contato desta conversa. Se houver muitos resultados,
                digite o nome completo.
              </p>
              {searching ? (
                <p role="status">Buscando contatos…</p>
              ) : (
                <div className="contact-matches">
                  {matches.map((row) => (
                    <label key={row.id} className="contact-match">
                      <input
                        type="radio"
                        name="contact"
                        value={row.id}
                        checked={chosen === row.id}
                        onChange={() => setChosen(row.id)}
                        required
                      />
                      <span>
                        <strong>{row.name}</strong>
                        <small>
                          {[row.phone, row.email, row.company]
                            .filter(Boolean)
                            .join(" · ") || "Sem dados adicionais"}
                        </small>
                      </span>
                    </label>
                  ))}
                  {!matches.length && (
                    <p>Nenhum contato encontrado. Você pode criar um novo.</p>
                  )}
                </div>
              )}
            </>
          ) : (
            <>
              {(
                [
                  ["name", "Nome", "text", 120],
                  ["phone", "Telefone com DDI e DDD", "tel", 40],
                  ["email", "E-mail", "email", 254],
                  ["company", "Empresa", "text", 160],
                ] as const
              ).map(([key, label, type, max]) => (
                <label className="field" key={key}>
                  <span>
                    {label}
                    {key !== "name" && <small> (opcional)</small>}
                  </span>
                  <input
                    type={type}
                    required={key === "name"}
                    maxLength={max}
                    value={form[key]}
                    onChange={(e) =>
                      setForm({ ...form, [key]: e.target.value })
                    }
                    placeholder={
                      key === "phone" ? "Ex.: +55 11 99999-0000" : undefined
                    }
                  />
                </label>
              ))}
              <label className="field">
                <span>
                  Observações <small>(opcional)</small>
                </span>
                <textarea
                  maxLength={2000}
                  rows={3}
                  value={form.notes}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })}
                />
              </label>
            </>
          )}
        </fieldset>
        {contact && (
          <p className="muted">
            As alterações valem para todas as conversas vinculadas a este
            contato.
          </p>
        )}
        {error && (
          <p role="alert" className="notice error">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button
            className="button secondary"
            type="button"
            disabled={busy}
            onClick={close}
          >
            Cancelar
          </button>
          <button
            className="button"
            type="submit"
            disabled={busy || demo || (mode === "existing" && !chosen)}
          >
            {busy ? (
              <>
                <Loader2 className="spin" size={16} /> Salvando…
              </>
            ) : mode === "existing" ? (
              "Vincular contato"
            ) : (
              "Salvar contato"
            )}
          </button>
        </div>
      </form>
      {contact && conversation && (
        <div className="contact-unlink">
          <p>
            Se este for o contato errado, desvincule e escolha outro. O cadastro
            e o histórico permanecem salvos.
          </p>
          <button
            className="button secondary"
            type="button"
            disabled={busy || demo}
            onClick={() => act(true)}
          >
            Desvincular desta conversa
          </button>
        </div>
      )}
      {contact && !conversation && openConversation && (
        <div className="contact-history">
          <h3>Conversas vinculadas</h3>
          {conversations.length ? (
            conversations.map((row) => (
              <button
                key={row.id}
                className="contact-history-link"
                disabled={busy}
                onClick={() => openConversation(row)}
              >
                <span>{row.phone || row.external_id}</span>
                <small>
                  {new Date(row.updated).toLocaleDateString("pt-BR", {
                    timeZone: "America/Sao_Paulo",
                  })}
                </small>
              </button>
            ))
          ) : (
            <p>
              Nenhuma conversa vinculada ainda. Abra uma conversa e use “Salvar
              contato”.
            </p>
          )}
          {conversations.length === 50 && (
            <p>Mostrando as 50 conversas mais recentes.</p>
          )}
        </div>
      )}
    </Dialog>
  );
}

function CsvImport({
  api,
  root,
  demo,
  close,
  saved,
}: {
  api: Api;
  root: string;
  demo: boolean;
  close: () => void;
  saved: (message: string) => void;
}) {
  const [csv, setCsv] = useState(""),
    [filename, setFilename] = useState(""),
    [preview, setPreview] = useState<Row | null>(null);
  const [busy, setBusy] = useState(false),
    [stage, setStage] = useState(""),
    [error, setError] = useState("");
  const write = useWrite(api);
  async function choose(file?: File) {
    setPreview(null);
    setCsv("");
    setError("");
    setFilename(file?.name || "");
    if (!file) return;
    if (file.size > 1024 * 1024) {
      setError("Escolha um CSV de até 1 MB.");
      return;
    }
    setBusy(true);
    setStage("Conferindo o arquivo…");
    try {
      const content = await file.text();
      const data = await api(root + "/contacts/import/preview", "POST", {
        csv: content,
      });
      setCsv(content);
      setPreview(data);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    if (demo || busy || !preview || preview.errors.length || !preview.new_count)
      return;
    setBusy(true);
    setStage("Importando contatos…");
    setError("");
    try {
      const result = await write(root + "/contacts/import", "POST", { csv });
      saved(
        `${result.imported} contato(s) importado(s). ${result.skipped} linha(s) idêntica(s) ignorada(s).`,
      );
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog title="Importar contatos por CSV" close={close} busy={busy} wide>
      <p>
        Baixe o modelo, substitua o exemplo e salve como{" "}
        <strong>CSV UTF-8</strong>. Aceitamos vírgula ou ponto e vírgula, até{" "}
        <strong>500 contatos e 1 MB</strong> por arquivo.
      </p>
      <a className="text-link" href="/modelo-contatos.csv" download>
        <Download size={16} /> Baixar modelo de CSV
      </a>
      <p>
        Nome é obrigatório. Telefone, e-mail, empresa e observações são
        opcionais. No telefone, inclua DDI e DDD (ex.: 5511999990000).
      </p>
      {demo && (
        <p className="notice">
          A importação fica disponível na sua instalação. Esta é uma tela de
          referência.
        </p>
      )}
      <label className="field">
        <span>Arquivo CSV</span>
        <input
          type="file"
          accept=".csv,text/csv"
          disabled={busy || demo}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            choose(file);
          }}
        />
      </label>
      {busy && (
        <p role="status" className="contact-progress">
          <Loader2 size={17} className="spin" />
          {stage}
        </p>
      )}
      {error && (
        <p role="alert" className="notice error">
          {error}
        </p>
      )}
      {preview && (
        <>
          <div className="contact-import-summary" role="status">
            <strong>{preview.new_count} novos</strong>
            <span>{preview.skipped_count} idênticos ignorados</span>
            <span>{preview.errors.length} com erro</span>
          </div>
          <p className="muted">
            Arquivo: {filename}. Linhas idênticas já importadas são ignoradas.
            Cadastros com dados diferentes são mantidos separados, mesmo com o
            mesmo telefone.
          </p>
          {preview.ignored_columns.length > 0 && (
            <p className="notice">
              Colunas ignoradas: {preview.ignored_columns.join(", ")}. Use nome,
              telefone, email, empresa e observacoes.
            </p>
          )}
          {preview.errors.length > 0 && (
            <div className="notice error">
              <div>
                <strong>
                  Nenhum contato foi salvo. Corrija o arquivo e selecione-o
                  novamente.
                </strong>
                <ul>
                  {preview.errors.slice(0, 20).map((e: Row) => (
                    <li key={e.line}>
                      Linha {e.line}: {e.message}
                    </li>
                  ))}
                </ul>
                {preview.errors.length > 20 && (
                  <p>
                    Mostrando os primeiros 20 erros de {preview.errors.length}.
                  </p>
                )}
              </div>
            </div>
          )}
          <div className="contact-table-wrap">
            <table className="contact-table">
              <caption>Prévia dos contatos — até 100 linhas</caption>
              <thead>
                <tr>
                  <th>Linha</th>
                  <th>Nome</th>
                  <th>Telefone / e-mail</th>
                  <th>Resultado</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.slice(0, 100).map((row: Row) => (
                  <tr key={row.line}>
                    <td>{row.line}</td>
                    <td>{row.values.name}</td>
                    <td>
                      {row.values.phone || "—"}
                      <small>{row.values.email}</small>
                    </td>
                    <td>
                      {row.duplicate ? "Ignorado: idêntico" : "Novo contato"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p>
            Importar apenas cadastra os contatos. Não envia mensagens nem
            concede consentimento.
          </p>
          {!preview.new_count && !preview.errors.length && (
            <p className="notice">
              Todos os contatos deste arquivo já foram importados.
            </p>
          )}
        </>
      )}
      <div className="modal-actions">
        <button className="button secondary" disabled={busy} onClick={close}>
          Fechar
        </button>
        <button
          className="button"
          disabled={
            busy || demo || !preview?.new_count || preview.errors.length > 0
          }
          onClick={save}
        >
          <Upload size={16} />
          {busy
            ? stage
            : `Importar${preview?.new_count ? " " + preview.new_count + " contato(s)" : " contatos"}`}
        </button>
      </div>
    </Dialog>
  );
}

export function ContactsPanel({
  api,
  root,
  demo,
  openConversation,
}: {
  api: Api;
  root: string;
  demo: boolean;
  openConversation: (row: Row) => void;
}) {
  const [rows, setRows] = useState<Row[]>([]),
    [q, setQ] = useState(""),
    [search, setSearch] = useState("");
  const [cursor, setCursor] = useState(""),
    [next, setNext] = useState<string | null>(null),
    [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [editor, setEditor] = useState<Row | null>(null),
    [importing, setImporting] = useState(false);
  const opening = useRef(false);
  useEffect(() => {
    if (demo) {
      setRows(
        demoContacts.filter((c) =>
          (c.name + c.phone + c.email + c.company)
            .toLowerCase()
            .includes(search.toLowerCase()),
        ),
      );
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError("");
    api(
      root +
        "/contacts?q=" +
        encodeURIComponent(search) +
        "&cursor=" +
        encodeURIComponent(cursor),
      "GET",
      undefined,
      controller.signal,
    )
      .then((result) => {
        setRows(result.data);
        setNext(result.next_cursor);
      })
      .catch((e) => {
        if (e.name !== "AbortError") setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [search, cursor, revision, root, demo]);
  async function edit(row: Row) {
    if (opening.current) return;
    if (demo) {
      setEditor({
        contact: row,
        conversations: row.conversation_count
          ? [
              {
                id: "demo-1",
                external_id: row.name,
                phone: row.phone,
                contact_name: row.name,
                contact_id: row.id,
                state: "waiting",
                updated: Date.now(),
                external_namespace: "meta:demo",
              },
            ]
          : [],
      });
      return;
    }
    opening.current = true;
    setError("");
    try {
      setEditor(await api(root + "/contacts/" + row.id));
    } catch (e: any) {
      setError(e.message);
    } finally {
      opening.current = false;
    }
  }
  function saved(message: string) {
    setEditor(null);
    setImporting(false);
    setNotice(message);
    setCursor("");
    setRevision((v) => v + 1);
  }
  return (
    <div className="contacts-panel">
      <div className="contacts-toolbar">
        <form
          className="contacts-search"
          onSubmit={(e) => {
            e.preventDefault();
            setSearch(q);
            setCursor("");
          }}
        >
          <label className="search-box">
            <Search size={18} />
            <input
              aria-label="Buscar contatos"
              placeholder="Nome, telefone, e-mail ou empresa"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </label>
          <button className="button secondary" type="submit">
            Buscar
          </button>
        </form>
        <div className="contact-actions">
          <a className="button secondary" href="/modelo-contatos.csv" download>
            <Download size={16} /> Modelo CSV
          </a>
          <button
            className="button secondary"
            onClick={() => setImporting(true)}
          >
            <Upload size={16} /> Importar CSV
          </button>
          <button className="button" onClick={() => setEditor({})}>
            <Plus size={16} /> Novo contato
          </button>
        </div>
      </div>
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {error && (
        <div className="notice error" role="alert">
          {error}
          <button onClick={() => setRevision((v) => v + 1)}>
            Tentar novamente
          </button>
        </div>
      )}
      <section className="card contacts-list" aria-busy={loading}>
        <div className="section-heading">
          <div>
            <h2>Seus contatos</h2>
            <p>Cadastros do perfil de atendimento selecionado.</p>
          </div>
          <BookUser size={24} />
        </div>
        {loading ? (
          <p className="contact-progress" role="status">
            <Loader2 className="spin" size={18} /> Carregando agenda…
          </p>
        ) : rows.length ? (
          <>
            <div className="contact-table-wrap">
              <table className="contact-table">
                <thead>
                  <tr>
                    <th>Contato</th>
                    <th>Telefone / e-mail</th>
                    <th>Empresa</th>
                    <th>Origem</th>
                    <th>Conversas</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id}>
                      <td>
                        <button
                          className="contact-name"
                          onClick={() => edit(row)}
                        >
                          {row.name}
                        </button>
                        {row.namespace !== "team" && (
                          <small>Integração externa</small>
                        )}
                      </td>
                      <td>
                        {row.phone || "—"}
                        <small>{row.email}</small>
                      </td>
                      <td>{row.company || "—"}</td>
                      <td>{sourceName(row.source)}</td>
                      <td>{row.conversation_count || 0}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="contacts-pagination">
              <span>{rows.length} contato(s) nesta página</span>
              <div>
                {cursor && (
                  <button
                    className="button secondary"
                    onClick={() => setCursor("")}
                  >
                    Primeira página
                  </button>
                )}
                {next && (
                  <button
                    className="button secondary"
                    onClick={() => setCursor(next)}
                  >
                    Próxima página
                  </button>
                )}
              </div>
            </div>
          </>
        ) : (
          <div className="empty">
            <BookUser size={32} />
            <h3>
              {search ? "Nenhum contato encontrado" : "Sua agenda começa aqui"}
            </h3>
            <p>
              {search
                ? "Tente buscar por outro nome, telefone, e-mail ou empresa."
                : "Adicione um contato, importe uma planilha CSV ou salve o cliente de uma conversa."}
            </p>
          </div>
        )}
      </section>
      <div className="contacts-help">
        <div>
          <h3>Salvar a partir de uma conversa</h3>
          <p>
            Em Conversas, abra o atendimento e clique em{" "}
            <strong>Salvar contato</strong>. Cadastre o cliente ou escolha um
            contato que já existe na agenda.
          </p>
        </div>
        <div>
          <h3>Trazer sua planilha</h3>
          <p>
            Use o modelo CSV com nome, telefone, email, empresa e observacoes.
            Você confere os dados antes de importar. Até 500 contatos por
            arquivo.
          </p>
        </div>
      </div>
      {editor && (
        <ContactEditor
          api={api}
          root={root}
          demo={demo}
          {...editor}
          close={() => setEditor(null)}
          saved={saved}
          openConversation={(row) => {
            setEditor(null);
            openConversation(row);
          }}
        />
      )}
      {importing && (
        <CsvImport
          api={api}
          root={root}
          demo={demo}
          close={() => setImporting(false)}
          saved={saved}
        />
      )}
    </div>
  );
}
