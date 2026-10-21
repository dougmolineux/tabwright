// Static fixture server for e2e tests and manual testing. Bundles the React fixtures with esbuild.
//   node test/fixtures/serve.mjs [port]
import { build } from "esbuild";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };

export async function buildFixtures() {
  await build({
    entryPoints: [path.join(DIR, "src/apps.jsx")],
    outfile: path.join(DIR, "build/apps.js"),
    bundle: true,
    format: "iife",
    jsx: "automatic",
    minify: true,
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "warning",
  });
}

export async function startFixtureServer(port = 0) {
  await buildFixtures();
  const handler = (req, res) => {
    const url = new URL(req.url, "http://x");
    if (req.method === "POST") {
      // Forms post here; the page shows what arrived so tests can tell a submit happened.
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html><title>Submitted</title><h1>Application submitted</h1><pre id="body">${body.replace(/</g, "&lt;")}</pre>`);
      });
      return;
    }
    let file = path.normalize(path.join(DIR, url.pathname === "/" ? "index.html" : url.pathname));
    if (!file.startsWith(DIR)) {
      res.writeHead(403).end();
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404, { "content-type": "text/plain" }).end("not found");
        return;
      }
      res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" });
      res.end(data);
    });
  };
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  const actual = server.address().port;
  // "localhost" may resolve to ::1; answer there too so it works as a second origin for cross-origin frames.
  const v6 = http.createServer(handler);
  await new Promise((r) => v6.once("error", r).listen(actual, "::1", r));
  const close = () => Promise.all([new Promise((r) => server.close(r)), new Promise((r) => v6.close(() => r()))]);
  return { server, port: actual, close };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { port } = await startFixtureServer(Number(process.argv[2]) || 8765);
  console.log(`Fixtures at http://127.0.0.1:${port}/ (cross-origin frames use http://localhost:${port}/)`);
}
