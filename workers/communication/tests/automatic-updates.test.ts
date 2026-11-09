import { env } from "cloudflare:test";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { exec } from "../src/db";
import { secret, setSecret } from "../src/security";
import { type Actor, type Env } from "../src/types";
import { buildInfo } from "../src/build-info.generated";
import { RELEASE_ORIGIN } from "../src/release";
import {
  automaticWindow,
  automaticUpdateStatus,
  automaticUpdateTick,
  configureAutomaticUpdates,
  processUpdate,
  startUpdate,
  updateStatus,
} from "../src/updates";

const e: Env = {
  ...env,
  WABOTIA_ACCOUNT_ID: "d".repeat(32),
  WABOTIA_WORKER_NAME: "automatic-test",
  WABOTIA_INSTALLATION_ID: "automatic-test-installation",
  WABOTIA_UPDATE_TOKEN: "private-test-update-token",
};
const actor: Actor = {
  id: "automatic-admin",
  name: "Admin",
  kind: "user",
  role: "admin",
  profiles: [],
  scopes: [],
  bots: [],
  rate: 60,
  runLimit: 1,
};
const target = "a".repeat(40);
let at: number,
  index: any,
  calls: string[],
  packageFailure: "network" | "integrity",
  catalogFailure: boolean;
beforeEach(async () => {
  at = Date.UTC(2026, 10, 9, 6, 15); // 03:15 in São Paulo.
  vi.spyOn(Date, "now").mockImplementation(() => at);
  await exec(env, "DELETE FROM secrets WHERE id LIKE 'system:release-%'");
  await exec(env, "DELETE FROM system_update_locks");
  calls = [];
  packageFailure = "network";
  catalogFailure = false;
  index = {
    format: 1,
    version: "99.0.0",
    commit: target,
    package_sha256: "b".repeat(64),
    package_size: 3,
  };
  vi.stubGlobal("fetch", async (input: any, init: any = {}) => {
    const request = new Request(input, init);
    calls.push(request.url);
    expect(request.headers.get("Authorization")).toBeNull();
    expect(new URL(request.url).origin).toBe(RELEASE_ORIGIN);
    if (request.url.endsWith("latest.json")) {
      if (catalogFailure) throw new TypeError("network unavailable");
      return Response.json(index);
    }
    if (packageFailure === "network")
      throw new TypeError("network unavailable");
    return new Response("bad");
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const enable = () =>
  configureAutomaticUpdates(e, actor, {
    enabled: true,
    hour: 3,
    window_hours: 2,
  });

it("starts disabled and only an administrator on a direct authorized installation can enable", async () => {
  await automaticUpdateTick(e);
  expect(calls).toHaveLength(0);
  expect((await automaticUpdateStatus(e)).enabled).toBe(false);
  await expect(
    configureAutomaticUpdates(
      e,
      { ...actor, kind: "app", role: "service" },
      { enabled: true, hour: 3, window_hours: 2 },
    ),
  ).rejects.toMatchObject({ status: 403 });
  await expect(
    configureAutomaticUpdates(
      { ...e, WABOTIA_UPDATE_TOKEN: undefined },
      actor,
      { enabled: true, hour: 3, window_hours: 2 },
    ),
  ).rejects.toMatchObject({ status: 400 });
  await expect(
    configureAutomaticUpdates(e, actor, {
      enabled: true,
      hour: 24,
      window_hours: 2,
    }),
  ).rejects.toMatchObject({ status: 400 });
  expect((await enable())?.enabled).toBe(true);
  expect(JSON.stringify(await updateStatus(e))).not.toContain(
    e.WABOTIA_UPDATE_TOKEN,
  );
});

it("uses the São Paulo window, including windows spanning midnight", () => {
  expect(automaticWindow(Date.UTC(2026, 10, 9, 5, 59), 3, 2).open).toBe(false);
  expect(automaticWindow(Date.UTC(2026, 10, 9, 6), 3, 2).open).toBe(true);
  expect(automaticWindow(Date.UTC(2026, 10, 9, 8), 3, 2).open).toBe(false);
  expect(automaticWindow(Date.UTC(2026, 10, 10, 2, 30), 23, 2)).toEqual({
    open: true,
    key: "2026-11-09",
  });
  expect(automaticWindow(Date.UTC(2026, 10, 10, 3, 30), 23, 2)).toEqual({
    open: true,
    key: "2026-11-09",
  });
});

it("queues one newer release and concurrent ticks/manual starts cannot duplicate it", async () => {
  await enable();
  at -= 3600000;
  await automaticUpdateTick(e);
  expect(calls).toHaveLength(0);
  at += 3600000;
  await Promise.all([automaticUpdateTick(e), automaticUpdateTick(e)]);
  const first = await secret(e, "system:release-state");
  expect(first).toMatchObject({
    source: "automatic",
    status: "pending",
    attempt: 1,
    target,
  });
  await Promise.allSettled([
    automaticUpdateTick(e),
    startUpdate(e, actor, { commit: target }),
  ]);
  expect((await secret(e, "system:release-state")).id).toBe(first.id);
  expect(calls.filter((url) => url.endsWith("latest.json"))).toHaveLength(1);
});

it("checks at most once per successful window and never downgrades or replaces the same version", async () => {
  await enable();
  index = { ...index, commit: buildInfo.commit, version: buildInfo.version };
  await automaticUpdateTick(e);
  await automaticUpdateTick(e);
  expect(calls).toHaveLength(1);
  expect((await automaticUpdateStatus(e)).status).toBe("up_to_date");
  at += 86400000;
  index = { ...index, commit: target };
  await automaticUpdateTick(e);
  expect((await automaticUpdateStatus(e)).status).toBe(
    "release_requires_review",
  );
  expect((await secret(e, "system:release-state")).id).toBeUndefined();
  at += 86400000;
  index.version = "0.0.1";
  await automaticUpdateTick(e);
  expect((await secret(e, "system:release-state")).id).toBeUndefined();
});

it("backs off catalog failures and caps attempts within the window", async () => {
  await enable();
  catalogFailure = true;
  await automaticUpdateTick(e);
  await automaticUpdateTick(e);
  expect(calls).toHaveLength(1);
  at += 300000;
  await automaticUpdateTick(e);
  at += 600000;
  await automaticUpdateTick(e);
  at += 600000;
  await automaticUpdateTick(e);
  expect(calls).toHaveLength(3);
  expect(await automaticUpdateStatus(e)).toMatchObject({
    status: "check_failed",
    check_attempt: 3,
    check_retry_at: null,
  });
});

it("retries only transient pre-publication failures, reusing the job with a bounded backoff", async () => {
  await enable();
  await automaticUpdateTick(e);
  const first = await secret(e, "system:release-state");
  await processUpdate(e);
  expect(await secret(e, "system:release-state")).toMatchObject({
    status: "failed",
    retryable: true,
    attempt: 1,
  });
  await automaticUpdateTick(e);
  expect((await automaticUpdateStatus(e)).status).toBe("retry_wait");
  at += 300000;
  await automaticUpdateTick(e);
  expect(await secret(e, "system:release-state")).toMatchObject({
    id: first.id,
    status: "pending",
    attempt: 2,
  });
  await processUpdate(e);
  at += 600000;
  await automaticUpdateTick(e);
  await processUpdate(e);
  at += 1200000;
  await automaticUpdateTick(e);
  expect(await automaticUpdateStatus(e)).toMatchObject({
    status: "blocked",
    attempt: 3,
  });
  expect(calls.filter((url) => url.endsWith("package.json"))).toHaveLength(3);
});

it("does not retry an invalid package, migration failure, or uncertain publication", async () => {
  await enable();
  await automaticUpdateTick(e);
  packageFailure = "integrity";
  await processUpdate(e);
  await automaticUpdateTick(e);
  expect(await automaticUpdateStatus(e)).toMatchObject({ status: "blocked" });
  expect((await secret(e, "system:release-state")).retryable).toBe(false);
  const job = await secret(e, "system:release-state");
  await setSecret(e, "system:release-state", {
    ...job,
    status: "unknown",
    phase: "publish",
  });
  at += 86400000;
  const count = calls.length;
  await automaticUpdateTick(e);
  await processUpdate(e);
  expect(calls).toHaveLength(count);
  expect((await automaticUpdateStatus(e)).status).toBe("awaiting_confirmation");
  await setSecret(e, "system:release-state", {
    ...job,
    status: "failed",
    phase: "migrate",
    retryable: false,
  });
  await automaticUpdateTick(e);
  expect((await automaticUpdateStatus(e)).status).toBe("blocked");
});

it("disabling cancels jobs not started and preserves an already started update", async () => {
  await enable();
  await automaticUpdateTick(e);
  await configureAutomaticUpdates(e, actor, {
    enabled: false,
    hour: 3,
    window_hours: 2,
  });
  expect((await secret(e, "system:release-state")).status).toBe("cancelled");
  const count = calls.length;
  await automaticUpdateTick(e);
  await processUpdate(e);
  expect(calls).toHaveLength(count);
  await enable();
  await automaticUpdateTick(e);
  const job = await secret(e, "system:release-state");
  await setSecret(e, "system:release-state", {
    ...job,
    started_at: at,
    phase: "prepare",
  });
  await configureAutomaticUpdates(e, actor, {
    enabled: false,
    hour: 3,
    window_hours: 2,
  });
  expect((await secret(e, "system:release-state")).status).toBe("pending");
});

it("honors a live durable lease and recovers only an expired lease", async () => {
  await enable();
  await exec(
    env,
    "INSERT INTO system_update_locks(name,owner,expires) VALUES('release','other-worker',?)",
    at + 60000,
  );
  await automaticUpdateTick(e);
  expect(calls).toHaveLength(0);
  await expect(startUpdate(e, actor, { commit: target })).rejects.toMatchObject(
    { code: "update_busy" },
  );
  at += 60001;
  await automaticUpdateTick(e);
  expect((await secret(e, "system:release-state")).status).toBe("pending");
});
