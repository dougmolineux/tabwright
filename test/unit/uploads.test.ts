import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, readUploadFile } from "../../shared/node.ts";

let tmp: string;
let allowed: string;
let outside: string;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cb-upload-"));
  allowed = path.join(tmp, "allowed");
  outside = path.join(tmp, "outside");
  fs.mkdirSync(allowed);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(allowed, "resume.pdf"), "%PDF-1.4 test");
  fs.writeFileSync(path.join(outside, "secret.txt"), "nope");
  fs.symlinkSync(path.join(outside, "secret.txt"), path.join(allowed, "link.txt"));
  fs.writeFileSync(path.join(allowed, "big.bin"), Buffer.alloc(2048));
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const cfg = () => ({ ...DEFAULT_CONFIG, allowedUploadDirs: [allowed], maxUploadBytes: 1024 });

describe("readUploadFile (SPEC 8.4)", () => {
  it("reads files inside an allowed directory", async () => {
    const f = await readUploadFile(path.join(allowed, "resume.pdf"), cfg());
    expect(f).toMatchObject({ fileName: "resume.pdf", mimeType: "application/pdf", size: 13 });
    expect(Buffer.from(f.base64, "base64").toString()).toBe("%PDF-1.4 test");
  });

  it("rejects files outside, including through symlinks and ..", async () => {
    await expect(readUploadFile(path.join(outside, "secret.txt"), cfg())).rejects.toMatchObject({ code: "E_FILE_NOT_ALLOWED" });
    await expect(readUploadFile(path.join(allowed, "link.txt"), cfg())).rejects.toMatchObject({ code: "E_FILE_NOT_ALLOWED" });
    await expect(readUploadFile(path.join(allowed, "..", "outside", "secret.txt"), cfg())).rejects.toMatchObject({ code: "E_FILE_NOT_ALLOWED" });
    await expect(readUploadFile(path.join(allowed, "missing.pdf"), cfg())).rejects.toMatchObject({ code: "E_FILE_NOT_ALLOWED" });
  });

  it("enforces the size limit", async () => {
    await expect(readUploadFile(path.join(allowed, "big.bin"), cfg())).rejects.toMatchObject({ code: "E_TOO_LARGE" });
  });
});
