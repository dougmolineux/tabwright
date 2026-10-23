// Loads a fresh copy of extension/background.js against a fake `browser` (see fake-browser.js).
import { vi } from "vitest";
import { createFakeBrowser } from "./fake-browser.js";

export const SITE = "https://jobs.example.com";
export const SITE_URL = `${SITE}/apply`;
export const SITE_PATTERN = "https://jobs.example.com/*";

/** Lets timers and promise chains run until `cond()` is truthy (fake timers advance in 10 ms steps). */
export async function until(cond, ms = 5000) {
  for (let t = 0; t <= ms; t += 10) {
    if (await cond()) return;
    await vi.advanceTimersByTimeAsync(10);
  }
  throw new Error("condition not met");
}

export const settle = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

/**
 * Boots the background script. By default there is one allowed, active tab (id 1) on SITE_URL and the
 * extension is connected to the fake host. Pass `connect: false` to stay disconnected, or `browser`
 * to reuse a fake (e.g. to simulate the background restarting with the same storage).
 */
export async function boot({ connect = true, browser, storage, ...opts } = {}) {
  const b =
    browser ??
    createFakeBrowser({
      tabs: [{ id: 1, url: SITE_URL, active: true, title: "Apply" }],
      granted: [SITE_PATTERN],
      ...opts,
    });
  if (storage?.local) await b.storage.local.set(storage.local);
  if (storage?.session) await b.storage.session.set(storage.session);
  globalThis.browser = b;
  vi.resetModules();
  await import("../../extension/background.js");
  await settle();
  if (connect) {
    await b.ui({ type: "connect" });
    await until(async () => (await b.ui({ type: "get_state" })).connected);
  }
  b.state = () => b.ui({ type: "get_state" });
  return b;
}

/** A promise you can settle from outside, for page handlers that should wait. */
export function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}
