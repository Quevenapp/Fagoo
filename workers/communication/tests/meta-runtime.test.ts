import { env } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import { metaRequest } from "../src/meta";
import { setSecret } from "../src/security";
import { uid } from "../src/types";

afterEach(() => vi.restoreAllMocks());

async function connection() {
  const conn = { id: uid(), config: "{}" };
  await setSecret(env, `connection:${conn.id}`, { token: "test-meta-token" });
  return conn;
}

it("constructs Meta requests using options supported by the real Workers runtime", async () => {
  const conn = await connection();
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    // Most HTTP mocks skip native Request validation. Keep it here to catch
    // options that work in browsers/Node but fail before any network I/O in Workers.
    const request = new Request(input, init);
    expect(request.headers.get("Authorization")).toBe("Bearer test-meta-token");
    return Response.json({ data: [{ id: "123" }] });
  });
  await expect(metaRequest(env, conn, "123/phone_numbers")).resolves.toEqual({
    data: [{ id: "123" }],
  });
});

it("rejects a Meta redirect without sending credentials to another destination", async () => {
  const conn = await connection();
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      expect(request.redirect).toBe("manual");
      return new Response(null, {
        status: 302,
        headers: { Location: "https://example.com/" },
      });
    });
  await expect(
    metaRequest(env, conn, "123/phone_numbers"),
  ).rejects.toMatchObject({
    code: "meta_rejected",
  });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("keeps an ambiguous Meta failure unknown without repeating a write", async () => {
  const conn = await connection();
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("timeout"));
  await expect(
    metaRequest(env, conn, "123/messages", "POST", { text: "teste" }),
  ).rejects.toMatchObject({ code: "meta_unknown" });
  expect(fetch).toHaveBeenCalledTimes(1);
});
