import React, { useEffect, useState } from "react";
import { api } from "./api.mjs";
import { CompanyFiscalSettings } from "./AdditionalPages.jsx";
import { date, label } from "./format.mjs";
import {
  Badge,
  Empty,
  ErrorNotice,
  Field,
  FormActions,
  Icon,
  Loading,
  Modal,
  Notice,
  PageHead,
  Table,
  useResource,
} from "./components.jsx";

import { scopeNames } from "./scopes.mjs";

function IntegrationForm({ availableScopes, onClose, onDone }) {
  const [name, setName] = useState(""),
    [scopes, setScopes] = useState([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(null),
    [result, setResult] = useState(null),
    [copied, setCopied] = useState(false);
  const token = result?.token || result?.access_token;
  return (
    <Modal
      title={result ? "Acesso criado" : "Novo acesso de integração"}
      description={
        result
          ? "Guarde a credencial no ambiente da integração."
          : "Escolha somente as permissões necessárias para este acesso."
      }
      onClose={onClose}
      busy={busy}
    >
      {result ? (
        <>
          <Notice kind="success">
            O acesso foi criado. A credencial é exibida somente nesta etapa.
          </Notice>
          {token ? (
            <>
              <div className="secret-box">
                <code>{token}</code>
              </div>
              <button
                className="button secondary"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(token);
                    setCopied(true);
                  } catch {
                    setError(
                      new Error(
                        "Não foi possível copiar. Selecione a credencial e copie manualmente.",
                      ),
                    );
                  }
                }}
              >
                <Icon name="copy" />
                {copied ? "Copiado" : "Copiar credencial"}
              </button>
            </>
          ) : (
            <Notice>
              A API não retornou uma credencial para exibição. Consulte a
              configuração do servidor.
            </Notice>
          )}
          <ErrorNotice error={error} />
          <div className="form-actions">
            <button className="button primary" onClick={onClose}>
              Concluir
            </button>
          </div>
        </>
      ) : (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            try {
              const data = await api("/api/v1/integrations", {
                body: { name, scopes },
              });
              setResult(data);
              onDone();
            } catch (err) {
              setError(err);
            } finally {
              setBusy(false);
            }
          }}
        >
          <ErrorNotice error={error} />
          <fieldset disabled={busy}>
            <Field
              label="Nome do acesso"
              required
              maxLength={100}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ex.: Bot equipe"
            />
            <div className="scope-list">
              {availableScopes.map((scope) => (
                <label className="checkbox" key={scope}>
                  <input
                    type="checkbox"
                    checked={scopes.includes(scope)}
                    onChange={(e) =>
                      setScopes((prev) =>
                        e.target.checked
                          ? [...prev, scope]
                          : prev.filter((v) => v !== scope),
                      )
                    }
                  />
                  <span>
                    {scopeNames[scope] || scope}
                    <small>{scope}</small>
                  </span>
                </label>
              ))}
            </div>
            {!availableScopes.length && (
              <Notice>
                O servidor não informou permissões disponíveis para criar este
                acesso.
              </Notice>
            )}
          </fieldset>
          <footer className="form-actions">
            <button
              className="button secondary"
              type="button"
              onClick={onClose}
            >
              Cancelar
            </button>
            <button
              className="button primary"
              disabled={busy || !scopes.length}
            >
              {busy ? "Criando…" : "Criar acesso"}
            </button>
          </footer>
        </form>
      )}
    </Modal>
  );
}
export function Integrations({ revision, changed }) {
  const r = useResource("/api/v1/integrations", revision),
    [open, setOpen] = useState(false),
    [revoke, setRevoke] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(null);
  const items = r.data?.items || [],
    available = r.data?.available_scopes || Object.keys(scopeNames);
  return (
    <>
      <PageHead
        title="Integrações"
        description="Conecte agentes e aplicativos com acessos individuais."
      >
        <button className="button primary" onClick={() => setOpen(true)}>
          <Icon name="plus" />
          Novo acesso
        </button>
      </PageHead>
      <div className="integration-intro">
        <div>
          <span className="integration-icon">
            <Icon name="plug" size={26} />
          </span>
          <h2>Seu bot equipe, conectado ao FAGOO.</h2>
          <p>
            O agente externo consulta os dados e executa as operações
            autorizadas. A API mantém as regras e o histórico dos lançamentos.
          </p>
          <a
            className="text-button"
            href="https://github.com/Quevenapp/Fagoo/blob/main/docs/integrations/agents.md"
            target="_blank"
            rel="noreferrer"
          >
            Como configurar o agente <Icon name="arrow" size={16} />
          </a>
        </div>
        <div className="connection-steps">
          <span>
            <b>1</b> Crie um acesso com permissões específicas
          </span>
          <span>
            <b>2</b> Configure a credencial no bot equipe
          </span>
          <span>
            <b>3</b> Teste consultas antes das operações
          </span>
        </div>
      </div>
      <ErrorNotice error={r.error} retry={r.retry} />
      <ErrorNotice error={error} />
      <section className="panel">
        {r.loading ? (
          <Loading />
        ) : items.length ? (
          <Table
            items={items}
            columns={[
              { key: "name", title: "Acesso" },
              {
                key: "scopes",
                title: "Permissões",
                render: (row) => (
                  <span className="scope-summary">
                    {row.scopes?.map((s) => scopeNames[s] || s).join(", ") ||
                      "—"}
                  </span>
                ),
              },
              {
                key: "created_at",
                title: "Criado em",
                render: (row) => date(row.created_at),
              },
              {
                key: "status",
                title: "Situação",
                render: (row) => (
                  <Badge value={row.revoked_at ? "cancelled" : "available"} />
                ),
              },
              {
                key: "action",
                title: "",
                render: (row) =>
                  !row.revoked_at && (
                    <button
                      className="text-button danger-text"
                      onClick={() => setRevoke(row)}
                    >
                      Revogar
                    </button>
                  ),
              },
            ]}
          />
        ) : (
          <Empty title="Nenhum acesso de integração" icon="plug">
            Crie um acesso para conectar o Hermes ou um aplicativo à API.
          </Empty>
        )}
      </section>
      {open && (
        <IntegrationForm
          availableScopes={available}
          onClose={() => setOpen(false)}
          onDone={() => changed("Acesso de integração criado.")}
        />
      )}{" "}
      {revoke && (
        <Modal
          title="Revogar acesso"
          onClose={() => setRevoke(null)}
          busy={busy}
        >
          <p>
            O acesso <strong>{revoke.name}</strong> deixará de funcionar. A
            aplicação conectada precisará de uma nova credencial.
          </p>
          <ErrorNotice error={error} />
          <footer className="form-actions">
            <button
              className="button secondary"
              onClick={() => setRevoke(null)}
              disabled={busy}
            >
              Cancelar
            </button>
            <button
              className="button danger"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  await api(`/api/v1/integrations/${revoke.id}`, {
                    method: "DELETE",
                  });
                  setRevoke(null);
                  changed("Acesso revogado.");
                } catch (err) {
                  setError(err);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? "Revogando…" : "Revogar acesso"}
            </button>
          </footer>
        </Modal>
      )}
    </>
  );
}
const version = (value) => (typeof value === "string" ? value : value?.version);
export function Updates({ revision, changed }) {
  const r = useResource("/api/v1/system/updates", revision),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(null),
    [confirm, setConfirm] = useState(false);
  const installed = version(r.data?.installed),
    latest = version(r.data?.latest),
    status =
      typeof r.data?.status === "string"
        ? r.data.status
        : r.data?.status?.state;
  useEffect(() => {
    if (!["queued", "running", "processing"].includes(status)) return;
    const timer = setInterval(r.retry, 3000);
    return () => clearInterval(timer);
  }, [status, r.retry]);
  const action = async (path, body) => {
    setBusy(true);
    setError(null);
    try {
      const result = await api(path, { body });
      setConfirm(false);
      changed(result.message || "Solicitação registrada no servidor.");
      r.retry();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const hasNew = r.data?.update_available === true && Boolean(latest);
  return (
    <>
      <PageHead
        title="Atualizações"
        description="Versões públicas, verificadas e instaladas pelo administrador."
      >
        <button
          className="button secondary"
          disabled={busy || r.loading}
          onClick={() => action("/api/v1/system/updates/check", {})}
        >
          <Icon name="update" />
          Verificar versões
        </button>
      </PageHead>
      <ErrorNotice error={r.error} retry={r.retry} />
      <ErrorNotice error={error} />
      {r.loading && !r.data ? (
        <Loading />
      ) : (
        r.data && (
          <>
            <section className="panel update-card">
              <span className="update-symbol">
                <Icon name="update" size={31} />
              </span>
              <div>
                <span className="eyebrow">Esta instalação</span>
                <h2>
                  {installed ? `FAGOO ${installed}` : "Versão não informada"}
                </h2>
                <p>
                  {hasNew
                    ? `A versão ${latest} está disponível.`
                    : latest === installed
                      ? "Esta instalação está na versão estável informada."
                      : "Nenhuma atualização disponível para esta instalação."}
                </p>
                {status && <Badge value={status} />}
              </div>
              <button
                className="button primary"
                disabled={
                  !hasNew ||
                  busy ||
                  ["queued", "running", "processing"].includes(status)
                }
                onClick={() => setConfirm(true)}
              >
                Atualizar FAGOO <Icon name="arrow" size={17} />
              </button>
            </section>
            <div className="overview-grid">
              <section className="panel info-card">
                <span className="eyebrow">Recuperação</span>
                <h2>Backup antes de atualizar</h2>
                <p>
                  {r.data.backup?.message ||
                    "O atualizador verifica as condições de recuperação antes de aplicar uma versão."}
                </p>
                <dl>
                  <div>
                    <dt>Último backup</dt>
                    <dd>
                      {date(
                        r.data.backup?.last_success_at ||
                          r.data.backup?.last_backup_at,
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>Situação</dt>
                    <dd>
                      {r.data.backup?.status
                        ? label(r.data.backup.status)
                        : "Ainda não informada"}
                    </dd>
                  </div>
                </dl>
              </section>
              <section className="panel info-card">
                <span className="eyebrow">Distribuição aberta</span>
                <h2>Sem token de download</h2>
                <p>
                  As versões do FAGOO são públicas. O administrador autoriza a
                  instalação e o servidor verifica a assinatura dos arquivos.
                </p>
                <a
                  className="text-button"
                  href="https://github.com/Quevenapp/Fagoo/releases"
                  target="_blank"
                  rel="noreferrer"
                >
                  Consultar releases <Icon name="arrow" size={16} />
                </a>
              </section>
            </div>
            {r.data.latest?.notes && (
              <section className="panel info-card">
                <h2>O que muda nesta versão</h2>
                <p className="release-notes">{r.data.latest.notes}</p>
              </section>
            )}
            {r.data.message && <Notice>{r.data.message}</Notice>}
          </>
        )
      )}
      {confirm && (
        <Modal
          title={`Atualizar para ${latest}`}
          onClose={() => setConfirm(false)}
          busy={busy}
        >
          <p>
            O servidor verificará o pacote, a compatibilidade e o backup antes
            de iniciar. Durante a aplicação, o acesso poderá ficar
            temporariamente indisponível.
          </p>
          <ErrorNotice error={error} />
          <footer className="form-actions">
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => setConfirm(false)}
            >
              Cancelar
            </button>
            <button
              className="button primary"
              disabled={busy}
              onClick={() =>
                action("/api/v1/system/updates/request", { version: latest })
              }
            >
              {busy ? "Solicitando…" : "Iniciar atualização"}
            </button>
          </footer>
        </Modal>
      )}
    </>
  );
}
export function Settings({ me, discovery }) {
  const r = useResource("/api/v1/fiscal/capabilities");
  return (
    <>
      <PageHead
        title="Sua instalação"
        description="Identificação do servidor e recursos disponíveis."
      />
      <div className="overview-grid">
        <section className="panel info-card">
          <span className="eyebrow">Servidor</span>
          <h2>{me?.company?.name || discovery?.display_name || "FAGOO"}</h2>
          <dl>
            <div>
              <dt>Endereço</dt>
              <dd className="break-word">{location.origin}</dd>
            </div>
            <div>
              <dt>Identificação</dt>
              <dd className="mono small-text break-word">
                {discovery?.server_id || "Não informada"}
              </dd>
            </div>
            <div>
              <dt>Versão</dt>
              <dd>
                {discovery?.server_version ||
                  discovery?.version ||
                  "Não informada"}
              </dd>
            </div>
          </dl>
        </section>
        <section className="panel info-card">
          <span className="eyebrow">Acesso</span>
          <h2>{me?.user?.name || "Sua conta"}</h2>
          <dl>
            <div>
              <dt>E-mail</dt>
              <dd>{me?.user?.email || "—"}</dd>
            </div>
            <div>
              <dt>Empresa</dt>
              <dd>{me?.company?.name || "—"}</dd>
            </div>
          </dl>
          <p>Permissões são verificadas pelo servidor em cada operação.</p>
        </section>
      </div>
      <CompanyFiscalSettings />
      <section className="panel info-card">
        <span className="eyebrow">Fiscal</span>
        <h2>Recursos habilitados</h2>
        <ErrorNotice error={r.error} />
        {r.loading ? (
          <Loading />
        ) : (
          <>
            <p>
              {r.data?.message ||
                r.data?.reason ||
                "Consulte a documentação de instalação para configurar os serviços fiscais da empresa."}
            </p>
            {r.data?.profiles?.length > 0 && (
              <ul>
                {r.data.profiles.map((p) => (
                  <li key={p.id || p.name}>
                    {p.name || p.id}: {label(p.status)}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>
      <section className="panel mobile-card">
        <Icon name="server" size={32} />
        <div>
          <h2>Um endereço para encontrar sua empresa.</h2>
          <p>
            O servidor oferece identificação e descoberta para o futuro
            aplicativo FAGOO. Os aplicativos Android e iOS ainda não são
            distribuídos nesta versão.
          </p>
          <a href="/.well-known/fagoo.json" target="_blank" rel="noreferrer">
            Consultar identificação pública do servidor
          </a>
        </div>
      </section>
    </>
  );
}
