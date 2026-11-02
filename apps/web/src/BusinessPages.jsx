import React, { useRef, useState } from "react";
import { CommercialPrint } from "./CommercialPrint.jsx";
import { InvoiceImport } from "./AdditionalPages.jsx";
import { api, command, query } from "./api.mjs";
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

function useWrite(onDone) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(null),
    id = useRef(command());
  return {
    busy,
    error,
    id: id.current,
    submit: async (path, body, method) => {
      setBusy(true);
      setError(null);
      try {
        const result = await api(path, { body, method });
        onDone(result);
      } catch (e) {
        setError(e);
      } finally {
        setBusy(false);
      }
    },
  };
}
const formData = (form) => Object.fromEntries(new FormData(form));
export function ProductForm({ product, onClose, onDone }) {
  const write = useWrite(onDone);
  return (
    <Modal
      title={product ? "Editar produto" : "Novo produto"}
      description="Cadastre os dados usados em compras, vendas e estoque."
      onClose={onClose}
      busy={write.busy}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const d = formData(e.currentTarget);
          try {
            if (!d.ncm) delete d.ncm;
            for (const k of [
              "sale_price",
              "cost_price",
              "stock_min",
              "stock_max",
            ])
              d[k] = decimal(d[k], {
                places: ["sale_price", "cost_price"].includes(k) ? 10 : 6,
              });
          } catch (err) {
            e.currentTarget.reportValidity();
            return;
          }
          write.submit(
            "/api/v1/products" + (product ? `/${product.id}` : ""),
            {
              ...d,
              command_id: write.id,
              ...(product ? { expected_version: product.version } : {}),
            },
            product ? "PATCH" : "POST",
          );
        }}
      >
        <ErrorNotice error={write.error} />
        <fieldset disabled={write.busy}>
          <div className="form-grid">
            <Field
              label="Código"
              name="code"
              required
              maxLength={60}
              defaultValue={product?.code}
            />
            <Field
              label="Unidade"
              name="unit"
              required
              maxLength={6}
              defaultValue={product?.unit || "UN"}
            />
          </div>
          <Field
            label="Nome do produto"
            name="name"
            required
            maxLength={200}
            defaultValue={product?.name}
          />
          <div className="form-grid">
            <Field
              label="Preço de venda (R$)"
              name="sale_price"
              inputMode="decimal"
              pattern="[0-9]+([.,][0-9]{1,10})?"
              required
              defaultValue={product?.sale_price || "0.00"}
            />
            <Field
              label="Custo de referência (R$)"
              name="cost_price"
              inputMode="decimal"
              pattern="[0-9]+([.,][0-9]{1,10})?"
              required
              defaultValue={product?.cost_price || "0.00"}
            />
            <Field
              label="Estoque mínimo"
              name="stock_min"
              inputMode="decimal"
              pattern="[0-9]+([.,][0-9]{1,6})?"
              required
              defaultValue={product?.stock_min || "0"}
            />
            <Field
              label="Estoque máximo"
              name="stock_max"
              inputMode="decimal"
              pattern="[0-9]+([.,][0-9]{1,6})?"
              required
              defaultValue={product?.stock_max || "0"}
            />
          </div>
          <Field
            label="NCM"
            name="ncm"
            inputMode="numeric"
            pattern="[0-9]{8}|^$"
            maxLength={8}
            defaultValue={product?.ncm || ""}
            hint="Opcional. A classificação precisa corresponder às características do produto."
          />
        </fieldset>
        <FormActions busy={write.busy} onClose={onClose} />
      </form>
    </Modal>
  );
}
function ContactForm({ onClose, onDone }) {
  const w = useWrite(onDone);
  return (
    <Modal title="Novo contato" onClose={onClose} busy={w.busy}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const d = formData(e.currentTarget);
          w.submit("/api/v1/contacts", { ...d, command_id: w.id });
        }}
      >
        <ErrorNotice error={w.error} />
        <fieldset disabled={w.busy}>
          <Field
            label="Nome ou razão social"
            name="name"
            required
            maxLength={200}
          />
          <Field label="Tipo">
            <select name="kind" defaultValue="customer">
              <option value="customer">Cliente</option>
              <option value="supplier">Fornecedor</option>
              <option value="both">Cliente e fornecedor</option>
            </select>
          </Field>
          <Field label="CPF / CNPJ" name="document" maxLength={18} />
          <Field
            label="Condições de pagamento"
            name="payment_terms"
            maxLength={200}
            placeholder="Ex.: 30 dias após a entrega"
          />
        </fieldset>
        <FormActions busy={w.busy} onClose={onClose} />
      </form>
    </Modal>
  );
}
export function Dashboard({ revision, onNavigate }) {
  const r = useResource("/api/v1/analytics/overview", revision);
  const stats = [
    ["products", "Produtos cadastrados", "box"],
    ["open_sales_orders", "Vendas em aberto", "cart"],
    ["open_purchase_orders", "Compras em aberto", "truck"],
    ["stock_below_minimum", "Produtos abaixo do mínimo", "layers"],
  ];
  return (
    <>
      <PageHead
        eyebrow="Visão geral"
        title="Tudo pronto para o próximo passo."
        description="Acompanhe sua operação com os dados desta instalação."
      />
      <ErrorNotice error={r.error} retry={r.retry} />
      {r.loading ? (
        <Loading />
      ) : (
        r.data && (
          <>
            <div className="stats-grid">
              {stats.map(([key, title, icon]) => (
                <div className="stat" key={key}>
                  <span className="stat-icon">
                    <Icon name={icon} />
                  </span>
                  <span>{title}</span>
                  <strong>{r.data[key] ?? "—"}</strong>
                  <small>Posição atual do servidor</small>
                </div>
              ))}
            </div>
            <div className="overview-grid">
              <section className="panel finance-summary">
                <div className="section-head">
                  <div>
                    <span className="eyebrow">Compromissos</span>
                    <h2>Seu financeiro em perspectiva</h2>
                  </div>
                  <Icon name="wallet" />
                </div>
                <div className="money-pair">
                  <div>
                    <span>A receber em aberto</span>
                    <strong>{currency(r.data.receivables_open)}</strong>
                  </div>
                  <div>
                    <span>A pagar em aberto</span>
                    <strong>{currency(r.data.payables_open)}</strong>
                  </div>
                </div>
                <button
                  className="text-button"
                  onClick={() => onNavigate("finance")}
                >
                  Ver contas a pagar <Icon name="arrow" size={17} />
                </button>
              </section>
              <section className="panel accent-panel">
                <span className="eyebrow">Conectado à sua operação</span>
                <h2>Seus agentes trabalham com os mesmos dados.</h2>
                <p>
                  Configure acessos específicos para o bot equipe e outras
                  integrações. Você controla as permissões.
                </p>
                <button
                  className="button light"
                  onClick={() => onNavigate("integrations")}
                >
                  Gerenciar integrações <Icon name="arrow" size={17} />
                </button>
              </section>
            </div>
          </>
        )
      )}
      <section className="panel quick-start">
        <div>
          <span className="eyebrow">Comece por aqui</span>
          <h2>Organize a base da sua empresa</h2>
        </div>
        <div className="quick-links">
          {[
            [
              "products",
              "box",
              "Cadastre seus produtos",
              "Preços, unidades e limites de estoque.",
            ],
            [
              "contacts",
              "users",
              "Adicione seus contatos",
              "Clientes e fornecedores no mesmo lugar.",
            ],
            [
              "purchases",
              "truck",
              "Registre uma compra",
              "Acompanhe a conferência e o recebimento.",
            ],
          ].map(([key, icon, title, text]) => (
            <button key={key} onClick={() => onNavigate(key)}>
              <Icon name={icon} />
              <span>
                <strong>{title}</strong>
                <small>{text}</small>
              </span>
              <Icon name="arrow" size={16} />
            </button>
          ))}
        </div>
      </section>
    </>
  );
}
export function Products({ revision, changed }) {
  const [modal, setModal] = useState(null);
  return (
    <>
      <PageHead
        title="Produtos"
        description="Seu catálogo, preços e parâmetros de reposição."
      >
        <button className="button primary" onClick={() => setModal({})}>
          <Icon name="plus" />
          Novo produto
        </button>
      </PageHead>
      <DataList
        revision={revision}
        path="/api/v1/products"
        onSelect={setModal}
        columns={[
          {
            key: "name",
            title: "Produto",
            render: (r) => (
              <>
                <strong>{r.name}</strong>
                <small className="cell-sub">{r.code}</small>
              </>
            ),
          },
          { key: "unit", title: "Unidade" },
          {
            key: "sale_price",
            title: "Venda",
            align: "right",
            render: (r) => currency(r.sale_price, 10),
          },
          {
            key: "cost_price",
            title: "Custo",
            align: "right",
            render: (r) => currency(r.cost_price, 10),
          },
          {
            key: "stock_min",
            title: "Mínimo",
            align: "right",
            render: (r) => quantity(r.stock_min),
          },
          {
            key: "stock_max",
            title: "Máximo",
            align: "right",
            render: (r) => quantity(r.stock_max),
          },
        ]}
      />
      {modal && (
        <ProductForm
          product={modal.id ? modal : null}
          onClose={() => setModal(null)}
          onDone={() => {
            setModal(null);
            changed("Produto salvo.");
          }}
        />
      )}
    </>
  );
}
export function Contacts({ revision, changed }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <PageHead
        title="Contatos"
        description="Pessoas e empresas que fazem parte da sua operação."
      >
        <button className="button primary" onClick={() => setOpen(true)}>
          <Icon name="plus" />
          Novo contato
        </button>
      </PageHead>
      <DataList
        revision={revision}
        path="/api/v1/contacts"
        columns={[
          { key: "name", title: "Nome" },
          {
            key: "kind",
            title: "Tipo",
            render: (r) => <Badge value={r.kind} />,
          },
          { key: "document", title: "Documento" },
          { key: "payment_terms", title: "Pagamento" },
        ]}
      />
      {open && (
        <ContactForm
          onClose={() => setOpen(false)}
          onDone={() => {
            setOpen(false);
            changed("Contato cadastrado.");
          }}
        />
      )}
    </>
  );
}
function OrderForm({ kind, onClose, onDone }) {
  const [contact, setContact] = useState(null),
    [warehouse, setWarehouse] = useState(null),
    [lines, setLines] = useState([
      {
        key: command(),
        product: null,
        quantity: "1",
        unit_price: "",
        unit_factor: "1",
      },
    ]);
  const w = useWrite(onDone);
  const change = (key, name, value) =>
    setLines((rows) =>
      rows.map((row) => (row.key === key ? { ...row, [name]: value } : row)),
    );
  return (
    <Modal
      title={kind === "sale" ? "Novo pedido de venda" : "Novo pedido de compra"}
      description="O pedido será salvo como rascunho para revisão."
      onClose={onClose}
      busy={w.busy}
      wide
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!contact || !warehouse || lines.some((line) => !line.product))
            return;
          const d = formData(e.currentTarget);
          w.submit("/api/v1/orders", {
            command_id: w.id,
            kind,
            contact_id: contact.id,
            warehouse_id: warehouse.id,
            payment_terms: d.payment_terms,
            ...(d.expected_on ? { expected_on: d.expected_on } : {}),
            items: lines.map((row) => ({
              product_id: row.product.id,
              quantity: decimal(row.quantity),
              ...(row.unit_price
                ? { unit_price: decimal(row.unit_price, { places: 10 }) }
                : {}),
              unit_factor: decimal(row.unit_factor),
            })),
          });
        }}
      >
        <ErrorNotice error={w.error} />
        <fieldset disabled={w.busy}>
          <div className="form-grid">
            <EntitySelect
              label={kind === "sale" ? "Cliente" : "Fornecedor"}
              path="/api/v1/contacts"
              value={contact}
              onChange={setContact}
            />
            <EntitySelect
              label="Depósito"
              path="/api/v1/warehouses"
              value={warehouse}
              onChange={setWarehouse}
            />
          </div>
          <div className="form-grid">
            <Field label="Previsão de entrega" name="expected_on" type="date" />
            <Field
              label="Condições de pagamento"
              name="payment_terms"
              defaultValue={contact?.payment_terms || ""}
              key={contact?.id || "terms"}
              maxLength={200}
            />
          </div>
          <div className="section-head">
            <h3>Itens do pedido</h3>
            <button
              type="button"
              className="text-button"
              onClick={() =>
                setLines((rows) => [
                  ...rows,
                  {
                    key: command(),
                    product: null,
                    quantity: "1",
                    unit_price: "",
                    unit_factor: "1",
                  },
                ])
              }
            >
              <Icon name="plus" size={16} />
              Adicionar item
            </button>
          </div>
          {lines.map((row, index) => (
            <div className="order-line" key={row.key}>
              <div className="order-line-title">
                <strong>Item {index + 1}</strong>
                {lines.length > 1 && (
                  <button
                    type="button"
                    aria-label={`Remover item ${index + 1}`}
                    className="icon-button"
                    onClick={() =>
                      setLines((rows) =>
                        rows.filter((item) => item.key !== row.key),
                      )
                    }
                  >
                    <Icon name="close" size={17} />
                  </button>
                )}
              </div>
              <EntitySelect
                label="Produto"
                path="/api/v1/products"
                value={row.product}
                onChange={(v) => change(row.key, "product", v)}
                display={(p) => `${p.code} · ${p.name}`}
              />
              <div className="form-grid thirds">
                <Field
                  label="Quantidade"
                  inputMode="decimal"
                  pattern="[0-9]+([.,][0-9]{1,6})?"
                  required
                  value={row.quantity}
                  onChange={(e) => change(row.key, "quantity", e.target.value)}
                />
                <Field
                  label="Preço unitário (R$)"
                  inputMode="decimal"
                  pattern="[0-9]+([.,][0-9]{1,10})?"
                  value={row.unit_price}
                  placeholder="Calculado pelo servidor"
                  hint="Em branco: aplicar o preço vigente."
                  onChange={(e) =>
                    change(row.key, "unit_price", e.target.value)
                  }
                />
                <Field
                  label="Unidades por embalagem"
                  inputMode="decimal"
                  pattern="[0-9]+([.,][0-9]{1,6})?"
                  required
                  value={row.unit_factor}
                  onChange={(e) =>
                    change(row.key, "unit_factor", e.target.value)
                  }
                />
              </div>
            </div>
          ))}
        </fieldset>
        <FormActions busy={w.busy} onClose={onClose} label="Salvar rascunho" />
      </form>
    </Modal>
  );
}
function ReceiptForm({ order, items, onClose, onDone }) {
  const w = useWrite(onDone);
  const [confirmed, setConfirmed] = useState(false),
    [amounts, setAmounts] = useState({});
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const selected = items
          .filter(
            (i) => Number(String(amounts[i.id] || "0").replace(",", ".")) > 0,
          )
          .map((i) => ({ item_id: i.id, quantity: decimal(amounts[i.id]) }));
        if (!selected.length) return;
        w.submit(`/api/v1/orders/${order.id}/receipts`, {
          command_id: w.id,
          expected_version: order.version,
          confirmed,
          items: selected,
        });
      }}
    >
      <ErrorNotice error={w.error} />
      <Notice>
        Informe somente as quantidades fisicamente recebidas. O saldo de cada
        produto considera a conversão de embalagem cadastrada no pedido.
      </Notice>
      <fieldset disabled={w.busy}>
        {items.map((item) => (
          <div className="receipt-line" key={item.id}>
            <div>
              <strong>
                {item.product_name ||
                  item.name ||
                  item.description ||
                  item.product_id}
              </strong>
              <small>
                Pedido: {quantity(item.quantity)} · Recebido:{" "}
                {quantity(item.received ?? item.received_quantity ?? "0")}
              </small>
            </div>
            <Field
              label="Recebido agora"
              type="text"
              inputMode="decimal"
              pattern="[0-9]+([.,][0-9]{1,6})?"
              placeholder="0"
              value={amounts[item.id] || ""}
              onChange={(e) =>
                setAmounts({ ...amounts, [item.id]: e.target.value })
              }
            />
          </div>
        ))}
        <label className="checkbox">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
            required
          />
          <span>Conferi os produtos e confirmo as quantidades informadas.</span>
        </label>
      </fieldset>
      <FormActions
        busy={w.busy}
        onClose={onClose}
        label="Registrar recebimento"
      />
    </form>
  );
}
function FinanceForm({ order, onClose, onDone }) {
  const w = useWrite(onDone);
  const [parts, setParts] = useState([
    { id: command(), due_on: "", amount: order.total },
  ]);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        w.submit(`/api/v1/orders/${order.id}/finance`, {
          command_id: w.id,
          expected_version: order.version,
          installments: parts.map((p) => ({
            due_on: p.due_on,
            amount: decimal(p.amount),
          })),
        });
      }}
    >
      <ErrorNotice error={w.error} />
      <Notice>
        O lançamento cria{" "}
        {order.kind === "purchase" ? "contas a pagar" : "contas a receber"} em
        aberto. A soma das parcelas deve ser igual a {currency(order.total)}.
      </Notice>
      <fieldset disabled={w.busy}>
        {parts.map((part, index) => (
          <div className="form-grid installment" key={part.id}>
            <Field
              label={`Vencimento ${index + 1}`}
              type="date"
              required
              value={part.due_on}
              onChange={(e) =>
                setParts((rows) =>
                  rows.map((p) =>
                    p.id === part.id ? { ...p, due_on: e.target.value } : p,
                  ),
                )
              }
            />
            <Field
              label="Valor (R$)"
              inputMode="decimal"
              required
              pattern="[0-9]+([.,][0-9]{1,2})?"
              value={part.amount}
              onChange={(e) =>
                setParts((rows) =>
                  rows.map((p) =>
                    p.id === part.id ? { ...p, amount: e.target.value } : p,
                  ),
                )
              }
            />
            {parts.length > 1 && (
              <button
                type="button"
                className="text-button"
                onClick={() =>
                  setParts((rows) => rows.filter((p) => p.id !== part.id))
                }
              >
                Remover parcela
              </button>
            )}
          </div>
        ))}
        <button
          className="text-button"
          type="button"
          onClick={() =>
            setParts((rows) => [
              ...rows,
              { id: command(), due_on: "", amount: "" },
            ])
          }
        >
          <Icon name="plus" size={16} />
          Adicionar parcela
        </button>
      </fieldset>
      <FormActions busy={w.busy} onClose={onClose} label="Lançar financeiro" />
    </form>
  );
}
function FulfillmentForm({ order, onClose, onDone }) {
  const w = useWrite(onDone);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        w.submit(`/api/v1/orders/${order.id}/fulfill`, {
          command_id: w.id,
          expected_version: order.version,
          confirmed: true,
        });
      }}
    >
      <ErrorNotice error={w.error} />
      <Notice>
        Esta operação confirma a entrega e registra a saída dos produtos
        reservados no estoque.
      </Notice>
      <label className="checkbox">
        <input type="checkbox" required disabled={w.busy} />
        <span>Confirmo a entrega dos itens deste pedido.</span>
      </label>
      <FormActions busy={w.busy} onClose={onClose} label="Concluir entrega" />
    </form>
  );
}
function OrderDetail({ id, onClose, onDone }) {
  const [stage, setStage] = useState("detail"),
    [rev, setRev] = useState(0);
  const r = useResource(`/api/v1/orders/${id}`, rev);
  const w = useWrite(() => {
    setRev((v) => v + 1);
    onDone("Pedido confirmado.");
  });
  const order = r.data?.order,
    items = r.data?.items || [];
  return (
    <Modal
      title={
        stage === "receipt"
          ? "Conferir recebimento"
          : stage === "finance"
            ? "Lançamento financeiro"
            : stage === "fulfill"
              ? "Concluir entrega"
              : "Detalhes do pedido"
      }
      description={
        order
          ? `${order.kind === "purchase" ? "Compra" : "Venda"} · ${order.contact_name || ""}`
          : ""
      }
      wide
      onClose={onClose}
      busy={w.busy}
    >
      <ErrorNotice error={r.error} retry={r.retry} />
      {r.loading ? (
        <Loading />
      ) : order && stage === "fulfill" ? (
        <FulfillmentForm
          order={order}
          onClose={() => setStage("detail")}
          onDone={() => {
            setStage("detail");
            setRev((v) => v + 1);
            onDone("Entrega concluída e estoque registrado.");
          }}
        />
      ) : order && stage === "receipt" ? (
        <ReceiptForm
          order={order}
          items={items}
          onClose={() => setStage("detail")}
          onDone={() => {
            setStage("detail");
            setRev((v) => v + 1);
            onDone("Recebimento registrado.");
          }}
        />
      ) : order && stage === "finance" ? (
        <FinanceForm
          order={order}
          onClose={() => setStage("detail")}
          onDone={() => {
            setStage("detail");
            setRev((v) => v + 1);
            onDone("Financeiro lançado.");
          }}
        />
      ) : (
        order && (
          <>
            <div className="document-overview">
              <Badge value={order.status} />
              <span>{date(order.created_at)}</span>
              <strong>{currency(order.total)}</strong>
            </div>
            <ErrorNotice error={w.error} />
            <Table
              columns={[
                {
                  key: "name",
                  title: "Produto",
                  render: (i) =>
                    i.product_name || i.name || i.description || i.product_id,
                },
                {
                  key: "quantity",
                  title: "Qtd.",
                  align: "right",
                  render: (i) => quantity(i.quantity),
                },
                {
                  key: "unit_price",
                  title: "Preço",
                  align: "right",
                  render: (i) => currency(i.unit_price, 10),
                },
                {
                  key: "total",
                  title: "Total",
                  align: "right",
                  render: (i) => currency(i.total),
                },
              ]}
              items={items}
            />
            <div className="document-meta">
              <span>Pagamento</span>
              <strong>{order.payment_terms || "Não informado"}</strong>
            </div>
            <footer className="form-actions wrap">
              <CommercialPrint order={order} items={items} />
              {order.status === "draft" ? (
                <button
                  className="button primary"
                  disabled={w.busy}
                  onClick={() =>
                    w.submit(`/api/v1/orders/${id}/confirm`, {
                      command_id: w.id,
                      expected_version: order.version,
                    })
                  }
                >
                  Confirmar pedido
                </button>
              ) : (
                <>
                  {order.kind === "sale" && order.status === "confirmed" && (
                    <button
                      className="button primary"
                      onClick={() => setStage("fulfill")}
                    >
                      Concluir entrega
                    </button>
                  )}
                  {order.kind === "purchase" &&
                    ["confirmed", "partial", "partially_received"].includes(
                      order.status,
                    ) && (
                      <button
                        className="button primary"
                        onClick={() => setStage("receipt")}
                      >
                        Conferir recebimento
                      </button>
                    )}
                  <button
                    className="button secondary"
                    onClick={() => setStage("finance")}
                  >
                    Lançar financeiro
                  </button>
                </>
              )}
            </footer>
          </>
        )
      )}
    </Modal>
  );
}
export function Orders({ kind, revision, changed }) {
  const [create, setCreate] = useState(false),
    [selected, setSelected] = useState(null);
  return (
    <>
      <PageHead
        title={kind === "sale" ? "Vendas" : "Compras"}
        description={
          kind === "sale"
            ? "Do pedido ao financeiro, com um histórico consistente."
            : "Planeje pedidos e acompanhe o recebimento dos produtos."
        }
      >
        <button className="button primary" onClick={() => setCreate(true)}>
          <Icon name="plus" />
          Novo pedido
        </button>
      </PageHead>
      <DataList
        revision={revision}
        path={`/api/v1/orders?kind=${kind}`}
        onSelect={(row) => setSelected(row.id)}
        columns={[
          {
            key: "contact_name",
            title: kind === "sale" ? "Cliente" : "Fornecedor",
          },
          {
            key: "created_at",
            title: "Criado em",
            render: (r) => date(r.created_at),
          },
          {
            key: "status",
            title: "Situação",
            render: (r) => <Badge value={r.status} />,
          },
          {
            key: "total",
            title: "Total",
            align: "right",
            render: (r) => currency(r.total),
          },
        ]}
      />
      {create && (
        <OrderForm
          kind={kind}
          onClose={() => setCreate(false)}
          onDone={() => {
            setCreate(false);
            changed("Pedido salvo como rascunho.");
          }}
        />
      )}
      {selected && (
        <OrderDetail
          id={selected}
          onClose={() => setSelected(null)}
          onDone={changed}
        />
      )}
    </>
  );
}
function WarehouseForm({ onClose, onDone }) {
  const w = useWrite(onDone);
  return (
    <Modal title="Novo depósito" onClose={onClose} busy={w.busy}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          w.submit("/api/v1/warehouses", {
            ...formData(e.currentTarget),
            command_id: w.id,
          });
        }}
      >
        <ErrorNotice error={w.error} />
        <Field label="Nome do depósito" name="name" maxLength={120} required />
        <FormActions busy={w.busy} onClose={onClose} />
      </form>
    </Modal>
  );
}
function StockForm({ onClose, onDone }) {
  const [product, setProduct] = useState(null),
    [warehouse, setWarehouse] = useState(null);
  const w = useWrite(onDone);
  const r = useResource(
    product && warehouse
      ? `/api/v1/stock?${query({ product_id: product.id, warehouse_id: warehouse.id, limit: 100 })}`
      : null,
  );
  const position = r.data?.items?.find((p) => p.product_id === product?.id);
  return (
    <Modal
      title="Ajustar estoque"
      description="Registre uma contagem inicial ou uma correção justificada."
      onClose={onClose}
      busy={w.busy}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!product || !warehouse || r.loading || r.error) return;
          const d = formData(e.currentTarget);
          w.submit("/api/v1/stock/adjustments", {
            command_id: w.id,
            product_id: product.id,
            warehouse_id: warehouse.id,
            quantity: decimal(d.quantity, { signed: true }),
            reason: d.reason,
            expected_version: position?.version || 0,
          });
        }}
      >
        <ErrorNotice error={w.error || r.error} />
        <fieldset disabled={w.busy}>
          <EntitySelect
            label="Depósito"
            path="/api/v1/warehouses"
            value={warehouse}
            onChange={setWarehouse}
          />
          <EntitySelect
            label="Produto"
            path="/api/v1/products"
            value={product}
            onChange={setProduct}
          />
          {product && warehouse && !r.loading && !r.error && (
            <p className="help">
              Saldo atual:{" "}
              <strong>
                {quantity(position?.quantity || "0")} {product.unit}
              </strong>
            </p>
          )}
          <Field
            label="Quantidade a acrescentar ou retirar"
            name="quantity"
            inputMode="decimal"
            pattern="-?[0-9]+([.,][0-9]{1,6})?"
            required
            hint="Use um valor negativo para retirar. Ex.: 10 ou -2."
          />
          <Field
            label="Motivo"
            name="reason"
            required
            minLength={3}
            maxLength={500}
          />
        </fieldset>
        <FormActions
          busy={w.busy || r.loading}
          onClose={onClose}
          label="Registrar ajuste"
        />
      </form>
    </Modal>
  );
}
export function Stock({ revision, changed }) {
  const [modal, setModal] = useState(null),
    [warehouse, setWarehouse] = useState("");
  const r = useResource("/api/v1/warehouses", revision);
  return (
    <>
      <PageHead
        title="Estoque"
        description="Saldos, reservas e limites de reposição por depósito."
      >
        <button
          className="button secondary"
          onClick={() => setModal("warehouse")}
        >
          Novo depósito
        </button>
        <button className="button primary" onClick={() => setModal("stock")}>
          <Icon name="plus" />
          Ajustar estoque
        </button>
      </PageHead>
      <ErrorNotice error={r.error} />
      <DataList
        revision={revision}
        path={`/api/v1/stock?${query({ warehouse_id: warehouse })}`}
        toolbar={
          <select
            aria-label="Filtrar depósito"
            value={warehouse}
            onChange={(e) => setWarehouse(e.target.value)}
          >
            <option value="">Todos os depósitos</option>
            {r.data?.items?.map((row) => (
              <option key={row.id} value={row.id}>
                {row.name}
              </option>
            ))}
          </select>
        }
        columns={[
          {
            key: "name",
            title: "Produto",
            render: (r) => (
              <>
                <strong>{r.name}</strong>
                <small className="cell-sub">
                  {r.code}
                  {r.warehouse_name ? ` · ${r.warehouse_name}` : ""}
                </small>
              </>
            ),
          },
          {
            key: "quantity",
            title: "Saldo físico",
            align: "right",
            render: (r) => quantity(r.quantity),
          },
          {
            key: "reserved",
            title: "Reservado",
            align: "right",
            render: (r) => quantity(r.reserved),
          },
          {
            key: "available",
            title: "Disponível",
            align: "right",
            render: (r) => (
              <span
                className={
                  Number(r.available) < Number(r.stock_min) ? "low-stock" : ""
                }
              >
                {quantity(r.available)}
              </span>
            ),
          },
          {
            key: "stock_min",
            title: "Mínimo",
            align: "right",
            render: (r) => quantity(r.stock_min),
          },
          {
            key: "stock_max",
            title: "Máximo",
            align: "right",
            render: (r) => quantity(r.stock_max),
          },
        ]}
      />
      {modal === "warehouse" && (
        <WarehouseForm
          onClose={() => setModal(null)}
          onDone={() => {
            setModal(null);
            changed("Depósito cadastrado.");
          }}
        />
      )}
      {modal === "stock" && (
        <StockForm
          onClose={() => setModal(null)}
          onDone={() => {
            setModal(null);
            changed("Estoque ajustado.");
          }}
        />
      )}
    </>
  );
}
export function Finance({ revision }) {
  const [kind, setKind] = useState("payables");
  return (
    <>
      <PageHead
        title="Financeiro"
        description="Obrigações registradas a partir dos pedidos."
      >
        <div className="tabs">
          <button
            className={kind === "payables" ? "active" : ""}
            onClick={() => setKind("payables")}
          >
            A pagar
          </button>
          <button
            className={kind === "receivables" ? "active" : ""}
            onClick={() => setKind("receivables")}
          >
            A receber
          </button>
        </div>
      </PageHead>
      <Notice>
        Os lançamentos são criados nos detalhes do pedido. Registrar uma
        obrigação não executa um pagamento bancário.
      </Notice>
      <DataList
        key={kind}
        path={`/api/v1/${kind}`}
        revision={revision}
        columns={[
          {
            key: "contact_name",
            title: kind === "payables" ? "Fornecedor" : "Cliente",
          },
          { key: "due_on", title: "Vencimento", render: (r) => date(r.due_on) },
          {
            key: "status",
            title: "Situação",
            render: (r) => <Badge value={r.status} />,
          },
          {
            key: "amount",
            title: "Valor",
            align: "right",
            render: (r) => currency(r.amount),
          },
        ]}
      />
    </>
  );
}
export function Received({ revision, changed }) {
  const [importing, setImporting] = useState(false);
  const r = useResource("/api/v1/fiscal/capabilities", revision);
  const company = useResource("/api/v1/company/fiscal", revision);
  return (
    <>
      <PageHead
        title="Notas recebidas"
        description="Documentos fiscais disponíveis nesta instalação."
      >
        <button
          className="button primary"
          disabled={
            r.data?.xml_import !== true ||
            company.data?.capabilities?.xml_import !== true
          }
          onClick={() => setImporting(true)}
        >
          <Icon name="plus" />
          Importar XML
        </button>
      </PageHead>
      <ErrorNotice error={r.error} />
      <ErrorNotice error={company.error} retry={company.retry} />
      {r.data?.xml_import === true &&
        company.data &&
        !company.data.company?.document && (
          <Notice>
            Cadastre o CNPJ da empresa em <a href="#settings">Sua instalação</a>{" "}
            para habilitar a importação de documentos recebidos.
          </Notice>
        )}
      {r.data && (
        <Notice>
          {r.data.message ||
            r.data.reason ||
            "A coleta automática e as operações fiscais dependem da configuração e dos perfis habilitados nesta instalação."}
        </Notice>
      )}
      <DataList
        path="/api/v1/invoices/received"
        revision={revision}
        columns={[
          {
            key: "supplier_name",
            title: "Fornecedor",
            render: (r) =>
              r.supplier_name || r.issuer_name || "Não identificado",
          },
          { key: "number", title: "Nota" },
          {
            key: "issued_on",
            title: "Emissão",
            render: (r) => date(r.issued_on || r.issued_at),
          },
          {
            key: "status",
            title: "Situação",
            render: (r) => <Badge value={r.document_state || r.status} />,
          },
          {
            key: "total",
            title: "Total",
            align: "right",
            render: (r) => currency(r.total),
          },
        ]}
        emptyTitle="Nenhuma nota recebida"
      />
      {importing && (
        <InvoiceImport
          onClose={() => setImporting(false)}
          onDone={() => {
            setImporting(false);
            changed?.(
              "XML importado. A assinatura e os tributos ainda precisam de verificação.",
            );
          }}
        />
      )}
    </>
  );
}
export function Events({ revision }) {
  return (
    <>
      <PageHead
        title="Atividades"
        description="Eventos registrados pelo servidor para acompanhamento e integração."
      />
      <DataList
        path="/api/v1/events"
        revision={revision}
        columns={[
          {
            key: "type",
            title: "Evento",
            render: (r) => r.type || r.event_type,
          },
          {
            key: "created_at",
            title: "Data",
            render: (r) => date(r.created_at),
          },
          {
            key: "aggregate_id",
            title: "Registro",
            render: (r) => (
              <span className="mono small-text">
                {r.aggregate_id || r.resource_id || "—"}
              </span>
            ),
          },
        ]}
        emptyTitle="Nenhuma atividade registrada"
      />
    </>
  );
}
