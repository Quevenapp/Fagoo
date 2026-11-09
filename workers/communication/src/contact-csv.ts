import { ApiError, requireValue } from "./types";

export const CONTACT_CSV_BYTES = 1024 * 1024;
export const CONTACT_CSV_ROWS = 500;
export type ContactValues = {
  name: string;
  phone: string;
  email: string;
  company: string;
  notes: string;
};
export function searchText(value: string) {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}
export function contactValues(data: any): ContactValues {
  requireValue(
    data && typeof data === "object" && !Array.isArray(data),
    "Informe os dados do contato.",
  );
  const field = (key: string, label: string, max: number) => {
    const value = data[key] ?? "";
    requireValue(
      typeof value === "string" && value.length <= max,
      `${label}: use até ${max} caracteres.`,
    );
    requireValue(
      !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffd]/.test(value),
      `${label}: caractere inválido. Salve o arquivo em UTF-8.`,
    );
    return value.trim();
  };
  const name = field("name", "Nome", 120);
  requireValue(name, "Informe o nome do contato.");
  const rawPhone = field("phone", "Telefone", 40);
  requireValue(
    !rawPhone || /^[+\d\s().-]+$/.test(rawPhone),
    "Telefone: use números, incluindo DDI e DDD.",
  );
  const phone = rawPhone.replace(/\D/g, "");
  requireValue(
    !rawPhone || /^\d{8,15}$/.test(phone),
    "Telefone: informe de 8 a 15 dígitos, incluindo DDI e DDD.",
  );
  const email = field("email", "E-mail", 254).toLowerCase();
  requireValue(
    !email || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),
    "E-mail inválido.",
  );
  return {
    name,
    phone,
    email,
    company: field("company", "Empresa", 160),
    notes: field("notes", "Observações", 2000),
  };
}

// RFC 4180 quoting, with the semicolon dialect commonly saved by Brazilian Excel.
function records(csv: string, delimiter: string) {
  const rows: { line: number; cells: string[] }[] = [];
  let cells: string[] = [],
    cell = "",
    quoted = false,
    closed = false,
    line = 1,
    start = 1;
  const finish = () => {
    cells.push(cell);
    if (cells.some((value) => value.trim())) rows.push({ line: start, cells });
    requireValue(
      rows.length <= CONTACT_CSV_ROWS + 1,
      `Use até ${CONTACT_CSV_ROWS} contatos por arquivo.`,
    );
    cells = [];
    cell = "";
    closed = false;
  };
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i];
    if (quoted) {
      if (c === '"') {
        if (csv[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else {
        cell += c;
        if (c === "\n" || (c === "\r" && csv[i + 1] !== "\n")) line++;
      }
      continue;
    }
    if (c === delimiter) {
      cells.push(cell);
      cell = "";
      closed = false;
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && csv[i + 1] === "\n") i++;
      finish();
      line++;
      start = line;
    } else if (c === '"' && !cell && !closed) quoted = true;
    else {
      requireValue(
        !closed && c !== '"',
        `Aspas inválidas na linha ${line}. Use CSV com campos entre aspas duplas.`,
      );
      cell += c;
    }
    requireValue(
      cells.length <= 50,
      "O CSV tem colunas demais. Use o modelo da agenda.",
    );
  }
  requireValue(!quoted, `Falta fechar aspas na linha ${start}.`);
  finish();
  return rows;
}

export function parseContactCsv(input: unknown) {
  requireValue(
    typeof input === "string" &&
      new TextEncoder().encode(input).length <= CONTACT_CSV_BYTES,
    "Envie um CSV UTF-8 de até 1 MB.",
  );
  let csv = input.replace(/^\ufeff/, "");
  requireValue(
    !csv.includes("\ufffd"),
    "O arquivo não está em UTF-8. Salve como CSV UTF-8 e tente novamente.",
  );
  let delimiter = ",";
  const separator = csv.match(/^sep=([;,])\r?\n/i);
  if (separator) {
    delimiter = separator[1];
    csv = csv.slice(separator[0].length);
  } else {
    let quotes = false,
      commas = 0,
      semicolons = 0;
    for (const c of csv) {
      if (c === '"') quotes = !quotes;
      if (!quotes && (c === "\n" || c === "\r")) break;
      if (!quotes && c === ",") commas++;
      if (!quotes && c === ";") semicolons++;
    }
    if (semicolons > commas) delimiter = ";";
  }
  const parsed = records(csv, delimiter),
    header = parsed.shift();
  requireValue(header, "O CSV está vazio. Baixe o modelo da agenda.");
  const aliases: Record<string, keyof ContactValues> = {
    nome: "name",
    name: "name",
    telefone: "phone",
    phone: "phone",
    celular: "phone",
    whatsapp: "phone",
    email: "email",
    empresa: "company",
    company: "company",
    observacoes: "notes",
    observacao: "notes",
    notas: "notes",
    notes: "notes",
  };
  const columns = header.cells.map(
    (name) => aliases[searchText(name.trim()).replace(/[\s_-]/g, "")],
  );
  requireValue(
    columns.includes("name"),
    "Falta a coluna nome. Baixe o modelo da agenda.",
  );
  const known = columns.filter(Boolean);
  requireValue(
    new Set(known).size === known.length,
    "Há colunas repetidas no cabeçalho do CSV.",
  );
  requireValue(
    parsed.length,
    "O CSV precisa ter pelo menos um contato além do cabeçalho.",
  );
  const rows: { line: number; values: ContactValues }[] = [],
    errors: { line: number; message: string }[] = [];
  for (const row of parsed) {
    try {
      requireValue(
        row.cells.length === header.cells.length,
        "Quantidade de colunas diferente do cabeçalho.",
      );
      const data: Record<string, string> = {};
      columns.forEach((field, index) => {
        if (field) data[field] = row.cells[index];
      });
      rows.push({
        line: row.line + (separator ? 1 : 0),
        values: contactValues(data),
      });
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      errors.push({
        line: row.line + (separator ? 1 : 0),
        message: error.message,
      });
    }
  }
  return {
    rows,
    errors,
    total: parsed.length,
    delimiter,
    ignored_columns: header.cells.filter((_, index) => !columns[index]),
  };
}
