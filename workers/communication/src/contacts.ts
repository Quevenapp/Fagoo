import { all, one, batch, exec } from "./db";
import { access, sha } from "./security";
import {
  ApiError,
  type Actor,
  type Env,
  requireValue,
  now,
  uid,
} from "./types";
import {
  contactValues,
  parseContactCsv,
  searchText,
  type ContactValues,
} from "./contact-csv";
import { visibleConversation } from "./visibility";

export const contactNamespace = (actor: Actor) =>
  actor.kind === "app" ? `app:${actor.id}` : "team";
export const conversationContactNamespace = (conv: any) =>
  conv.external_namespace.startsWith("app:") ? conv.external_namespace : "team";
function publicContact(row: any) {
  if (!row) return null;
  const { import_fingerprint, search_text, ...result } = row;
  return result;
}
export async function getContact(
  env: Env,
  actor: Actor,
  profile: string,
  id: string,
) {
  const row = await one(
    env,
    "SELECT * FROM contacts WHERE id=? AND profile_id=? AND (?=1 OR namespace=?)",
    id,
    profile,
    actor.kind === "user" ? 1 : 0,
    contactNamespace(actor),
  );
  if (!row) throw new ApiError(404, "not_found", "Contato não encontrado.");
  return publicContact(row)!;
}
export async function conversationContact(
  env: Env,
  actor: Actor,
  profile: string,
  conversation: string,
) {
  if (actor.kind === "app" && !actor.scopes.includes("contacts:read"))
    return null;
  return publicContact(
    await one(
      env,
      "SELECT c.* FROM contacts c JOIN conversation_contacts l ON l.contact_id=c.id AND l.profile_id=c.profile_id WHERE l.profile_id=? AND l.conversation_id=? AND (?=1 OR c.namespace=?)",
      profile,
      conversation,
      actor.kind === "user" ? 1 : 0,
      contactNamespace(actor),
    ),
  );
}
export async function listContacts(
  env: Env,
  actor: Actor,
  profile: string,
  query: { q?: string; cursor?: string; limit?: string; namespace?: string },
) {
  access(actor, profile, "contacts:read");
  let after: [number, string] | null = null;
  try {
    if (query.cursor) {
      after = JSON.parse(atob(query.cursor));
      if (
        !Array.isArray(after) ||
        after.length !== 2 ||
        !Number.isSafeInteger(after[0]) ||
        typeof after[1] !== "string" ||
        after[1].length > 100
      )
        throw Error();
    }
  } catch {
    throw new ApiError(400, "invalid_cursor", "Cursor inválido.");
  }
  const limit = Math.min(
    100,
    Math.max(1, Math.trunc(Number(query.limit)) || 50),
  );
  const q = searchText((query.q || "").slice(0, 200)).replace(/[!%_]/g, "!$&");
  const namespace = (query.namespace || "").slice(0, 100);
  const rows = await all(
    env,
    "SELECT c.*, (SELECT count(*) FROM conversation_contacts l WHERE l.contact_id=c.id AND l.profile_id=c.profile_id) conversation_count FROM contacts c WHERE c.profile_id=? AND (?=1 OR c.namespace=?) AND (?='' OR c.namespace=?) AND c.search_text LIKE ? ESCAPE '!' AND (? IS NULL OR c.created<? OR (c.created=? AND c.id<?)) ORDER BY c.created DESC,c.id DESC LIMIT ?",
    profile,
    actor.kind === "user" ? 1 : 0,
    contactNamespace(actor),
    namespace,
    namespace,
    `%${q}%`,
    after?.[0] ?? null,
    after?.[0] ?? 0,
    after?.[0] ?? 0,
    after?.[1] ?? "",
    limit + 1,
  );
  const more = rows.length > limit;
  rows.splice(limit);
  const last = rows.at(-1);
  return {
    data: rows.map(publicContact),
    next_cursor:
      more && last ? btoa(JSON.stringify([last.created, last.id])) : null,
  };
}
export async function contactDetail(
  env: Env,
  actor: Actor,
  profile: string,
  id: string,
) {
  access(actor, profile, "contacts:read");
  const contact = await getContact(env, actor, profile, id);
  const conversations =
    actor.kind === "app" && !actor.scopes.includes("conversations:read")
      ? []
      : await all(
          env,
          "SELECT c.id,c.phone,c.external_id,c.state,c.updated FROM conversations c JOIN conversation_contacts l ON l.conversation_id=c.id AND l.profile_id=c.profile_id WHERE l.profile_id=? AND l.contact_id=? AND (?=1 OR c.external_namespace=?) ORDER BY c.updated DESC,c.id DESC LIMIT 50",
          profile,
          id,
          actor.kind === "user" ? 1 : 0,
          contactNamespace(actor),
        );
  return { contact, conversations };
}
function insertContact(
  actor: Actor,
  profile: string,
  namespace: string,
  values: ContactValues,
  source: string,
  fingerprint: string | null = null,
): { id: string; statement: [string, any[]] } {
  const id = uid(),
    time = now();
  return {
    id,
    statement: [
      "INSERT INTO contacts(id,profile_id,namespace,name,phone,email,company,notes,search_text,source,import_fingerprint,created_by,updated_by,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      [
        id,
        profile,
        namespace,
        values.name,
        values.phone,
        values.email,
        values.company,
        values.notes,
        searchText(
          [values.name, values.phone, values.email, values.company].join(" "),
        ),
        source,
        fingerprint,
        actor.id,
        actor.id,
        time,
        time,
      ],
    ],
  };
}
async function importPlan(
  env: Env,
  actor: Actor,
  profile: string,
  csv: unknown,
) {
  const parsed = parseContactCsv(csv);
  const hashed = await Promise.all(
    parsed.rows.map(async (row) => ({
      ...row,
      fingerprint: await sha(JSON.stringify(row.values)),
    })),
  );
  const existing = new Set(
    (
      await all(
        env,
        "SELECT import_fingerprint FROM contacts WHERE profile_id=? AND namespace=? AND import_fingerprint IN (SELECT value FROM json_each(?))",
        profile,
        contactNamespace(actor),
        JSON.stringify(hashed.map((r) => r.fingerprint)),
      )
    ).map((r) => r.import_fingerprint),
  );
  const rows = hashed.map((row) => {
    const duplicate = existing.has(row.fingerprint);
    existing.add(row.fingerprint);
    return { ...row, duplicate };
  });
  return {
    ...parsed,
    rows,
    new_count: rows.filter((r) => !r.duplicate).length,
    skipped_count: rows.filter((r) => r.duplicate).length,
  };
}
export async function previewContactCsv(
  env: Env,
  actor: Actor,
  profile: string,
  csv: unknown,
) {
  access(actor, profile, "contacts:write");
  const plan = await importPlan(env, actor, profile, csv);
  return { ...plan, rows: plan.rows.map(({ fingerprint, ...row }) => row) };
}
export async function contactCommand(
  env: Env,
  actor: Actor,
  profile: string,
  operation: string,
  data: any,
) {
  access(actor, profile, "contacts:write");
  if (operation === "contact.create") {
    const row = insertContact(
      actor,
      profile,
      contactNamespace(actor),
      contactValues(data),
      "manual",
    );
    await batch(env, [row.statement]);
    return getContact(env, actor, profile, row.id);
  }
  if (operation === "contact.update") {
    const old = await getContact(env, actor, profile, data.id);
    requireValue(
      Number.isSafeInteger(data.expected_version),
      "Informe a versão do contato que está editando.",
    );
    if (data.expected_version !== old.version)
      throw new ApiError(
        409,
        "contact_conflict",
        "Este contato foi alterado. Reabra-o antes de salvar.",
      );
    const values = contactValues({ ...old, ...data });
    await exec(
      env,
      "UPDATE contacts SET name=?,phone=?,email=?,company=?,notes=?,search_text=?,updated_by=?,version=version+1,updated=? WHERE id=? AND profile_id=?",
      values.name,
      values.phone,
      values.email,
      values.company,
      values.notes,
      searchText(
        [values.name, values.phone, values.email, values.company].join(" "),
      ),
      actor.id,
      now(),
      old.id,
      profile,
    );
    return getContact(env, actor, profile, old.id);
  }
  if (operation === "contact.import") {
    const plan = await importPlan(env, actor, profile, data.csv);
    if (plan.errors.length)
      throw new ApiError(
        400,
        "invalid_csv",
        `Nenhum contato foi importado. Corrija ${plan.errors.length} linha(s): linha ${plan.errors[0].line}, ${plan.errors[0].message}`,
      );
    const statements = plan.rows
      .filter((row) => !row.duplicate)
      .map(
        (row) =>
          insertContact(
            actor,
            profile,
            contactNamespace(actor),
            row.values,
            "csv",
            row.fingerprint,
          ).statement,
      );
    // One D1 batch is atomic: a failed import cannot leave a partially imported file.
    if (statements.length) await batch(env, statements);
    return {
      imported: statements.length,
      skipped: plan.skipped_count,
      total: plan.total,
    };
  }
  if (["contact.from-conversation", "contact.unlink"].includes(operation)) {
    access(actor, profile, "conversations:read");
    const conv = await one(
      env,
      "SELECT * FROM conversations WHERE id=? AND profile_id=?",
      data.id,
      profile,
    );
    if (
      !conv ||
      !visibleConversation(actor, conv) ||
      (actor.kind === "app" &&
        conv.external_namespace !== contactNamespace(actor))
    )
      throw new ApiError(404, "not_found", "Conversa não encontrada.");
    requireValue(conv.chat_type!=="group","Um grupo não pode ser salvo como uma pessoa na agenda.");
    const linked = await one(
      env,
      "SELECT contact_id FROM conversation_contacts WHERE conversation_id=? AND profile_id=?",
      conv.id,
      profile,
    );
    if (operation === "contact.unlink") {
      requireValue(
        typeof data.expected_contact_id === "string" &&
          data.expected_contact_id.length > 0,
        "Informe o contato que deseja desvincular.",
      );
      if (linked && linked.contact_id !== data.expected_contact_id)
        throw new ApiError(
          409,
          "contact_conflict",
          "O contato desta conversa mudou. Reabra a conversa antes de desvincular.",
        );
      await exec(
        env,
        "DELETE FROM conversation_contacts WHERE conversation_id=? AND profile_id=?",
        conv.id,
        profile,
      );
      return { id: conv.id, unlinked: true };
    }
    if (linked) {
      if (data.contact_id === linked.contact_id)
        return getContact(env, actor, profile, linked.contact_id);
      throw new ApiError(
        409,
        "contact_already_linked",
        "A conversa já tem um contato. Reabra a conversa para editar ou desvincular.",
      );
    }
    const namespace = conversationContactNamespace(conv);
    let id: string;
    const statements: [string, any[]][] = [];
    if (data.contact_id) {
      requireValue(typeof data.contact_id === "string", "Informe o contato.");
      const chosen = await getContact(env, actor, profile, data.contact_id);
      if (chosen.namespace !== namespace)
        throw new ApiError(
          409,
          "contact_namespace_conflict",
          "Escolha um contato desta equipe ou desta mesma integração.",
        );
      id = chosen.id;
    } else {
      const row = insertContact(
        actor,
        profile,
        namespace,
        contactValues(data),
        "conversation",
      );
      id = row.id;
      statements.push(row.statement);
    }
    statements.push([
      "INSERT INTO conversation_contacts(conversation_id,profile_id,contact_id,linked_by,created) VALUES(?,?,?,?,?)",
      [conv.id, profile, id, actor.id, now()],
    ]);
    await batch(env, statements);
    return getContact(env, actor, profile, id);
  }
  throw new ApiError(400, "unknown_operation", "Operação de contato inválida.");
}
