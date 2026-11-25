import { expect, test } from "bun:test";

import { event, frame, harness } from "./slack-socket-harness.ts";

test("a disconnect envelope reopens the socket at once; the second hello is a reconnect, not a second READY", async () => {
  const h = harness();
  const first = await h.socket(1);
  frame(first, { type: "hello" });
  frame(first, { type: "disconnect", envelope_id: "d1", reason: "refresh_requested" });
  expect(first.sent).toEqual([JSON.stringify({ envelope_id: "d1" })]);
  const second = await h.socket(2);
  expect(second.url).toBe("wss://fake/2");
  expect(first.closed).toBe(true);
  frame(second, { type: "hello" });
  expect(h.readies()).toBe(1);
  expect(h.slept).toEqual([]);
  expect(h.warned).toEqual(["slack socket disconnect (refresh_requested); reconnecting", "slack socket reconnected"]);
  await h.stop();
});

test("a dropped socket and failed opens back off, doubling, and a hello resets the backoff", async () => {
  const h = harness(2);
  const first = await h.socket(1);
  expect(h.slept).toEqual([1000, 2000]);
  frame(first, { type: "hello" });
  first.h.onClose();
  const second = await h.socket(2);
  expect(h.slept).toEqual([1000, 2000, 1000]);
  expect(second.url).toBe("wss://fake/4");
  expect(h.warned.at(-1)).toBe("slack socket closed; reconnecting in 1s");
  await h.stop();
});

test("a silence longer than idleMs reopens the socket at once and quietly; a frame re-arms the timer", async () => {
  const h = harness(0, { idleMs: 600_000 });
  const first = await h.socket(1);
  frame(first, { type: "hello" });
  expect(h.timers.filter((t) => t.live).map((t) => t.ms)).toEqual([600_000]);
  event(first, "e1", { type: "message", channel_type: "im", channel: "D1", user: "U_OWNER", ts: "1.1", text: "hi" });
  expect(h.timers.filter((t) => t.live)).toHaveLength(1);
  h.fireIdle();
  const second = await h.socket(2);
  expect(first.closed).toBe(true);
  expect(h.slept).toEqual([]);
  frame(second, { type: "hello" });
  expect(h.readies()).toBe(1);
  expect(h.warned).toEqual([]);
  await h.stop();
});

test("a socket that throws while opening backs off and retries instead of ending the listener", async () => {
  let throws = 1;
  const urls: string[] = [];
  const ready = Promise.withResolvers<void>();
  const h = harness(0, {
    open: (url, handlers) => {
      urls.push(url);
      if (throws-- > 0) throw new Error("bad url");
      queueMicrotask(() => handlers.onMessage(JSON.stringify({ type: "hello" })));
      return { send: () => {}, close: () => {} };
    },
    ready: () => ready.resolve(),
  });
  await ready.promise;
  expect(urls).toEqual(["wss://fake/1", "wss://fake/2"]);
  expect(h.slept).toEqual([1000]);
  expect(h.warned).toEqual(["slack socket open: bad url", "slack socket closed; reconnecting in 1s"]);
  await h.stop();
});
