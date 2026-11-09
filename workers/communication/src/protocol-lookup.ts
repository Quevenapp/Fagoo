import { all } from "./db";
import { type Conversation, type Env, requireValue, now } from "./types";
import { enqueue } from "./service";

export function protocolNumber(value: string) {
  return String(value || "")
    .match(/\bWA-[A-Z0-9]+-[A-Z0-9]{4}\b/i)?.[0]
    .toUpperCase();
}

// Only provider-authenticated identities may join conversations. A phone supplied
// by an API application is not evidence that the caller owns that WhatsApp number.
function verifiedPhone(c: Conversation) {
  if (
    c.chat_type === "group" ||
    !c.connection_id ||
    c.external_namespace !== `channel:${c.connection_id}`
  )
    return null;
  const value = String(c.phone || "").replace(/[+ ()-]/g, "");
  return /^\d{7,15}$/.test(value) ? value : null;
}

export async function lookupProtocols(
  env: Env,
  c: Conversation,
  number?: string,
) {
  requireValue(
    c.chat_type !== "group",
    "Consulte protocolos em uma conversa individual.",
  );
  requireValue(
    number === undefined || typeof number === "string",
    "Informe o número completo do protocolo.",
  );
  const query = number ? protocolNumber(number) : undefined;
  requireValue(
    !number || query === number.trim().toUpperCase(),
    "Informe o número completo do protocolo, como WA-ABC123-1A2B.",
  );
  const phone = verifiedPhone(c);
  // The same response is returned for a nonexistent number and somebody else's
  // number. Public updates only; internal notes and operator IDs are never sent.
  return all(
    env,
    `SELECT t.number,t.title,t.status,t.response_due_at,t.first_response_at,t.created,t.updated,
      (SELECT u.text FROM ticket_updates u WHERE u.ticket_id=t.id AND u.internal=0 ORDER BY u.created DESC,u.rowid DESC LIMIT 1) latest_update
     FROM tickets t JOIN conversations original ON original.id=t.conversation_id
     WHERE t.profile_id=? AND original.profile_id=? AND original.chat_type!='group'
       AND (original.id=? OR (? IS NOT NULL AND original.connection_id IS NOT NULL
         AND original.external_namespace='channel:'||original.connection_id
         AND replace(replace(replace(replace(replace(original.phone,'+',''),' ',''),'(',''),')',''),'-','')=?))
       AND (? IS NULL OR upper(t.number)=?)
     ORDER BY t.created DESC,t.id DESC LIMIT 10`,
    c.profile_id,
    c.profile_id,
    c.id,
    phone,
    phone,
    query || null,
    query || null,
  );
}

export function protocolSummary(tickets: any[], requested = false) {
  if (!tickets.length)
    return requested
      ? "Não encontramos esse protocolo vinculado ao seu atendimento ou telefone. Confira o número completo ou peça ajuda à equipe."
      : "Ainda não há protocolos vinculados ao seu atendimento ou telefone. Para falar com a equipe, envie ATENDENTE.";
  const states: Record<string, string> = {
    open: "Aberto",
    in_progress: "Em andamento",
    closed: "Concluído",
  };
  return (
    tickets
      .map((ticket) => {
        const due =
          ticket.response_due_at &&
          !ticket.first_response_at &&
          ticket.status !== "closed";
        return `${ticket.number} · ${states[ticket.status] || ticket.status}\n${String(ticket.title || "").slice(0, 300)}${due ? `\nPrazo de primeira resposta: ${new Date(ticket.response_due_at).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}${ticket.response_due_at < now() ? " (prazo vencido)" : ""}` : ""}${ticket.latest_update ? `\nÚltimo andamento: ${String(ticket.latest_update).slice(0, 250)}` : ""}`;
      })
      .join("\n\n") +
    "\n\nPara consultar um protocolo específico, envie seu número completo."
  );
}

export async function sendProtocolLookup(
  env: Env,
  c: Conversation,
  number: string | undefined,
  key: string,
  actor = "system",
) {
  const tickets = await lookupProtocols(env, c, number);
  const text = protocolSummary(tickets, !!number);
  // Split long histories into bounded messages without losing any returned row.
  const parts = text.match(/[\s\S]{1,3800}/g) || [text];
  const ids = [];
  for (const [index, part] of parts.entries())
    ids.push(
      await enqueue(
        env,
        c,
        actor,
        "text",
        { text: part, automation: "protocols" },
        `${key}:${index}`,
      ),
    );
  return {
    delivery_id: ids[0],
    delivery_ids: ids,
    status: "pending",
    data: tickets,
  };
}
