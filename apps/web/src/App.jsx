import React, { useEffect, useState } from "react";
import { api } from "./api.mjs";
import {
  ErrorNotice,
  Field,
  Icon,
  Loading,
  Logo,
  Notice,
  useResource,
} from "./components.jsx";
import {
  Contacts,
  Dashboard,
  Events,
  Finance,
  Orders,
  Products,
  Received,
  Stock,
} from "./BusinessPages.jsx";
import { Integrations, Settings, Updates } from "./AdminPages.jsx";
import Consent from "./Consent.jsx";
import { loginContinuation } from "./redirect.mjs";
import { Pricing, Users } from "./AdditionalPages.jsx";
import { Banking } from "./Banking.jsx";

const sections = [
  ["dashboard", "grid", "Visão geral"],
  ["products", "box", "Produtos"],
  ["contacts", "users", "Contatos"],
  ["pricing", "file", "Regras de preço"],
  ["sales", "cart", "Vendas"],
  ["purchases", "truck", "Compras"],
  ["stock", "layers", "Estoque"],
  ["finance", "wallet", "Financeiro"],
  ["banking", "wallet", "Cobrança CNAB"],
  ["invoices", "file", "Notas recebidas"],
];
const manage = [
  ["users", "users", "Equipe"],
  ["integrations", "plug", "Integrações"],
  ["events", "bell", "Atividades"],
  ["settings", "settings", "Sua instalação"],
  ["updates", "update", "Atualizações"],
];
function Login({ onLogin, discovery }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(null);
  return (
    <main className="login">
      <section className="login-story">
        <Logo />
        <div>
          <span className="eyebrow">Gestão com liberdade</span>
          <h1>
            Seu negócio,
            <br />
            no seu ritmo.
          </h1>
          <p>
            Uma base para organizar suas compras, vendas e estoque. Um servidor
            que você controla.
          </p>
          <div className="login-illustration" aria-hidden="true">
            <span />
            <span />
            <span />
            <Icon name="leaf" size={78} />
          </div>
        </div>
        <footer>Seu ERP. Seu servidor. FAGOO.</footer>
      </section>
      <section className="login-form-wrap">
        <div className="login-form">
          <div className="login-mobile-brand">
            <Logo />
          </div>
          <span className="eyebrow">Bem-vindo de volta</span>
          <h2>Entre na sua empresa</h2>
          <p>
            {discovery?.display_name ||
              "Use a conta criada para esta instalação."}
          </p>
          <ErrorNotice error={error} />
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const body = Object.fromEntries(new FormData(e.currentTarget));
              if (
                location.pathname === "/login" &&
                new URLSearchParams(location.search).has("sig")
              )
                body.oauth_query = location.search.slice(1);
              setBusy(true);
              setError(null);
              try {
                const result = await api("/api/auth/sign-in/email", { body });
                const continuation = loginContinuation(
                  result.redirect_uri || (result.redirect ? result.url : null),
                  location.origin,
                );
                if (continuation) {
                  location.assign(continuation);
                  return;
                }
                onLogin();
              } catch (err) {
                setError(err);
              } finally {
                setBusy(false);
              }
            }}
          >
            <fieldset disabled={busy}>
              <Field
                label="E-mail"
                name="email"
                type="email"
                autoComplete="username"
                required
                placeholder="voce@empresa.com.br"
              />
              <Field
                label="Senha"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                minLength={8}
              />
            </fieldset>
            <button className="button primary full" disabled={busy}>
              {busy ? "Entrando…" : "Entrar no FAGOO"}
              <Icon name="arrow" size={18} />
            </button>
          </form>
          <div className="server-label">
            <Icon name="lock" size={15} />
            <span>{location.host}</span>
          </div>
          <p className="login-help">
            Primeiro acesso? Use as credenciais configuradas pelo administrador
            durante a instalação.
          </p>
        </div>
      </section>
    </main>
  );
}
class ScreenBoundary extends React.Component {
  state = { error: null };
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidUpdate(previous) {
    if (previous.page !== this.props.page && this.state.error)
      this.setState({ error: null });
  }
  render() {
    return this.state.error ? (
      <div className="panel info-card">
        <Notice>
          Não foi possível apresentar esta tela. Recarregue os dados ou acesse
          outra seção.
        </Notice>
        <button
          className="button secondary"
          onClick={() => this.setState({ error: null })}
        >
          Tentar novamente
        </button>
      </div>
    ) : (
      this.props.children
    );
  }
}
export default function App() {
  const [authRevision, setAuthRevision] = useState(0),
    [revision, setRevision] = useState(0),
    [page, setPage] = useState(location.hash.slice(1) || "dashboard"),
    [menu, setMenu] = useState(false),
    [toast, setToast] = useState(null),
    [logoutError, setLogoutError] = useState(null);
  const session = useResource("/api/auth/get-session", authRevision),
    discovery = useResource("/.well-known/fagoo.json"),
    me = useResource(session.data?.user ? "/api/v1/me" : null, authRevision);
  useEffect(() => {
    const handler = () => {
      setPage(location.hash.slice(1) || "dashboard");
      setMenu(false);
    };
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, []);
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(id);
  }, [toast]);
  const navigate = (key) => {
    location.hash = key;
    setPage(key);
    setMenu(false);
    window.scrollTo(0, 0);
  };
  const changed = (message) => {
    setRevision((v) => v + 1);
    setToast(message);
  };
  if (session.loading)
    return (
      <main className="boot">
        <Logo />
        <Loading />
      </main>
    );
  if (session.error && session.error.status !== 401)
    return (
      <main className="boot">
        <Logo />
        <ErrorNotice error={session.error} retry={session.retry} />
      </main>
    );
  if (!session.data?.user)
    return (
      <Login
        onLogin={() => setAuthRevision((v) => v + 1)}
        discovery={discovery.data}
      />
    );
  if (location.pathname === "/oauth/consent")
    return <Consent user={session.data.user} />;
  const title =
      [...sections, ...manage].find(([key]) => key === page)?.[2] ||
      "Visão geral",
    user = session.data.user;
  const view =
    page === "users" ? (
      <Users revision={revision} changed={changed} />
    ) : page === "pricing" ? (
      <Pricing revision={revision} changed={changed} />
    ) : page === "products" ? (
      <Products revision={revision} changed={changed} />
    ) : page === "contacts" ? (
      <Contacts revision={revision} changed={changed} />
    ) : page === "sales" || page === "purchases" ? (
      <Orders
        key={page}
        kind={page === "sales" ? "sale" : "purchase"}
        revision={revision}
        changed={changed}
      />
    ) : page === "stock" ? (
      <Stock revision={revision} changed={changed} />
    ) : page === "finance" ? (
      <Finance revision={revision} />
    ) : page === "banking" ? (
      <Banking revision={revision} changed={changed} />
    ) : page === "invoices" ? (
      <Received revision={revision} changed={changed} />
    ) : page === "events" ? (
      <Events revision={revision} />
    ) : page === "integrations" ? (
      <Integrations revision={revision} changed={changed} />
    ) : page === "updates" ? (
      <Updates revision={revision} changed={changed} />
    ) : page === "settings" ? (
      <Settings me={me.data} discovery={discovery.data} />
    ) : (
      <Dashboard revision={revision} onNavigate={navigate} />
    );
  const navigation = (items) =>
    items.map(([key, icon, text]) => (
      <button
        key={key}
        className={page === key ? "active" : ""}
        onClick={() => navigate(key)}
        aria-current={page === key ? "page" : undefined}
      >
        <Icon name={icon} size={19} />
        <span>{text}</span>
        {page === key && <span className="nav-dot" />}
      </button>
    ));
  return (
    <div className="app-shell">
      {menu && (
        <button
          className="sidebar-overlay"
          aria-label="Fechar navegação"
          onClick={() => setMenu(false)}
        />
      )}
      <aside className={`sidebar ${menu ? "open" : ""}`}>
        <a className="brand-link" href="#dashboard" aria-label="FAGOO · início">
          <Logo />
        </a>
        <div className="workspace-label">
          <span className="workspace-avatar">
            {(me.data?.company?.name || "F").slice(0, 1).toUpperCase()}
          </span>
          <span>
            <strong>
              {me.data?.company?.name ||
                discovery.data?.display_name ||
                "Sua empresa"}
            </strong>
            <small>Ambiente da empresa</small>
          </span>
        </div>
        <nav aria-label="Navegação principal">
          <span className="nav-caption">Operação</span>
          {navigation(sections)}
          <span className="nav-caption management">Administração</span>
          {navigation(manage)}
        </nav>
        <div className="sidebar-bottom">
          <span className="server-dot" />
          <div>
            <strong>Servidor próprio</strong>
            <small>{location.host}</small>
          </div>
          <Icon name="lock" size={15} />
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="topbar-title">
            <button
              className="icon-button mobile-menu"
              aria-label="Abrir navegação"
              onClick={() => setMenu(true)}
            >
              <Icon name="menu" />
            </button>
            <span>Empresa</span>
            <span className="slash">/</span>
            <strong>{title}</strong>
          </div>
          <div className="topbar-actions">
            <button
              className="icon-button"
              aria-label="Atividades"
              onClick={() => navigate("events")}
            >
              <Icon name="bell" />
            </button>
            <span className="topbar-divider" />
            <span className="user-avatar">
              {(user.name || user.email || "U").slice(0, 1).toUpperCase()}
            </span>
            <div className="user-label">
              <strong>{user.name || "Minha conta"}</strong>
              <small>{user.email}</small>
            </div>
            <button
              className="icon-button"
              aria-label="Sair"
              onClick={async () => {
                try {
                  await api("/api/auth/sign-out", { body: {} });
                  setAuthRevision((v) => v + 1);
                } catch (error) {
                  setLogoutError(error);
                }
              }}
            >
              <Icon name="logout" size={18} />
            </button>
          </div>
        </header>
        <main className="content" id="main">
          <ErrorNotice error={logoutError} />
          <ErrorNotice error={me.error} retry={me.retry} />
          <ScreenBoundary page={page}>{view}</ScreenBoundary>
          <footer className="app-footer">
            <span>FAGOO · Gestão no seu servidor</span>
            <span>Código aberto · AGPL-3.0</span>
          </footer>
        </main>
      </div>
      {toast && (
        <div className="toast" role="status">
          <Icon name="check" />
          <span>{toast}</span>
          <button aria-label="Dispensar aviso" onClick={() => setToast(null)}>
            <Icon name="close" size={16} />
          </button>
        </div>
      )}
    </div>
  );
}
