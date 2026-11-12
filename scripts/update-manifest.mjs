// Adds a signed build to updates.json, the file Firefox polls (manifest update_url) for new versions.
//   node scripts/update-manifest.mjs <version> <xpi-url> <xpi-path>
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";

const [version, link, xpi] = process.argv.slice(2);
if (!version || !link || !xpi) {
  console.error("usage: update-manifest.mjs <version> <xpi-url> <xpi-path>");
  process.exit(1);
}
const manifest = JSON.parse(readFileSync("extension/manifest.json", "utf8"));
const id = manifest.browser_specific_settings.gecko.id;
const minVersion = manifest.browser_specific_settings.gecko.strict_min_version;
const hash = "sha256:" + createHash("sha256").update(readFileSync(xpi)).digest("hex");

const file = "updates.json";
const doc = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { addons: {} };
const entry = (doc.addons[id] ??= { updates: [] });
entry.updates = entry.updates.filter((u) => u.version !== version);
entry.updates.push({
  version,
  update_link: link,
  update_hash: hash,
  applications: { gecko: { strict_min_version: minVersion } },
});
writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");
console.log(`updates.json: ${id} ${version}`);
