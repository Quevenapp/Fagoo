# Fagoo 1.0.0: implementation contract

Status: development on `codex/fagoo-1.0.0`, based on the existing v0.3.1 repository. This document does not declare a stable release or authorize an incomplete production cutover.

## Product boundary

One company installation, one fiscal identity, operational units and Fagoo Auth users. The existing ERP remains. Atendimento, Filas e painéis and CRM become modules of the same web application. Android/iOS initially expose only panel mode and communication mode (internal one-to-one text chat and authorized WhatsApp conversations). Administration, ERP/CRM, queue operator controls, reports and live WebRTC remain on the web. Everything requires the cloud; hotspot and unrelated device networks are supported.

## Shared database and authorization

PostgreSQL schema `fagoo` owns `unit(id uuid, name, timezone, active, settings jsonb)`, `unit_member(unit_id, user_id, capabilities text[], team_ids text[])`, and `device(id uuid, unit_id, name, capabilities text[], active, token_hash text, settings jsonb)`. Membership in `erp_access.membership` remains canonical. Operational users have no implicit ERP access. Contacts remain `erp_catalog.record` plus `erp_catalog.contact`; do not duplicate or merge by phone/email.

`fagoo.require_unit(p_user_id uuid, p_device_id uuid, p_unit_id uuid, p_capability text)` checks active identity, unit and exact capability. A call has exactly one actor: user or device. Admin users may administer all active units; device capabilities are restricted to public panel operation. SQL RPC functions are executable by service_role only, with RLS and all direct table access revoked.

Capabilities: `units.manage`, `queue.read`, `queue.operate`, `queue.configure`, `panel.read`, `ticket.issue`, `print.execute`, `audio.execute`, `crm.read`, `crm.write`, `communication.read`, `communication.claim`, `communication.reply`, `communication.transfer`, `communication.configure`, `team.chat`.

`public.fagoo_context(p_user_id uuid)` returns `{user_id, role, units:[{id,name,timezone,capabilities,team_ids}]}`. `public.fagoo_device_auth(p_token_hash text)` returns an active device with its unit and capabilities. Device token hashing happens in the trusted API; plaintext is only shown when issued. Every module must recheck authorization in its RPC, not rely on this context response.

API modules export `...Route(path)` and `handle...({request,env,userId,deviceId,rpc,context})`. Root owns the ERP API index, authentication/access-window/MFA gates, origin validation and wiring. A module receives a server-verified actor and service RPC, never accepts user/device identity from untrusted request JSON. API paths: `/v1/fagoo/*` for shared setup, `/v1/queues/*`, `/v1/crm/*`, `/v1/communication/*`. Device auth uses a separate `FagooDevice <token>` Authorization scheme and is accepted only on explicit public panel/queue routes.

## Queue transaction and effects

Migration `202611090003_fagoo_queues.sql` follows identity migration `202611090002_fagoo_identity.sql`. Serialize commands on a per-unit runtime row, preserving priority, alternation and counter reservation. Persist mutation, sequence, event, effect jobs and idempotent receipt in one transaction. Increment revision in that transaction; never use a global sequence maximum as a committed cursor. A command carries a UUID command_id; reuse with different payload or actor fails.

Use HTTPS incremental foreground polling every two seconds. Reconnection fetches a snapshot and resolves uncertain receipts. No offline outbox. Audio starts only for fresh authorized events; old calls are not replayed. Printing has explicit destination/job ID, acknowledgement and uncertain state; no blind retry after unknown physical result. Technical device receipt storage may deduplicate effects but does not become an operational database.

## Communication

The inherited engine lives in `workers/communication`, retaining D1, R2 and Durable Objects initially. It is an internal Fagoo service through a Service Binding and delegated, validated user context. Managed mode disables independent login/setup/user administration/updating. The Fagoo API enforces session and permissions; the engine also enforces delegated actor scopes and conversation ownership for lists, messages, media, searches, events and push. Claimable queues expose minimal authorized previews. A successful human claim invalidates old AI work atomically. Internal bot actions intersect user and bot permissions. Preserve webhooks, signatures, durable ingestion, receipts, menus, protocols, consents, Telegram, QR, Hermes specialists, optional JEV and free-only queue notices.

## CRM

Migration `202611090004_fagoo_crm.sql` adds configurable funnels, opportunities and tasks referencing canonical contact/user/unit IDs. Initial stages: Novo, Contato, Proposta, Negociação, Ganho, Perdido. Winning an opportunity never writes financial, fiscal or stock records. Timelines must respect permissions of each source.

## Native mode isolation

Panel credentials never access people directories, internal chat, WhatsApp or personal push. Changing mode/user or signing out cancels private requests, clears credentials/caches and revokes notification registration. Exiting a protected panel requires online authorization. No operational offline fallback. PIN is validated online.

## Migration and release

Import old identities with reviewed mappings and retain source IDs, authorship by device, histories, protected configuration, media, protocol references, consent and receipts. Do not auto-merge contacts. Verify import before stopping old authority, then guarantee a single active consumer per channel. Keep compatibility URLs, webhooks and public consumer tracking online. Existing signed updater trust root, installer, backup and public repository remain authoritative. Add internal resources to backup/restore and coordinated updates without stopping durable inbound reception.

Stable publication requires clean install and v0.3.1 upgrade, real PostgreSQL concurrency, authorization and mode isolation, AI takeover cancellation, network-loss recovery without repeated effects, physical Android/iOS printing/audio/push, migration and restore rehearsals, and inherited web feature parity. Record evidence and unresolved acceptance items honestly; never mark unexecuted device checks passed.
