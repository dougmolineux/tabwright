// End-to-end (SPEC 14): real Firefox with the extension, the real native host and MCP server, against the
// local fixtures. Firefox runs in a throwaway profile via geckodriver.
//
// Needs Firefox (FIREFOX_BIN, default /Applications/Firefox.app). While it runs, the test temporarily writes
// the tabwright native messaging manifest (backing up and restoring any existing one).
//
//   npm run test:e2e
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Builder, By, Key, until, type WebDriver } from "selenium-webdriver";
import firefox from "selenium-webdriver/firefox.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error untyped JS module
import { startFixtureServer } from "../fixtures/serve.mjs";

const ROOT = path.resolve(__dirname, "../..");
const EXT_ID = "tabwright@dougmolineux.dev";
const EXT_UUID = "6d2a4f1e-0c7b-4b8a-9d55-1c1a2b3c4d5e";
const FIREFOX_BIN = process.env.FIREFOX_BIN ?? "/Applications/Firefox.app/Contents/MacOS/firefox";
const NMH_DIR =
  process.platform === "darwin"
    ? path.join(os.homedir(), "Library/Application Support/Mozilla/NativeMessagingHosts")
    : path.join(os.homedir(), ".mozilla/native-messaging-hosts");
const NMH_FILE = path.join(NMH_DIR, "tabwright.json");

let dir: string;
let fixtures: { port: number; close: () => Promise<void> };
let base: string;
let driver: WebDriver;
let client: Client;
let manifestBackup: string | null = null;

const ext = (p: string) => `moz-extension://${EXT_UUID}/${p}`;
const textOf = (r: any) => r.content.map((c: any) => c.text ?? "").join("\n");
const call = async (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args }, undefined, { timeout: 180_000 });
const ok = async (name: string, args: Record<string, unknown> = {}) => {
  const r = await call(name, args);
  if (r.isError) throw new Error(`${name} failed: ${textOf(r)}`);
  return textOf(r);
};
const refIn = (snapshot: string, re: RegExp) => {
  const line = snapshot.split("\n").find((l) => re.test(l));
  if (!line) throw new Error(`no line matching ${re} in:\n${snapshot}`);
  return line.match(/\[ref=(e\d+)\]/)![1];
};

async function grant(origins: string[]) {
  await driver.setContext(firefox.Context.CHROME);
  try {
    const res = await driver.executeAsyncScript(
      `const [id, origins, done] = arguments;
       const { ExtensionPermissions } = ChromeUtils.importESModule("resource://gre/modules/ExtensionPermissions.sys.mjs");
       const policy = WebExtensionPolicy.getByID(id);
       ExtensionPermissions.add(id, { permissions: [], origins }, policy.extension).then(() => done("ok"), (e) => done(String(e)));`,
      EXT_ID,
      origins,
    );
    expect(res).toBe("ok");
  } finally {
    await driver.setContext(firefox.Context.CONTENT);
  }
}

/** What Firefox does when the user clicks the toolbar button: grants activeTab for the selected tab. */
async function grantActiveTab() {
  await driver.setContext(firefox.Context.CHROME);
  try {
    await driver.executeScript(
      `const policy = WebExtensionPolicy.getByID(arguments[0]);
       const win = Services.wm.getMostRecentWindow("navigator:browser");
       policy.extension.tabManager.addActiveTabPermission(win.gBrowser.selectedTab);`,
      EXT_ID,
    );
  } finally {
    await driver.setContext(firefox.Context.CONTENT);
  }
}

/** Opens a URL in a new tab, focuses it in WebDriver, and selects it for the MCP tools. Returns the tab id. */
async function openTab(url: string): Promise<number> {
  await driver.switchTo().newWindow("tab");
  await driver.get(url);
  const current = await driver.getCurrentUrl();
  const tabs = JSON.parse((await ok("browser_list_tabs")).replace(/^<page_content[^>]*>\n|\n<\/page_content>$/g, ""));
  const tab = tabs.filter((t: any) => t.url === current || t.url === url).pop();
  expect(tab, `tab for ${url}`).toBeTruthy();
  await ok("browser_select_tab", { tabId: tab.id });
  return tab.id;
}

async function waitForPrompt() {
  await driver.wait(until.elementLocated(By.css("tabwright-approval")), 15_000);
  await driver.sleep(200);
}

const deny = () => driver.actions().sendKeys(Key.ENTER).perform(); // Deny has focus
const allow = () => driver.actions().keyDown(Key.SHIFT).sendKeys(Key.TAB).keyUp(Key.SHIFT).sendKeys(Key.ENTER).perform();

beforeAll(async () => {
  if (!fs.existsSync(FIREFOX_BIN)) throw new Error(`Firefox not found at ${FIREFOX_BIN}; set FIREFOX_BIN`);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-e2e-"));
  fs.mkdirSync(path.join(dir, "docs"));
  fs.writeFileSync(path.join(dir, "token"), crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ allowedUploadDirs: [path.join(dir, "docs")], approvalTimeoutSec: 60 }));
  fs.writeFileSync(path.join(dir, "docs", "resume.pdf"), "%PDF-1.4 fake resume");

  // Native host wrapper for this run.
  const wrapper = path.join(dir, "tabwright-host");
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${path.join(ROOT, "host/dist/index.js")}"\n`, { mode: 0o755 });
  fs.mkdirSync(NMH_DIR, { recursive: true });
  if (fs.existsSync(NMH_FILE)) manifestBackup = fs.readFileSync(NMH_FILE, "utf8");
  fs.writeFileSync(
    NMH_FILE,
    JSON.stringify({ name: "tabwright", description: "Bridge between Claude Code and Firefox (e2e)", path: wrapper, type: "stdio", allowed_extensions: [EXT_ID] }),
  );

  fixtures = await startFixtureServer(0);
  base = `http://127.0.0.1:${fixtures.port}`;

  // Firefox -> native host inherit this environment (via geckodriver).
  process.env.TABWRIGHT_DIR = dir;
  process.env.TABWRIGHT_CLAUDE_BIN = path.join(dir, "no-claude"); // instruction mode must not call the real Claude

  // @ts-expect-error untyped
  const { download } = await import("geckodriver");
  const gecko = await download();
  const opts = new firefox.Options()
    .setBinary(FIREFOX_BIN)
    .setPreference("extensions.webextensions.uuids", JSON.stringify({ [EXT_ID]: EXT_UUID }))
    .setPreference("extensions.webextOptionalPermissionPrompts", false)
    .setPreference("browser.shell.checkDefaultBrowser", false);
  if (process.env.E2E_HEADLESS) opts.addArguments("-headless");
  driver = await new Builder().forBrowser("firefox").setFirefoxOptions(opts).setFirefoxService(new firefox.ServiceBuilder(gecko).addArguments("--allow-system-access")).build();
  await driver.manage().window().setRect({ width: 1280, height: 900 });
  await (driver as any).installAddon(path.join(ROOT, "extension"), true);
  await grant(["http://127.0.0.1/*"]);

  // Connect from the popup, like a user would.
  await driver.get(ext("popup/popup.html"));
  await driver.findElement(By.id("connectBtn")).click();
  await driver.wait(until.elementTextIs(driver.findElement(By.id("status")), "connected"), 15_000);

  client = new Client({ name: "e2e", version: "0" });
  await client.connect(
    new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, "mcp-server/dist/index.js")], env: { ...(process.env as any), TABWRIGHT_DIR: dir }, stderr: "ignore" }),
  );
});

afterAll(async () => {
  await client?.close().catch(() => {});
  await driver?.quit().catch(() => {});
  await fixtures?.close().catch(() => {});
  if (manifestBackup !== null) fs.writeFileSync(NMH_FILE, manifestBackup);
  else fs.rmSync(NMH_FILE, { force: true });
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

describe("Firefox end to end", () => {
  it("reports status", async () => {
    const s = JSON.parse(await ok("browser_status"));
    expect(s.connected).toBe(true);
    expect(s.allowedSites).toContain("http://127.0.0.1");
  });

  it("returns E_SITE_NOT_ALLOWED on a site the user hasn't allowed", async () => {
    await openTab(`http://localhost:${fixtures.port}/plain-form.html`);
    const r = await call("browser_snapshot");
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/^E_SITE_NOT_ALLOWED: Claude isn't allowed on http:\/\/localhost/);
  });

  it("snapshots a Greenhouse-like application", async () => {
    await openTab(`${base}/greenhouse.html`);
    await driver.wait(until.elementLocated(By.id("first_name")), 10_000);
    const snap = await ok("browser_snapshot");
    expect(snap).toContain('- heading "Sr. Software Engineer - Backend" [level=1]');
    expect(snap).toMatch(/- form "Apply for this job"/);
    expect(snap).toMatch(/- textbox "First Name\*" \[ref=e\d+\] \[required\]/);
    expect(snap).toMatch(/- combobox "Country\*" \[ref=e\d+\]/);
    expect(snap).toMatch(/- file "Resume\/CV\*" \[ref=e\d+\] \[required\] \[accept=\.pdf,\.doc,\.docx,\.txt,\.rtf\]/);
    expect(snap).toMatch(/- button "Submit application" \[ref=e\d+\] \[consequential\]/);
  });

  it("fills React inputs, react-select and a file input; Deny leaves the form unsubmitted, Allow submits", async () => {
    const snap = await ok("browser_snapshot");
    const r = JSON.parse(
      (await ok("browser_fill_form", {
        fields: [
          { ref: refIn(snap, /"First Name\*"/), value: "Jane" },
          { ref: refIn(snap, /"Last Name\*"/), value: "Doe" },
          { ref: refIn(snap, /"Email\*"/), value: "jane@example.com" },
          { ref: refIn(snap, /combobox "Country\*"/), value: "United States" },
          { ref: refIn(snap, /combobox "Are you currently authorized/), value: "Yes" },
          { ref: refIn(snap, /"LinkedIn Profile\*"/), value: "https://linkedin.com/in/x" },
        ],
      })).replace(/^<page_content[^>]*>\n|\n<\/page_content>$/g, ""),
    );
    expect(r.ok).toBe(true);
    await ok("browser_upload", { ref: refIn(snap, /file "Resume\/CV\*"/), path: path.join(dir, "docs", "resume.pdf") });
    const state = JSON.parse(await driver.findElement(By.id("state")).getText());
    expect(state).toMatchObject({ first_name: "Jane", last_name: "Doe", email: "jane@example.com", country: { label: "United States" }, work_auth: { label: "Yes" }, resume: "resume.pdf" });

    const submit = refIn(snap, /"Submit application"/);
    let pending = call("browser_click", { ref: submit });
    await waitForPrompt();
    await deny();
    let res = await pending;
    expect(textOf(res)).toBe("E_APPROVAL_DENIED: User declined: Submit application");
    expect(await driver.findElements(By.xpath("//h1[text()='Thanks for applying']"))).toHaveLength(0);

    pending = call("browser_click", { ref: submit });
    await waitForPrompt();
    await allow();
    res = await pending;
    expect(res.isError).toBeFalsy();
    await driver.wait(until.elementLocated(By.xpath("//h1[text()='Thanks for applying']")), 5000);
  });

  it("types into a React-controlled input and React state updates", async () => {
    await openTab(`${base}/react-form.html`);
    await driver.wait(until.elementLocated(By.id("name")), 10_000);
    const snap = await ok("browser_snapshot");
    const typed = await ok("browser_type", { ref: refIn(snap, /"Your name"/), text: "Jane" });
    expect(typed).toContain('"value": "Jane"');
    expect(await driver.findElement(By.id("state-name")).getText()).toBe("Jane");
    await ok("browser_select", { ref: refIn(snap, /combobox "Favorite color"/), option: "Green" });
    expect(await driver.findElement(By.id("state-color")).getText()).toBe("Green");
  });

  it("uploads to an <input type=file> and to a drop zone", async () => {
    await openTab(`${base}/dropzone.html`);
    const snap = await ok("browser_snapshot");
    await ok("browser_upload", { ref: refIn(snap, /file "Attach a file"/), path: path.join(dir, "docs", "resume.pdf") });
    expect(await driver.findElement(By.id("input-result")).getText()).toBe("input: resume.pdf 20");
    await ok("browser_upload", { ref: refIn(snap, /"Drop your resume here"/), path: path.join(dir, "docs", "resume.pdf") });
    expect(await driver.findElement(By.id("drop-result")).getText()).toBe("dropped: resume.pdf 20");
  });

  it("asks for approval when Enter would submit a form", async () => {
    await openTab(`${base}/plain-form.html`);
    const snap = await ok("browser_snapshot");
    await ok("browser_type", { ref: refIn(snap, /"First name"/), text: "Doug" });
    const pending = call("browser_press_key", { key: "Enter" });
    await waitForPrompt();
    await deny();
    expect(textOf(await pending)).toMatch(/^E_APPROVAL_DENIED/);
    expect(await driver.getCurrentUrl()).toBe(`${base}/plain-form.html`);
  });

  it("returns E_STALE_REF for a ref from before a navigation", async () => {
    const snap = await ok("browser_snapshot");
    const old = refIn(snap, /"First name"/);
    const nav = JSON.parse((await ok("browser_click", { ref: refIn(snap, /link "Next page"/) })).replace(/^<page_content[^>]*>\n|\n<\/page_content>$/g, ""));
    expect(nav.navigated).toBe(true);
    expect(await driver.getCurrentUrl()).toBe(`${base}/plain-form.html?page=2`);
    const r = await call("browser_type", { ref: old, text: "x" });
    expect(textOf(r)).toMatch(/^E_STALE_REF/);
  });

  it("refuses and redacts password, one-time-code and card fields", async () => {
    await openTab(`${base}/password.html`);
    const snap = await ok("browser_snapshot");
    expect(snap).toMatch(/textbox "Password" \[ref=e\d+\] \[type=password\] value=\[redacted\]/);
    expect(snap).toMatch(/textbox "One-time code" \[ref=e\d+\] value=\[redacted\]/);
    expect(snap).toMatch(/textbox "Card number" \[ref=e\d+\] value=\[redacted\]/);
    for (const secret of ["hunter2", "123456", "4111111111111111"]) expect(snap).not.toContain(secret);
    const r = await call("browser_type", { ref: refIn(snap, /"Password"/), text: "x" });
    expect(textOf(r)).toMatch(/^E_REFUSED_SENSITIVE/);
  });

  it("inlines allowed frames and marks others not allowed", async () => {
    await openTab(`${base}/iframe.html`);
    await driver.sleep(500);
    let snap = await ok("browser_snapshot");
    expect(snap).toMatch(/- frame "Same origin" \(http:\/\/127\.0\.0\.1:\d+\)/);
    expect(snap).toMatch(/ {2,}- textbox "First name" \[ref=e\d+\]/);
    expect(snap).toMatch(/- frame "Cross origin" \(not allowed: http:\/\/localhost:\d+\)/);
    await grant(["http://localhost/*"]);
    snap = await ok("browser_snapshot");
    expect(snap).toMatch(/- frame "Cross origin" \(http:\/\/localhost:\d+\)/);
    expect(snap).toMatch(/textbox "Password" \[ref=e\d+\] \[type=password\] value=\[redacted\]/);
    // Acting inside the cross-origin frame works through its ref.
    await ok("browser_type", { ref: refIn(snap, /"Username"/), text: "doug" });
  });

  it("walks open shadow roots and reports closed ones as opaque", async () => {
    await openTab(`${base}/shadow.html`);
    const snap = await ok("browser_snapshot");
    expect(snap).toMatch(/- textbox "Search inside shadow" \[ref=e\d+\]/);
    expect(snap).toContain("- opaque closed-widget (closed shadow root)");
    expect(snap).not.toContain("Hidden inside closed root");
    await ok("browser_type", { ref: refIn(snap, /"Search inside shadow"/), text: "hello" });
    await ok("browser_click", { ref: refIn(snap, /button "Go"/) });
    expect(await driver.findElement(By.id("clicked")).getText()).toBe("open clicked: hello");
  });

  it("takes screenshots once the user has clicked the toolbar button on the tab (activeTab)", async () => {
    const denied: any = await call("browser_screenshot");
    expect(textOf(denied)).toMatch(/^E_SITE_NOT_ALLOWED: .*toolbar button/);
    await grantActiveTab();
    const full: any = await call("browser_screenshot");
    expect(full.isError, textOf(full)).toBeFalsy();
    expect(full.content[0].type).toBe("image");
    expect(full.content[0].data.startsWith("/9j/")).toBe(true); // JPEG
    const snap = await ok("browser_snapshot");
    const el: any = await call("browser_screenshot", { ref: refIn(snap, /button "Go"/) });
    expect(el.content[0].data.length).toBeLessThan(full.content[0].data.length);
  });

  it("fills the application in instruction mode with Claude unavailable (on-device or rules)", async () => {
    fs.writeFileSync(
      path.join(dir, "profile.json"),
      JSON.stringify({
        firstName: "Jane", lastName: "Doe", email: "jane@example.com", phone: "(555) 010-0199", country: "United States",
        links: { github: "https://github.com/janedoe", linkedin: "https://linkedin.com/in/janedoe" },
        resumePath: path.join(dir, "docs", "resume.pdf"),
        answers: { workAuthorizedNoSponsorship: null, salaryExpectation: null },
      }),
    );
    const tabId = await openTab(`${base}/greenhouse.html`);
    await driver.wait(until.elementLocated(By.id("first_name")), 10_000);
    const pageHandle = await driver.getWindowHandle();
    await driver.switchTo().newWindow("window");
    await driver.get(ext(`sidebar/sidebar.html?tab=${tabId}`));
    await driver.findElement(By.id("instruction")).sendKeys("Fill out this application with my details.");
    await driver.findElement(By.id("runBtn")).click();
    // Work authorization is null in the profile: the sidebar asks.
    const q = await driver.wait(until.elementIsVisible(driver.findElement(By.id("questionBox"))), 120_000);
    expect(await driver.findElement(By.id("questionText")).getText()).toMatch(/authorized to work/i);
    await driver.findElement(By.id("answerInput")).sendKeys("Yes", Key.ENTER);
    expect(q).toBeTruthy();
    await driver.wait(until.elementIsVisible(driver.findElement(By.id("resultBox"))), 180_000);
    const summary = await driver.findElement(By.id("resultBody")).getText();
    expect(await driver.findElement(By.id("engine")).getText()).toMatch(/On-device \(Apple\)|Rules only/);
    expect(summary).toMatch(/Gender/);
    expect(summary).toMatch(/Veteran Status/);
    await driver.switchTo().window(pageHandle);
    const state = JSON.parse(await driver.findElement(By.id("state")).getText());
    console.log("instruction-mode summary:\n" + summary + "\nstate: " + JSON.stringify(state));
    expect(state).toMatchObject({ first_name: "Jane", last_name: "Doe", email: "jane@example.com", country: { label: "United States" }, work_auth: { label: "Yes" }, resume: "resume.pdf", linkedin: "https://linkedin.com/in/janedoe" });
    expect(state.gender).toBeUndefined();
    expect(await driver.findElements(By.xpath("//h1[text()='Thanks for applying']"))).toHaveLength(0);
  });

  it("Stop cancels a pending browser_wait_for", async () => {
    await openTab(`${base}/plain-form.html`);
    const pending = call("browser_wait_for", { text: "this never appears", timeoutMs: 60_000 });
    await driver.sleep(500);
    await driver.switchTo().newWindow("tab");
    await driver.get(ext("popup/popup.html"));
    await driver.findElement(By.id("stopBtn")).click();
    const r = await pending;
    expect(textOf(r)).toMatch(/^E_STOPPED/);
  });
});
