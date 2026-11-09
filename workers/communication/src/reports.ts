import { all } from "./db";
import { access } from "./security";
import { type Actor, type Env, requireValue, ApiError } from "./types";
export async function report(
  env: Env,
  actor: Actor,
  profile: string,
  query: URLSearchParams,
) {
  access(actor, profile, "reports:read");
  const tables: Record<string, string> = {
    conversations: "conversations",
    tickets: "tickets",
    messages: "messages",
    deliveries: "outbox",
    surveys: "surveys",
    consents: "consents",
    runs: "bot_runs",
    knowledge: "documents",
  };
  const section = query.get("section") || "tickets",
    table = tables[section];
  requireValue(table, "Seção inválida.");
  const start = Date.parse(
      (query.get("start") || "1970-01-01") + "T00:00:00-03:00",
    ),
    end = Date.parse(
      (query.get("end") || "2999-01-01") + "T23:59:59.999-03:00",
    );
  requireValue(
    Number.isFinite(start) && Number.isFinite(end) && start <= end,
    "Período inválido.",
  );
  let filter = "",
    params: any[] = [profile, start, end];
  if (section === "runs") {
    filter +=
      " AND (json_extract(context,'$.internal_chat_id') IS NULL OR actor=?)";
    params.push(actor.id);
  }
  if (actor.kind === "app") {
    if (section === "runs") {
      access(actor, profile, "bots:invoke");
      filter += " AND actor=?";
      params.push(actor.id);
    }
    if (section === "messages" && !actor.scopes.includes("notes:read"))
      filter += " AND direction!='note'";
    if (section === "conversations") {
      filter +=
        " AND (external_namespace NOT LIKE 'app:%' OR external_namespace=?)";
      params.push("app:" + actor.id);
    } else if (
      ["tickets", "messages", "deliveries", "surveys", "consents"].includes(
        section,
      )
    ) {
      filter +=
        " AND conversation_id IN (SELECT id FROM conversations WHERE external_namespace NOT LIKE 'app:%' OR external_namespace=?)";
      params.push("app:" + actor.id);
    }
  }
  async function page(cursor: string, limit: number) {
    const rows = await all(
      env,
      `SELECT * FROM ${table} WHERE profile_id=? AND created BETWEEN ? AND ? ${filter} AND id>? ORDER BY id LIMIT ?`,
      ...params,
      cursor,
      limit,
    );
    return rows.map((r) => {
      delete r.input;
      delete r.context;
      delete r.request_body;
      delete r.payload;
      delete r.source_key;
      return r;
    });
  }
  if (query.get("format") === "jsonl") {
    let cursor = "",
      finished = false;
    const encoder = new TextEncoder();
    return new Response(
      new ReadableStream({
        async pull(controller) {
          if (finished) {
            controller.close();
            return;
          }
          try {
            const rows = await page(cursor, 100);
            if (rows.length) {
              cursor = rows.at(-1).id;
              controller.enqueue(
                encoder.encode(
                  rows.map((r) => JSON.stringify(r)).join("\n") + "\n",
                ),
              );
            }
            if (rows.length < 100) finished = true;
          } catch (e) {
            controller.error(e);
          }
        },
      }),
      {
        headers: {
          "Content-Type": "application/x-ndjson",
          "Content-Disposition": `attachment; filename="wabotia-${section}.jsonl"`,
          "Cache-Control": "no-store",
        },
      },
    );
  }
  const limit = Math.min(100, Math.max(1, Number(query.get("limit")) || 100)),
    rows = await page(query.get("cursor") || "", limit + 1);
  const more = rows.length > limit;
  rows.splice(limit);
  return Response.json({
    section,
    data: rows,
    count: rows.length,
    next_cursor: more ? rows.at(-1).id : null,
  });
}
