import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { currency, date, label, quantity } from "./format.mjs";
import { ErrorNotice, Icon, useResource } from "./components.jsx";

export function CommercialPrint({ order, items }) {
  const [active, setActive] = useState(false);
  const company = useResource("/api/v1/me");
  useEffect(() => {
    if (!active) return;
    const previousTitle = document.title;
    document.body.classList.add("fagoo-print-active");
    document.title = `FAGOO - Pedido de ${order.kind === "purchase" ? "compra" : "venda"} - ${order.id}`;
    const finished = () => setActive(false);
    window.addEventListener("afterprint", finished);
    const timer = setTimeout(() => window.print(), 0);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("afterprint", finished);
      document.body.classList.remove("fagoo-print-active");
      document.title = previousTitle;
    };
  }, [active, order.id, order.kind]);

  return (
    <>
      <button
        className="button secondary"
        disabled={company.loading || !!company.error}
        onClick={() => setActive(true)}
      >
        <Icon name="file" size={17} />
        Imprimir pedido
      </button>
      {company.error && (
        <ErrorNotice error={company.error} retry={company.retry} />
      )}
      {active &&
        createPortal(
          <article className="commercial-print">
            <header className="print-heading">
              <div>
                <span className="print-brand">
                  fagoo<span>.</span>
                </span>
                <h1>
                  Pedido de {order.kind === "purchase" ? "compra" : "venda"}
                </h1>
                <p>Documento comercial</p>
              </div>
              <div>
                <strong>{company.data?.company?.name || "Empresa"}</strong>
                <p>{location.host}</p>
                <span className="print-status">{label(order.status)}</span>
              </div>
            </header>
            <section className="print-reference">
              <span>Identificação do pedido</span>
              <strong>{order.id}</strong>
            </section>
            <section className="print-details">
              <div>
                <span>
                  {order.kind === "purchase" ? "Fornecedor" : "Cliente"}
                </span>
                <strong>{order.contact_name || "Não informado"}</strong>
              </div>
              <div>
                <span>Data de criação</span>
                <strong>{date(order.created_at)}</strong>
              </div>
              <div>
                <span>Depósito</span>
                <strong>{order.warehouse_name || "Não informado"}</strong>
              </div>
              <div>
                <span>Entrega prevista</span>
                <strong>{date(order.expected_on)}</strong>
              </div>
            </section>
            <table className="print-items">
              <thead>
                <tr>
                  <th>Código / produto</th>
                  <th>Qtd. do pedido</th>
                  <th>Unid. estoque</th>
                  <th>Fator p/ estoque</th>
                  <th>Preço unitário</th>
                  <th>Total</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <strong>
                        {item.description || item.name || item.product_name}
                      </strong>
                      <small>{item.code}</small>
                    </td>
                    <td>{quantity(item.quantity)}</td>
                    <td>{item.unit}</td>
                    <td>{quantity(item.unit_factor)}</td>
                    <td>{currency(item.unit_price, 10)}</td>
                    <td>{currency(item.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <section className="print-total">
              <span>Total do pedido</span>
              <strong>{currency(order.total)}</strong>
            </section>
            <section className="print-terms">
              <span>Condições de pagamento</span>
              <p>{order.payment_terms || "Não informadas no pedido."}</p>
            </section>
            <footer className="print-footnote">
              <p>
                Quantidade de estoque = quantidade do pedido × fator de
                conversão.
              </p>
              <p>
                Este documento não substitui documento fiscal e não comprova
                pagamento ou quitação.
              </p>
              <strong>FAGOO · {location.host}</strong>
            </footer>
          </article>,
          document.body,
        )}
    </>
  );
}
