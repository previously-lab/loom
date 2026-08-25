import { afterEach, describe, expect, it, vi } from "vitest";
import { chat, chatJson } from "../src/core/generate.js";
import { z } from "zod";

const okBody = {
  choices: [{ message: { content: "{\"ok\": true}" } }],
  usage: { prompt_tokens: 10, completion_tokens: 5 },
};

function mockFetchSequence(steps: { status: number; body?: unknown }[]) {
  let i = 0;
  return vi.fn(async () => {
    const step = steps[Math.min(i++, steps.length - 1)];
    return new Response(JSON.stringify(step.body ?? okBody), {
      status: step.status,
      headers: { "Content-Type": "application/json" },
    });
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("chat retry", () => {
  it("retries on 5xx and eventually succeeds", async () => {
    vi.stubGlobal("fetch", mockFetchSequence([{ status: 500 }, { status: 200 }]));
    const res = await chat("k", [{ role: "user", content: "hi" }]);
    expect(res.content).toBe("{\"ok\": true}");
    expect(res.usage.promptTokens).toBe(10);
  });

  it("does NOT retry on 4xx", async () => {
    const spy = mockFetchSequence([{ status: 401, body: { error: "bad key" } }]);
    vi.stubGlobal("fetch", spy);
    await expect(chat("k", [{ role: "user", content: "hi" }])).rejects.toThrow(/401/);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("gives up after MAX_RETRIES on persistent 5xx", async () => {
    const spy = mockFetchSequence([{ status: 503 }]);
    vi.stubGlobal("fetch", spy);
    await expect(chat("k", [{ role: "user", content: "hi" }])).rejects.toThrow(/503/);
    expect(spy).toHaveBeenCalledTimes(4); // initial + 3 retries
  }, 20_000); // real exponential backoff sleeps: 1s + 2s + 4s
});

describe("chatJson", () => {
  it("parses strict JSON against the schema", async () => {
    vi.stubGlobal("fetch", mockFetchSequence([{ status: 200 }]));
    const { data } = await chatJson(
      "k",
      [{ role: "user", content: "hi" }],
      z.object({ ok: z.boolean() }),
    );
    expect(data.ok).toBe(true);
  });

  it("feeds the validation error back once before failing", async () => {
    const spy = mockFetchSequence([
      { status: 200, body: { choices: [{ message: { content: "not json" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } } },
      { status: 200 },
    ]);
    vi.stubGlobal("fetch", spy);
    const { data, usage } = await chatJson(
      "k",
      [{ role: "user", content: "hi" }],
      z.object({ ok: z.boolean() }),
    );
    expect(data.ok).toBe(true);
    expect(spy).toHaveBeenCalledTimes(2);
    // corrective retry includes the feedback round-trip tokens
    expect(usage.promptTokens).toBe(11);
  });
});
