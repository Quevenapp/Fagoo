import React, { useRef, useState } from "react";
import { scopeNames } from "./scopes.mjs";
import { api, command } from "./api.mjs";
import { currency, date, decimal, quantity } from "./format.mjs";
import {
  Badge,
  DataList,
  Empty,
  EntitySelect,
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

function UserForm({ user, scopes, onClose, onDone }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(null),
    [role, setRole] = useState(user?.role || "operator"),
    [selected, setSelected] = useState(user?.scopes || []);
  return (
    <Modal
      title={user ? "Editar acesso da equipe" : "Adicionar pessoa à equipe"}
      description="Cada pessoa deve usar sua própria conta."
      onClose={onClose}
      busy={busy}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const d = Object.fromEntries(new FormData(e.currentTarget));
          setBusy(true);
          setError(null);
          try {
            await api("/api/v1/users" + (user ? `/${user.id}` : ""), {
              method: user ? "PATCH" : "POST",
              body: {
                ...(user
                  ? { active: d.active === "true" }
                  : { name: d.name, email: d.email, password: d.password }),
                role,
                scopes: selected,
              },
            });
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
          {!user && (
            <>
              <Field label="Nome" name="name" required maxLength={120} />
              <Field
                label="E-mail"
                name="email"
                type="email"
                required
                autoComplete="off"
              />
              <Field
                label="Senha inicial"
                name="password"
                type="password"
                autoComplete="new-password"
                minLength={12}
                required
                hint="Pelo menos 12 caracteres. Entregue a senha à pessoa por um meio apropriado."
              />
            </>
          )}
          <Field label="Perfil">
            <select value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="operator">Operador</option>
              <option value="admin">Administrador</option>
            </select>
          </Field>
          {user && (
            <Field label="Situação">
              <select
                name="active"
                defaultValue={String(user.active !== false)}
              >
                <option value="true">Ativo</option>
                <option value="false">Desativado</option>
              </select>
            </Field>
          )}
          {role === "admin" ? (
            <Notice>
              Administradores gerenciam os acessos, a instalação e as operações
              da empresa.
            </Notice>
          ) : (
            <div className="scope-list">
              {scopes.map((scope) => (
                <label className="checkbox" key={scope}>
                  <input
                    type="checkbox"
                    checked={selected.includes(scope)}
                    onChange={(e) =>
                      setSelected((rows) =>
                        e.target.checked
                          ? [...rows, scope]
                          : rows.filter((s) => s !== scope),
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
          )}
        </fieldset>
        <FormActions busy={busy} onClose={onClose} />
      </form>
    </Modal>
  );
}
export function Users({ revision, changed }) {
  const r = useResource("/api/v1/users", revision),
    [selected, setSelected] = useState(null);
  return (
    <>
      <PageHead
        title="Equipe"
        description="Contas individuais e permissões de acesso."
      >
        <button className="button primary" onClick={() => setSelected({})}>
          <Icon name="plus" />
          Adicionar pessoa
        </button>
      </PageHead>
      <ErrorNotice error={r.error} retry={r.retry} />
      <section className="panel">
        {r.loading ? (
          <Loading />
        ) : r.data?.items?.length ? (
          <Table
            items={r.data.items}
            onSelect={setSelected}
            columns={[
              { key: "name", title: "Nome" },
              { key: "email", title: "E-mail" },
              {
                key: "role",
                title: "Perfil",
                render: (r) =>
                  r.role === "admin" ? "Administrador" : "Operador",
              },
              {
                key: "active",
                title: "Situação",
                render: (r) => (
                  <Badge
                    value={r.active === false ? "cancelled" : "available"}
                  />
                ),
              },
            ]}
          />
        ) : (
          !r.error && <Empty title="Nenhuma pessoa encontrada" />
        )}
      </section>
      {selected && (
        <UserForm
          user={selected.id ? selected : null}
          scopes={r.data?.available_scopes || []}
          onClose={() => setSelected(null)}
          onDone={() => {
            setSelected(null);
            changed("Acesso da equipe salvo.");
          }}
        />
      )}
    </>
  );
}
function PriceRuleForm({ onClose, onDone }) {
  const [product, setProduct] = useState(null),
    [contact, setContact] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(null),
    id = useRef(command());
  return (
    <Modal
      title="Nova regra de preço"
      description="O servidor usa as regras aplicáveis ao calcular um pedido."
      onClose={onClose}
      busy={busy}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!product) return;
          const d = Object.fromEntries(new FormData(e.currentTarget));
          setBusy(true);
          setError(null);
          try {
            await api("/api/v1/price-rules", {
              body: {
                command_id: id.current,
                name: d.name,
                product_id: product.id,
                ...(contact ? { contact_id: contact.id } : {}),
                ...(d.payment_terms ? { payment_terms: d.payment_terms } : {}),
                unit_price: decimal(d.unit_price, { places: 10 }),
                minimum_quantity: decimal(d.minimum_quantity),
                priority: Number(d.priority),
                ...(d.valid_from ? { valid_from: d.valid_from } : {}),
                ...(d.valid_until ? { valid_until: d.valid_until } : {}),
                active: true,
              },
            });
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
          <Field label="Nome da regra" name="name" required maxLength={120} />
          <EntitySelect
            label="Produto"
            path="/api/v1/products"
            value={product}
            onChange={setProduct}
          />
          <EntitySelect
            label="Cliente (opcional)"
            path="/api/v1/contacts"
            value={contact}
            onChange={setContact}
            required={false}
          />
          <Field
            label="Condição de pagamento (opcional)"
            name="payment_terms"
            maxLength={200}
          />
          <div className="form-grid">
            <Field
              label="Preço unitário (R$)"
              name="unit_price"
              required
              inputMode="decimal"
              pattern="[0-9]+([.,][0-9]{1,10})?"
            />
            <Field
              label="Quantidade mínima"
              name="minimum_quantity"
              required
              inputMode="decimal"
              pattern="[0-9]+([.,][0-9]{1,6})?"
              defaultValue="1"
            />
            <Field label="Válida a partir de" name="valid_from" type="date" />
            <Field label="Válida até" name="valid_until" type="date" />
          </div>
          <Field
            label="Prioridade"
            name="priority"
            type="number"
            min="0"
            max="1000"
            defaultValue="0"
            required
          />
        </fieldset>
        <FormActions busy={busy} onClose={onClose} />
      </form>
    </Modal>
  );
}
export function Pricing({ revision, changed }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <PageHead
        title="Regras de preço"
        description="Preços por produto, cliente, condição e período."
      >
        <button className="button primary" onClick={() => setOpen(true)}>
          <Icon name="plus" />
          Nova regra
        </button>
      </PageHead>
      <DataList
        path="/api/v1/price-rules"
        revision={revision}
        columns={[
          { key: "name", title: "Regra" },
          { key: "product_name", title: "Produto" },
          {
            key: "contact_name",
            title: "Cliente",
            render: (r) => r.contact_name || "Todos",
          },
          {
            key: "unit_price",
            title: "Preço",
            align: "right",
            render: (r) => currency(r.unit_price, 10),
          },
          {
            key: "minimum_quantity",
            title: "Qtd. mínima",
            align: "right",
            render: (r) => quantity(r.minimum_quantity),
          },
          {
            key: "valid_until",
            title: "Até",
            render: (r) => date(r.valid_until),
          },
        ]}
      />
      {open && (
        <PriceRuleForm
          onClose={() => setOpen(false)}
          onDone={() => {
            setOpen(false);
            changed("Regra de preço criada.");
          }}
        />
      )}
    </>
  );
}
export function CompanyFiscalSettings() {
  const r = useResource("/api/v1/company/fiscal"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(null),
    [saved, setSaved] = useState(false),
    id = useRef(command());
  return (
    <section className="panel info-card">
      <span className="eyebrow">Identificação fiscal</span>
      <h2>Dados da empresa</h2>
      <ErrorNotice error={r.error} retry={r.retry} />
      <ErrorNotice error={error} />
      {r.loading ? (
        <Loading />
      ) : (
        r.data?.company && (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const d = Object.fromEntries(new FormData(e.currentTarget));
              setBusy(true);
              setError(null);
              setSaved(false);
              try {
                await api("/api/v1/company/fiscal", {
                  method: "PATCH",
                  body: {
                    ...d,
                    command_id: id.current,
                    expected_version: r.data.company.fiscal_version,
                  },
                });
                id.current = command();
                setSaved(true);
                r.retry();
              } catch (err) {
                setError(err);
              } finally {
                setBusy(false);
              }
            }}
          >
            <fieldset disabled={busy}>
              <div className="form-grid">
                <Field
                  label="CNPJ"
                  name="document"
                  required
                  pattern="[A-Za-z0-9]{12}[0-9]{2}"
                  minLength={14}
                  maxLength={14}
                  defaultValue={r.data.company.document || ""}
                  hint="14 caracteres sem pontuação. CNPJ numérico ou alfanumérico."
                />
                <Field label="Regime tributário">
                  <select
                    name="tax_regime"
                    defaultValue={r.data.company.tax_regime || "unconfigured"}
                  >
                    <option value="unconfigured">Ainda não configurado</option>
                    <option value="simples_nacional">Simples Nacional</option>
                    <option value="lucro_presumido">Lucro Presumido</option>
                    <option value="lucro_real">Lucro Real</option>
                  </select>
                </Field>
              </div>
            </fieldset>
            {saved && (
              <Notice kind="success">Identificação fiscal salva.</Notice>
            )}
            <button className="button secondary" disabled={busy}>
              {busy ? "Salvando…" : "Salvar identificação"}
            </button>
          </form>
        )
      )}
    </section>
  );
}
export function InvoiceImport({ onClose, onDone }) {
  const [xml, setXml] = useState(""),
    [filename, setFilename] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(null),
    id = useRef(command());
  return (
    <Modal
      title="Importar XML de nota recebida"
      description="O arquivo será preservado no armazenamento privado da empresa."
      onClose={onClose}
      busy={busy}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!xml) return;
          setBusy(true);
          setError(null);
          try {
            await api("/api/v1/invoices/received/import", {
              body: { command_id: id.current, xml },
            });
            onDone();
          } catch (err) {
            setError(err);
          } finally {
            setBusy(false);
          }
        }}
      >
        <ErrorNotice error={error} />
        <Notice>
          Importar um XML não confirma sua assinatura, não valida tributos e não
          lança estoque ou financeiro. Essas etapas precisam ser verificadas
          separadamente.
        </Notice>
        <Field
          label="Arquivo XML"
          type="file"
          accept=".xml,application/xml,text/xml"
          required
          disabled={busy}
          onChange={async (e) => {
            const file = e.target.files?.[0];
            setError(null);
            setXml("");
            setFilename("");
            if (!file) return;
            if (file.size > 1048576) {
              setError(new Error("O XML deve ter no máximo 1 MiB."));
              return;
            }
            try {
              setXml(await file.text());
              setFilename(file.name);
            } catch {
              setError(
                new Error("Não foi possível ler o arquivo selecionado."),
              );
            }
          }}
        />
        {filename && <p className="help">Arquivo selecionado: {filename}</p>}
        <FormActions
          busy={busy || !xml}
          onClose={onClose}
          label="Importar XML"
        />
      </form>
    </Modal>
  );
}
