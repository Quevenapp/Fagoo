import { DurableObject } from "cloudflare:workers";
import {processContactProjections} from './contact-projection';
import { type Env, type Actor, type Run, ApiError, now, json } from "./types";
import { one, all, exec } from "./db";
import { sha, seal, unseal, canonical } from "./security";
import { perform, inbound } from "./service";
import { finishDelivery } from "./delivery";
import { channelEvent } from "./whatsapp";
import { callWebhook, expireCalls } from "./calls";
import { expireUploads } from "./media";
import { transport } from "./transport";
import { routerLink } from "./number-router";
import { audit } from "./events";
import { processCloudflareJob } from "./cloudflare";
import { processUpdate, updatePending, automaticUpdateTick } from "./updates";
import { processPush } from "./push";
import {
  processInbox,
  processRun,
  deliver,
  deliverWebhook,
  importDocument,
} from "./engine";
export class Coordinator extends DurableObject<Env> {
  private profile = "";
  private busy = false;
  async fetch(request: Request) {
    const body = await request.json<any>();
    this.profile = body.profile;
    await this.ctx.storage.put("profile", this.profile);
    if (new URL(request.url).pathname === "/router-link")
      return this.ctx.blockConcurrencyWhile(async () => {
        try {
          return Response.json(
            await routerLink(this.env, this.profile, body.token),
          );
        } catch (error) {
          if (error instanceof ApiError)
            return Response.json(
              { error: { code: error.code, message: error.message } },
              { status: error.status },
            );
          throw error;
        }
      });
    if (new URL(request.url).pathname === "/command")
      return this.ctx.blockConcurrencyWhile(async () => {
        const actor: Actor = body.actor,
          scope = `${actor.id}:${this.profile}:${body.operation}`,
          fingerprint = await sha(canonical(body.data));
        const old = await one(
          this.env,
          "SELECT * FROM receipts WHERE scope=? AND key=?",
          scope,
          body.key,
        );
        if (old) {
          if (old.fingerprint !== fingerprint)
            return Response.json(
              {
                error: {
                  code: "idempotency_conflict",
                  message: "Esta chave já foi usada com outro conteúdo.",
                },
              },
              { status: 409 },
            );
          if (!old.response)
            return Response.json(
              {
                error: {
                  code: "operation_unknown",
                  message:
                    "A operação anterior não concluiu o recibo. Reconcilie antes de repetir.",
                },
              },
              { status: 409 },
            );
          return new Response(
            old.response.startsWith("sealed:")
              ? JSON.stringify(await unseal(this.env, old.response.slice(7)))
              : old.response,
            {
              status: old.status,
              headers: {
                "Content-Type": "application/json",
                "Idempotency-Replayed": "true",
              },
            },
          );
        }
        await exec(
          this.env,
          "INSERT INTO receipts(scope,key,fingerprint,created) VALUES(?,?,?,?)",
          scope,
          body.key,
          fingerprint,
          now(),
        );
        let status = 200,
          value: any;
        try {
          value = await perform(
            this.env,
            actor,
            this.profile,
            body.operation,
            body.data,
            body.key,
          );
          await audit(
            this.env,
            actor,
            this.profile,
            body.operation,
            value?.id || body.data.id || "",
            body.requestId,
          );
          if (["run.create", "inbound", "router.send"].includes(body.operation))
            status = 202;
        } catch (error) {
          if (!(error instanceof ApiError)) throw error;
          status = error.status;
          value = {
            error: {
              code: error.code,
              message: error.message,
              request_id: body.requestId,
            },
          };
        }
        await exec(
          this.env,
          "UPDATE receipts SET response=?,status=? WHERE scope=? AND key=?",
          "sealed:" + (await seal(this.env, value)),
          status,
          scope,
          body.key,
        );
        await this.schedule();
        return Response.json(value, { status });
      });
    if (new URL(request.url).pathname === "/transport")
      return this.ctx.blockConcurrencyWhile(async () =>
        Response.json(
          await transport(
            this.env,
            body.connectionId,
            body.operation,
            body.data,
          ),
        ),
      );
    if (new URL(request.url).pathname === "/channel-event") {
      const result = await this.ctx.blockConcurrencyWhile(async () => {
        const conn = await one(
          this.env,
          "SELECT * FROM connections WHERE id=? AND profile_id=?",
          body.connectionId,
          this.profile,
        );
        if (!conn)
          throw new ApiError(404, "not_found", "Conexão não encontrada.");
        return body.data.event === "call"
          ? callWebhook(this.env, conn, body.data)
          : channelEvent(this.env, conn, body.data);
      });
      await this.schedule();
      return Response.json(result);
    }
    if (new URL(request.url).pathname === "/inbound") {
      const result = await this.ctx.blockConcurrencyWhile(() =>
        inbound(
          this.env,
          this.profile,
          body.data,
          body.namespace,
          body.connectionId,
        ),
      );
      await this.schedule();
      return Response.json(result, { status: 202 });
    }
    await this.schedule();
    return Response.json({ scheduled: true });
  }
  private async schedule() {
    const scheduled = await this.ctx.storage.getAlarm();
    if (scheduled === null || scheduled > now() + 1000)
      await this.ctx.storage.setAlarm(now() + 1000);
  }
  async alarm() {
    if (this.busy) return;
    this.busy = true;
    this.profile ||= (await this.ctx.storage.get<string>("profile")) || "";
    try {
      if (this.profile === "_admin") {
        if(this.env.FAGOO_MANAGED === 'true') return;
        await automaticUpdateTick(this.env);
        await processUpdate(this.env);
        await processCloudflareJob(this.env);
        return;
      }
      if(this.env.FAGOO_MANAGED==='true' && (await one(this.env,'SELECT pause_outbound FROM fagoo_runtime WHERE id=1'))?.pause_outbound) {
        await this.ctx.storage.setAlarm(now()+5000);
        return;
      }
      await exec(
        this.env,
        "UPDATE outbox SET status='unknown',error='Processo interrompido durante envio; reconcilie antes de repetir.' WHERE profile_id=? AND status='sending' AND updated<?",
        this.profile,
        now() - 120000,
      );
      await exec(
        this.env,
        "UPDATE inbox SET status='pending' WHERE profile_id=? AND status='processing'",
        this.profile,
      );
      for (const row of await all(
        this.env,
        "SELECT * FROM outbox WHERE profile_id=? AND status='sent' AND completion_handled=0 LIMIT 20",
        this.profile,
      ))
        await finishDelivery(this.env, row, row.external_id || row.id);
      await exec(
        this.env,
        "UPDATE group_operations SET status='unknown',error='Conector interrompido; confira o grupo antes de reconciliar.' WHERE profile_id=? AND status='sending' AND updated<?",
        this.profile,
        now() - 120000,
      );
      await expireCalls(this.env, this.profile);
      await expireUploads(this.env, this.profile);
      await processInbox(this.env, this.profile);
      for (const run of await all<Run>(
        this.env,
        "SELECT * FROM bot_runs WHERE profile_id=? AND (status IN ('queued','starting','running','cancelling') OR (status='completed' AND completion_handled=0)) ORDER BY created LIMIT 5",
        this.profile,
      ))
        await processRun(this.env, run);
      for (const row of await all(
        this.env,
        "SELECT * FROM outbox o WHERE profile_id=? AND status='pending' AND NOT EXISTS (SELECT 1 FROM outbox p WHERE p.conversation_id=o.conversation_id AND (p.kind='team')=(o.kind='team') AND (p.created<o.created OR (p.created=o.created AND p.rowid<o.rowid)) AND p.status IN ('pending','sending','unknown')) ORDER BY created,rowid LIMIT 10",
        this.profile,
      ))
        await deliver(this.env, row);
      for (const row of await all(
        this.env,
        "SELECT d.* FROM webhook_deliveries d JOIN webhook_subscriptions s ON s.id=d.subscription_id WHERE s.profile_id=? AND d.status='pending' AND d.next_at<=? LIMIT 10",
        this.profile,
        now(),
      ))
        await deliverWebhook(this.env, row);
      const doc = await one(
        this.env,
        "SELECT * FROM documents WHERE profile_id=? AND status='pending' LIMIT 1",
        this.profile,
      );
      if (doc) await importDocument(this.env, doc);
      await processPush(this.env, this.profile);
      await processContactProjections(this.env,this.profile);
    } catch (error) {
      console.error(
        JSON.stringify({
          component: "coordinator",
          profile: this.profile,
          error: error instanceof ApiError ? error.code : "processing_error",
        }),
      );
    } finally {
      this.busy = false;
      if(this.env.FAGOO_MANAGED==='true' && this.profile!=='_admin') {
        const jobs=await one(this.env,"SELECT min(next_at) n FROM (SELECT next_at FROM fagoo_contact_jobs WHERE profile_id=? AND status='pending' UNION ALL SELECT next_at FROM fagoo_subscription_jobs WHERE profile_id=? AND status='pending')",this.profile,this.profile);
        if(jobs?.n){const alarm=await this.ctx.storage.getAlarm();const next=Math.max(now()+1000,jobs.n);if(alarm===null || alarm>next)await this.ctx.storage.setAlarm(next);}
      }
      const pending =
        this.profile === "_admin"
          ? await one(
              this.env,
              "SELECT count(*) n FROM cloudflare_jobs WHERE status IN ('pending','running')",
            )
          : await one(
              this.env,
              "SELECT (SELECT count(*) FROM inbox WHERE profile_id=? AND status='pending')+(SELECT count(*) FROM bot_runs WHERE profile_id=? AND (status IN ('queued','starting','running','cancelling') OR (status='completed' AND completion_handled=0)))+(SELECT count(*) FROM outbox WHERE profile_id=? AND status IN ('pending','sending'))+(SELECT count(*) FROM documents WHERE profile_id=? AND status='pending')+(SELECT count(*) FROM webhook_deliveries d JOIN webhook_subscriptions s ON s.id=d.subscription_id WHERE s.profile_id=? AND d.status='pending')+(SELECT count(*) FROM group_operations WHERE profile_id=? AND status IN ('pending','sending'))+(SELECT count(*) FROM events WHERE profile_id=? AND id>coalesce((SELECT last_event_id FROM push_cursors WHERE profile_id=?),0)) n",
              this.profile,
              this.profile,
              this.profile,
              this.profile,
              this.profile,
              this.profile,
              this.profile,
              this.profile,
            );
      if (
        pending?.n ||
        (this.profile !== "_admin" &&
          (await one(
            this.env,
            "SELECT id FROM calls WHERE profile_id=? AND status IN ('active','preaccepted','dialing','connecting','ringing') LIMIT 1",
            this.profile,
          ))) ||
        (this.profile === "_admin" && (await updatePending(this.env)))
      )
        await this.ctx.storage.setAlarm(now() + 5000);
    }
  }
}
