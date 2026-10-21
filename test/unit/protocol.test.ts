import { describe, expect, it } from "vitest";
import {
  BridgeException,
  CHUNK_THRESHOLD,
  Reassembler,
  chunkMessage,
  request,
  response,
  validateMessage,
  type ChunkMessage,
} from "../../shared/protocol.ts";

describe("validateMessage", () => {
  it("accepts the shapes from SPEC 7.1", () => {
    expect(validateMessage({ v: 1, id: "r-42", type: "request", method: "click", params: { tabId: 18, ref: "e30" } })).toBeNull();
    expect(validateMessage({ v: 1, id: "r-42", type: "response", result: { ok: true } })).toBeNull();
    expect(validateMessage({ v: 1, id: "r-42", type: "response", error: { code: "E_APPROVAL_DENIED", message: "no" } })).toBeNull();
    expect(validateMessage({ v: 1, type: "event", name: "tab_closed", data: { tabId: 18 } })).toBeNull();
  });

  it("rejects malformed messages", () => {
    expect(validateMessage(null)).toMatch(/object/);
    expect(validateMessage({ v: 2, id: "a", type: "request", method: "x" })).toMatch(/version/);
    expect(validateMessage({ v: 1, type: "request", method: "x" })).toMatch(/id/);
    expect(validateMessage({ v: 1, id: "a", type: "request", method: "x", params: [] })).toMatch(/params/);
    expect(validateMessage({ v: 1, id: "a", type: "response", error: { code: "E_NOPE", message: "x" } })).toMatch(/error/);
    expect(validateMessage({ v: 1, id: "a", type: "chunk", seq: 3, total: 2, data: "" })).toMatch(/range/);
    expect(validateMessage({ v: 1, type: "bogus" })).toMatch(/unknown/);
  });
});

describe("chunking", () => {
  it("leaves small messages alone", () => {
    const msg = request("r-1", "status");
    expect(chunkMessage(msg)).toEqual([msg]);
  });

  it("splits and reassembles large messages, including non-ASCII", () => {
    const big = "é😀x".repeat(400_000); // ~3.2 MB of UTF-8
    const msg = response("r-43", { data: big });
    const parts = chunkMessage(msg) as ChunkMessage[];
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) {
      expect(p.type).toBe("chunk");
      expect(p.id).toBe("r-43");
      expect(JSON.stringify(p).length).toBeLessThan(CHUNK_THRESHOLD);
      expect(validateMessage(p)).toBeNull();
    }
    const r = new Reassembler();
    // Out of order, with a duplicate.
    const shuffled = [...parts].reverse();
    let out = null;
    for (const p of [shuffled[0], ...shuffled]) out = r.add(p) ?? out;
    expect(out).toEqual(msg);
    expect(r.size).toBe(0);
  });

  it("drops incomplete transfers after the TTL", () => {
    let now = 0;
    const r = new Reassembler(30_000, 20 * 1024 * 1024, () => now);
    r.add({ v: 1, type: "chunk", id: "a", seq: 0, total: 2, data: "AAAA" });
    expect(r.size).toBe(1);
    now = 31_000;
    r.sweep();
    expect(r.size).toBe(0);
  });

  it("enforces the 20 MB limit", () => {
    const r = new Reassembler(30_000, 1000);
    expect(() => r.add({ v: 1, type: "chunk", id: "big", seq: 0, total: 3, data: "A".repeat(2000) })).toThrow(BridgeException);
    expect(() => chunkMessage(response("x", { d: "a".repeat(21 * 1024 * 1024) }))).toThrow(/E_TOO_LARGE|limit/);
  });
});
