// Activity log viewer (SPEC 8.6).
const $ = (id) => document.getElementById(id);

async function load() {
  const { entries } = await browser.runtime.sendMessage({ type: "audit_get" });
  $("count").textContent = `${entries.length} entries`;
  const rows = $("rows");
  rows.replaceChildren();
  for (const e of [...entries].reverse()) {
    const tr = document.createElement("tr");
    const cells = [
      [new Date(e.time).toLocaleString(), "time"],
      [e.action ?? ""],
      [e.target ?? ""],
      [e.result ?? "", e.result === "ok" || e.result === "allowed" ? "ok" : "bad"],
      [e.approved === true ? "yes" : e.approved === false ? "no" : "—"],
      [e.detail ?? ""],
      [e.url ?? "", "url"],
    ];
    for (const [text, cls] of cells) {
      const td = document.createElement("td");
      td.textContent = text;
      if (cls) td.className = cls;
      tr.append(td);
    }
    rows.append(tr);
  }
}

$("refresh").addEventListener("click", load);
$("clear").addEventListener("click", async () => {
  if (!confirm("Clear the activity log?")) return;
  await browser.runtime.sendMessage({ type: "audit_clear" });
  load();
});
load();
