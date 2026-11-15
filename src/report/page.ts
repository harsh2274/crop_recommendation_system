// The web page the farmer's PDF link opens: the PDF shown inline (where the browser can) with open and download
// buttons, since most phone browsers cannot show a PDF inside a page.
import type { ReportDoc } from "./content";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function renderReportPage(doc: ReportDoc | null, pdfPath: string): Response {
  const headers = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "x-robots-tag": "noindex" };
  if (!doc) {
    return new Response(page("Farm report", `<p class="msg">This link has expired. Reply PDF by text message to get a new one.</p>`), { status: 404, headers });
  }
  const t = doc.ui;
  const sub = doc.blocks.find((b) => b.kind === "title");
  const body = `
    <header><h1>${esc(t.title)}</h1>${sub && sub.kind === "title" ? `<p>${esc(sub.sub)}</p>` : ""}</header>
    <div class="actions">
      <a class="btn" href="${pdfPath}" target="_blank" rel="noopener">${esc(t.open)}</a>
      <a class="btn alt" href="${pdfPath}?download=1">${esc(t.download)}</a>
    </div>
    ${t.note ? `<p class="msg note">${esc(t.note)}</p>` : ""}
    <p class="msg">${esc(t.fallback)}</p>
    <object data="${pdfPath}" type="application/pdf" aria-label="${esc(t.title)}"></object>`;
  return new Response(page(t.title, body), { headers });
}

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><style>
  :root { --brand: #1f6b45; --ink: #222826; --muted: #6b7370; --bg: #f5f7f6; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 16px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; color: var(--ink); background: var(--bg); }
  header { background: var(--brand); color: #fff; padding: 20px 16px; }
  header h1 { margin: 0; font-size: 1.5rem; } header p { margin: 4px 0 0; opacity: .9; }
  .actions { display: flex; flex-wrap: wrap; gap: 12px; padding: 16px; }
  .btn { flex: 1 1 200px; text-align: center; padding: 14px 16px; border-radius: 10px; background: var(--brand); color: #fff; font-weight: 600; text-decoration: none; font-size: 1.05rem; }
  .btn.alt { background: #fff; color: var(--brand); border: 2px solid var(--brand); }
  .msg { margin: 0 16px 12px; color: var(--muted); font-size: .95rem; }
  .note { color: var(--ink); background: #fff7e0; border: 1px solid #f0d78a; border-radius: 8px; padding: 10px 12px; }
  object { display: block; width: calc(100% - 32px); height: 80vh; margin: 0 16px 24px; border: 1px solid #d9dedc; border-radius: 8px; background: #fff; }
</style></head><body>${body}</body></html>`;
}
