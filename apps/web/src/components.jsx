import React, { useEffect, useId, useRef, useState } from "react";
import { api, query } from "./api.mjs";
import { label, readableError } from "./format.mjs";

const paths = {
  grid: "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z",
  box: "m3 7 9-4 9 4v10l-9 4-9-4V7Zm0 0 9 4 9-4m-9 4v10M7.5 5 17 9",
  users:
    "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-3.87M9 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8m8 0a4 4 0 0 1 0 8",
  cart: "M3 3h2l3 12h11l3-9H6m4 13h.01M18 19h.01",
  truck:
    "M1 4h13v13H1zM14 8h4l4 5v4h-8M5 17a2 2 0 1 0 0 4 2 2 0 0 0 0-4m13 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4",
  layers: "m12 3 10 5-10 5L2 8l10-5Zm-10 9 10 5 10-5M2 16l10 5 10-5",
  wallet: "M3 5h16v15H3zM3 5V3h14v2M15 10h7v6h-7z",
  file: "M14 2H5v20h14V7l-5-5Zm0 0v5h5M8 12h8m-8 4h8",
  plug: "M8 2v6m8-6v6M5 8h14v4a7 7 0 0 1-14 0V8Zm7 11v3",
  settings:
    "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1 1-3Z",
  update: "M3 11a9 9 0 0 1 15-6l3 3m0-6v6h-6m6 5a9 9 0 0 1-15 6l-3-3m0 6v-6h6",
  bell: "M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9m-12 12h0m3 0a3 3 0 0 0 6 0",
  search: "M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14m5 12 6 6",
  plus: "M12 4v16M4 12h16",
  arrow: "M5 12h14m-6-6 6 6-6 6",
  close: "m6 6 12 12M6 18 18 6",
  check: "m4 12 5 5L20 6",
  logout: "M9 3H3v18h6m5-14 5 5-5 5m-6-5h13",
  menu: "M3 6h18M3 12h18M3 18h18",
  chart: "M4 20V4m0 16h17M8 15l4-5 4 2 5-7",
  copy: "M9 8h12v13H9zM5 16H3V3h12v2",
  lock: "M5 10h14v11H5zM8 10V6a4 4 0 0 1 8 0v4",
  alert: "m12 3 10 18H2L12 3Zm0 6v5m0 3h.01",
  server: "M3 3h18v7H3zM3 14h18v7H3zM7 6h.01M7 17h.01",
  leaf: "M20 3C8 2 2 7 5 15c8 4 15 0 15-12ZM5 21 16 9",
};
export function Icon({ name, size = 20, ...props }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d={paths[name] || paths.file} />
    </svg>
  );
}
export function Logo({ small = false }) {
  return (
    <span className={`brand ${small ? "small" : ""}`}>
      <span className="brand-mark">f</span>
      <span>
        fagoo<span className="brand-dot">.</span>
      </span>
    </span>
  );
}
export function Badge({ value }) {
  return (
    <span className={`badge badge-${String(value).replace(/[^a-z_-]/g, "")}`}>
      {label(value)}
    </span>
  );
}
export function ErrorNotice({ error, retry }) {
  return error ? (
    <div className="notice error" role="alert">
      <Icon name="alert" />
      <div>
        {readableError(error)}
        {error.code && <small>Referência: {error.code}</small>}
      </div>
      {retry && (
        <button className="text-button" onClick={retry}>
          Tentar novamente
        </button>
      )}
    </div>
  ) : null;
}
export function Notice({ children, kind = "info" }) {
  return (
    <div className={`notice ${kind}`}>
      <Icon name={kind === "success" ? "check" : "alert"} />
      <div>{children}</div>
    </div>
  );
}
export function Empty({
  title = "Nenhum registro por aqui",
  children,
  icon = "box",
}) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <Icon name={icon} size={27} />
      </span>
      <h3>{title}</h3>
      <p>
        {children ||
          "Os registros aparecerão aqui assim que forem cadastrados."}
      </p>
    </div>
  );
}
export function Loading() {
  return (
    <div className="loading" role="status">
      <span className="spinner" />
      Buscando dados do servidor…
    </div>
  );
}
export function useResource(path, revision = 0) {
  const [data, setData] = useState(null),
    [error, setError] = useState(null),
    [loading, setLoading] = useState(true),
    [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!path) {
      setLoading(false);
      return;
    }
    const abort = new AbortController();
    setLoading(true);
    setError(null);
    api(path, { signal: abort.signal })
      .then(setData)
      .catch((e) => {
        if (e.name !== "AbortError") setError(e);
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [path, revision, attempt]);
  return { data, error, loading, retry: () => setAttempt((v) => v + 1) };
}
export function useDebounced(value, delay = 220) {
  const [v, set] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => set(value), delay);
    return () => clearTimeout(id);
  }, [value, delay]);
  return v;
}
export function PageHead({
  eyebrow = "Sua operação",
  title,
  description,
  children,
}) {
  return (
    <header className="page-head">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {children && <div className="head-actions">{children}</div>}
    </header>
  );
}
export function Search({
  value,
  onChange,
  placeholder = "Pesquisar registros",
}) {
  return (
    <label className="search">
      <Icon name="search" />
      <input
        aria-label={placeholder}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}
export function Table({ columns, items, onSelect }) {
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} className={c.align === "right" ? "number" : ""}>
                {c.title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {items.map((item, index) => (
            <tr
              key={
                item.id ||
                `${item.product_id || index}-${item.warehouse_id || ""}`
              }
            >
              {columns.map((c, i) => (
                <td key={c.key} className={c.align === "right" ? "number" : ""}>
                  {i === 0 && onSelect ? (
                    <button className="row-link" onClick={() => onSelect(item)}>
                      {c.render ? c.render(item) : (item[c.key] ?? "—")}
                    </button>
                  ) : c.render ? (
                    c.render(item)
                  ) : (
                    (item[c.key] ?? "—")
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
function PagedRows({ path, columns, onSelect, emptyTitle }) {
  const [cursor, setCursor] = useState(null),
    [items, setItems] = useState([]);
  const eventFeed = path.split("?")[0] === "/api/v1/events";
  const route =
    path +
    (path.includes("?") ? "&" : "?") +
    query(eventFeed ? { limit: 50, after: cursor } : { limit: 50, cursor });
  const result = useResource(route);
  useEffect(() => {
    if (result.data) {
      setItems((previous) =>
        cursor
          ? [
              ...previous,
              ...result.data.items.filter(
                (row) => !previous.some((old) => old.id && old.id === row.id),
              ),
            ]
          : result.data.items || [],
      );
    }
  }, [result.data, cursor]);
  return (
    <>
      <ErrorNotice error={result.error} retry={result.retry} />
      {result.loading && items.length === 0 ? (
        <Loading />
      ) : items.length ? (
        <Table columns={columns} items={items} onSelect={onSelect} />
      ) : (
        !result.error && <Empty title={emptyTitle} />
      )}
      <div className="table-footer">
        <span>
          {result.data?.total !== undefined
            ? `${items.length} de ${result.data.total} registros`
            : `${items.length} registros`}
        </span>
        {result.data?.has_more && (
          <button
            className="button secondary small"
            disabled={
              result.loading ||
              (!result.data.next_cursor && !result.data.next_after)
            }
            onClick={() =>
              setCursor(result.data.next_cursor || result.data.next_after)
            }
          >
            {result.loading ? "Carregando…" : "Carregar mais"}
          </button>
        )}
      </div>
    </>
  );
}
export function DataList({
  path,
  columns,
  onSelect,
  revision = 0,
  toolbar,
  emptyTitle,
}) {
  const [q, setQ] = useState(""),
    search = useDebounced(q);
  const searchable = ["/api/v1/products", "/api/v1/contacts"].includes(
    path.split("?")[0],
  );
  const route = path + (path.includes("?") ? "&" : "?") + query({ q: search });
  return (
    <section className="panel">
      <div className="table-tools">
        {searchable ? (
          <Search value={q} onChange={setQ} />
        ) : (
          <span className="list-caption">Registros desta instalação</span>
        )}
        {toolbar}
      </div>
      <PagedRows
        key={`${route}|${revision}`}
        path={route}
        columns={columns}
        onSelect={onSelect}
        emptyTitle={emptyTitle}
      />
    </section>
  );
}
export function Field({ label: caption, hint, children, ...props }) {
  const id = useId();
  const described = hint ? `${id}-hint` : undefined;
  return (
    <div className="field">
      <label htmlFor={id}>{caption}</label>
      {children ? (
        React.cloneElement(children, { id, "aria-describedby": described })
      ) : (
        <input id={id} aria-describedby={described} {...props} />
      )}{" "}
      {hint && <small id={described}>{hint}</small>}
    </div>
  );
}
export function EntitySelect({
  label: caption,
  path,
  value,
  onChange,
  display = (row) => row.name,
  required = true,
}) {
  const [q, setQ] = useState(""),
    search = useDebounced(q),
    result = useResource(
      path === "/api/v1/warehouses"
        ? path
        : path + "?" + query({ q: search, limit: 30 }),
    );
  const items = result.data?.items || [];
  return (
    <div className="field">
      <span>{caption}</span>
      {path !== "/api/v1/warehouses" && (
        <input
          aria-label={`Buscar ${caption.toLowerCase()}`}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={`Buscar ${caption.toLowerCase()}…`}
        />
      )}
      <select
        aria-label={caption}
        required={required}
        value={value?.id || ""}
        onChange={(e) =>
          onChange(items.find((row) => row.id === e.target.value) || null)
        }
      >
        <option value="">{result.loading ? "Carregando…" : "Selecione"}</option>
        {value && !items.some((row) => row.id === value.id) && (
          <option value={value.id}>{display(value)}</option>
        )}
        {items.map((row) => (
          <option key={row.id} value={row.id}>
            {display(row)}
          </option>
        ))}
      </select>
      {result.error && (
        <small className="field-error">{readableError(result.error)}</small>
      )}
      {result.data?.has_more && (
        <small>Refine a busca para encontrar outros registros.</small>
      )}
    </div>
  );
}
export function Modal({
  title,
  description,
  children,
  onClose,
  wide = false,
  busy = false,
}) {
  const ref = useRef(null),
    titleId = useId();
  useEffect(() => {
    const prior = document.activeElement;
    const el = ref.current;
    const focusables = () => [
      ...el.querySelectorAll(
        "button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href]",
      ),
    ];
    focusables()[0]?.focus();
    const key = (e) => {
      if (e.key === "Escape" && !busy) onClose();
      if (e.key === "Tab") {
        const list = focusables();
        const first = list[0],
          last = list.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    el.addEventListener("keydown", key);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      el.removeEventListener("keydown", key);
      document.body.style.overflow = overflow;
      prior?.focus();
    };
  }, [busy]);
  return (
    <div className="modal-backdrop">
      <section
        className={`modal ${wide ? "wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={ref}
      >
        <header>
          <div>
            <h2 id={titleId}>{title}</h2>
            {description && <p>{description}</p>}
          </div>
          <button
            aria-label="Fechar janela"
            className="icon-button"
            disabled={busy}
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}
export function FormActions({ busy, onClose, label: caption = "Salvar" }) {
  return (
    <footer className="form-actions">
      <button
        type="button"
        className="button secondary"
        disabled={busy}
        onClick={onClose}
      >
        Cancelar
      </button>
      <button type="submit" className="button primary" disabled={busy}>
        {busy ? (
          <>
            <span className="spinner" />
            Salvando…
          </>
        ) : (
          caption
        )}
      </button>
    </footer>
  );
}
