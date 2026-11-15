// Draws a ReportDoc (content.ts) as a PDF with pdf-lib: text, tables, simple vector charts, and the farm outline
// on a satellite image. It draws only what the document says; it computes no facts of its own.
import { PDFDocument, type PDFFont, type PDFPage, rgb, StandardFonts } from "pdf-lib";
import type { Block, ReportDoc, Tone } from "./content";

const W = 612, H = 792, M = 48, CW = W - 2 * M, BOTTOM = M + 18; // US Letter, points
const MAP_W = CW, MAP_H = 280, IMG_SCALE = 2; // map drawn size; the image is fetched at 2x for print
const INK = rgb(0.13, 0.16, 0.15), MUTED = rgb(0.42, 0.45, 0.44), RULE = rgb(0.85, 0.87, 0.86), BRAND = rgb(0.12, 0.42, 0.27);
const STRIPE = rgb(0.96, 0.97, 0.96), WHITE = rgb(1, 1, 1);
const TONES: Record<Tone, ReturnType<typeof rgb>> = {
  good: rgb(0.2, 0.56, 0.33), warn: rgb(0.85, 0.62, 0.13), bad: rgb(0.78, 0.27, 0.22), blue: rgb(0.22, 0.47, 0.75),
  amber: rgb(0.9, 0.58, 0.15), accent: rgb(0.45, 0.36, 0.7), grey: rgb(0.6, 0.62, 0.61),
};

// ---------------------------------------------------------------- text the standard PDF font can draw

const PUNCTUATION: [RegExp, string][] = [
  [/[‘’‚′]/g, "'"], [/[“”„″]/g, '"'], [/[–—−]/g, "-"], [/…/g, "..."],
  [/≥/g, ">="], [/≤/g, "<="], [/→/g, "->"], [/[   \t\r\n]/g, " "],
];
const WIN_ANSI = /^[\x20-\x7E¡-ÿ€ŒœŠšŸŽžƒˆ˜†‡•‰‹›™]*$/;

/** The string in characters Helvetica (WinAnsi) can draw, or null if it needs another script. */
export function toWinAnsi(s: string): string | null {
  let t = s;
  for (const [re, to] of PUNCTUATION) t = t.replace(re, to);
  return WIN_ANSI.test(t) ? t : null;
}
const safe = (s: string) => toWinAnsi(s) ?? s.replace(/[^\x20-\x7E¡-ÿ]/g, "?");

// ---------------------------------------------------------------- satellite map of the farm

const R = 6378137; // Web Mercator sphere radius, m

/** Esri World Imagery export URL for the farm with a margin, and the projection from [lon, lat] to the image (0..1, from top-left). */
export function mapView(ring: [number, number][]) {
  const merc = ([lon, lat]: [number, number]) => [(R * lon * Math.PI) / 180, R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))];
  const pts = ring.map(merc);
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const latRad = ((ring.reduce((a, p) => a + p[1], 0) / ring.length) * Math.PI) / 180;
  const minSpan = 400 / Math.cos(latRad); // show at least ~400 m of ground
  let w = Math.max(Math.max(...xs) - Math.min(...xs), minSpan) * 1.5;
  let h = Math.max(Math.max(...ys) - Math.min(...ys), minSpan) * 1.5;
  if (w / h < MAP_W / MAP_H) w = (h * MAP_W) / MAP_H; else h = (w * MAP_H) / MAP_W;
  const cx = (Math.max(...xs) + Math.min(...xs)) / 2, cy = (Math.max(...ys) + Math.min(...ys)) / 2;
  const box = [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2];
  return {
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export" +
      `?bbox=${box.map((v) => v.toFixed(2)).join(",")}&bboxSR=3857&imageSR=3857&size=${MAP_W * IMG_SCALE},${MAP_H * IMG_SCALE}&format=jpg&f=image`,
    toUnit: (p: [number, number]): [number, number] => { const [x, y] = merc(p); return [(x - box[0]) / w, (box[3] - y) / h]; },
    metersAcross: w * Math.cos(latRad),
  };
}

// ---------------------------------------------------------------- layout

class Writer {
  pages: PDFPage[] = [];
  page!: PDFPage;
  y = 0;
  constructor(private doc: PDFDocument, readonly font: PDFFont, readonly bold: PDFFont) { this.newPage(); }

  newPage() {
    this.page = this.doc.addPage([W, H]);
    this.pages.push(this.page);
    this.y = H - M;
  }
  ensure(h: number) { if (this.y - h < BOTTOM) this.newPage(); }
  text(s: string, x: number, y: number, size: number, opts: { font?: PDFFont; color?: ReturnType<typeof rgb> } = {}) {
    this.page.drawText(safe(s), { x, y, size, font: opts.font ?? this.font, color: opts.color ?? INK });
  }
  width(s: string, size: number, font = this.font) { return font.widthOfTextAtSize(safe(s), size); }

  /** Greedy word wrap; words longer than the line are cut. */
  wrap(s: string, size: number, maxW: number, font = this.font): string[] {
    const lines: string[] = [];
    let line = "";
    for (let word of safe(s).split(/\s+/).filter(Boolean)) {
      while (this.width(word, size, font) > maxW && word.length > 1) {
        let cut = word.length - 1;
        while (cut > 1 && this.width(word.slice(0, cut), size, font) > maxW) cut--;
        if (line) lines.push(line), (line = "");
        lines.push(word.slice(0, cut));
        word = word.slice(cut);
      }
      const next = line ? `${line} ${word}` : word;
      if (this.width(next, size, font) <= maxW) line = next;
      else { if (line) lines.push(line); line = word; }
    }
    if (line) lines.push(line);
    return lines.length ? lines : [""];
  }
  /** One line, shortened with "..." to fit. */
  fit(s: string, size: number, maxW: number, font = this.font): string {
    let t = safe(s);
    if (this.width(t, size, font) <= maxW) return t;
    while (t.length > 1 && this.width(`${t}...`, size, font) > maxW) t = t.slice(0, -1);
    return `${t}...`;
  }
}

// ---------------------------------------------------------------- blocks

function title(w: Writer, b: Extract<Block, { kind: "title" }>) {
  w.page.drawRectangle({ x: 0, y: H - 78, width: W, height: 78, color: BRAND });
  w.text(b.text, M, H - 44, 24, { font: w.bold, color: WHITE });
  w.text(w.fit(b.sub, 11, CW), M, H - 63, 11, { color: WHITE });
  w.y = H - 78 - 18;
}

function heading(w: Writer, text: string) {
  w.ensure(150); // keep a heading with the start of its section (a chart title and a few rows)
  w.y -= 12;
  for (const line of w.wrap(text, 14, CW, w.bold)) { w.text(line, M, w.y - 14, 14, { font: w.bold, color: BRAND }); w.y -= 18; }
  w.page.drawLine({ start: { x: M, y: w.y }, end: { x: M + CW, y: w.y }, thickness: 0.8, color: BRAND });
  w.y -= 10;
}

function paragraph(w: Writer, text: string) {
  for (const line of w.wrap(text, 10, CW)) {
    w.ensure(14);
    w.text(line, M, w.y - 10, 10);
    w.y -= 13.5;
  }
  w.y -= 5;
}

function facts(w: Writer, rows: [string, string][]) {
  const lw = CW * 0.28;
  for (const [k, v] of rows) {
    const kl = w.wrap(k, 9.5, lw - 8, w.bold), vl = w.wrap(v, 9.5, CW - lw);
    const h = Math.max(kl.length, vl.length) * 12.5 + 5;
    w.ensure(h);
    kl.forEach((l, i) => w.text(l, M, w.y - 10 - i * 12.5, 9.5, { font: w.bold }));
    vl.forEach((l, i) => w.text(l, M + lw, w.y - 10 - i * 12.5, 9.5));
    w.y -= h;
    w.page.drawLine({ start: { x: M, y: w.y + 2 }, end: { x: M + CW, y: w.y + 2 }, thickness: 0.4, color: RULE });
  }
  w.y -= 6;
}

function table(w: Writer, b: Extract<Block, { kind: "table" }>) {
  const size = 8.5, lh = 11, pad = 4;
  const cols = b.widths.map((s) => s * CW);
  const cells = (row: string[], font: PDFFont) => row.map((c, i) => w.wrap(c, size, cols[i] - 2 * pad, font));
  const drawRow = (lines: string[][], font: PDFFont, fill: ReturnType<typeof rgb> | null) => {
    const h = Math.max(...lines.map((l) => l.length)) * lh + 2 * pad;
    if (fill) w.page.drawRectangle({ x: M, y: w.y - h, width: CW, height: h, color: fill });
    let x = M;
    lines.forEach((l, i) => { l.forEach((t, j) => w.text(t, x + pad, w.y - pad - 8 - j * lh, size, { font })); x += cols[i]; });
    w.y -= h;
  };
  const header = cells(b.header, w.bold);
  const headerH = Math.max(...header.map((l) => l.length)) * lh + 2 * pad;
  w.ensure(headerH + 2 * lh + 2 * pad);
  drawRow(header, w.bold, RULE);
  b.rows.forEach((row, r) => {
    const lines = cells(row, w.font);
    const h = Math.max(...lines.map((l) => l.length)) * lh + 2 * pad;
    if (w.y - h < BOTTOM) { w.newPage(); drawRow(header, w.bold, RULE); } // repeat the header on a new page
    drawRow(lines, w.font, r % 2 ? STRIPE : null);
  });
  w.y -= 10;
}

function bars(w: Writer, b: Extract<Block, { kind: "bars" }>) {
  const rowH = 15, labelW = CW * 0.27, x0 = M + CW * 0.28, x1 = M + CW - 130;
  const max = b.max || Math.max(...b.items.map((i) => i.high ?? i.value), 1);
  const fmt = (v: number) => (b.unit === "$" ? `$${Math.round(v).toLocaleString("en-US")}` : String(Math.round(v)));
  w.ensure(20 + Math.min(b.items.length, 4) * rowH);
  for (const line of w.wrap(b.title, 10, CW, w.bold)) { w.text(line, M, w.y - 10, 10, { font: w.bold }); w.y -= 14; }
  w.y -= 4;
  for (const i of b.items) {
    w.ensure(rowH);
    const mid = w.y - rowH / 2;
    w.text(w.fit(i.label, 9, labelW), M, mid - 3, 9);
    w.page.drawRectangle({ x: x0, y: mid - 4.5, width: x1 - x0, height: 9, color: STRIPE });
    w.page.drawRectangle({ x: x0, y: mid - 4.5, width: Math.max(1, ((x1 - x0) * Math.min(i.value, max)) / max), height: 9, color: TONES[i.tone] });
    if (i.low !== undefined && i.high !== undefined) {
      const lx = x0 + ((x1 - x0) * i.low) / max, hx = x0 + ((x1 - x0) * Math.min(i.high, max)) / max;
      w.page.drawLine({ start: { x: lx, y: mid }, end: { x: hx, y: mid }, thickness: 1, color: INK });
      for (const x of [lx, hx]) w.page.drawLine({ start: { x, y: mid - 3.5 }, end: { x, y: mid + 3.5 }, thickness: 1, color: INK });
    }
    const value = fmt(i.value);
    w.text(value, x1 + 6, mid - 3, 9, { font: w.bold });
    if (i.note) w.text(w.fit(i.note, 8, 124 - w.width(value, 9, w.bold) - 10), x1 + 12 + w.width(value, 9, w.bold), mid - 3, 8, { color: MUTED });
    w.y -= rowH;
  }
  w.y -= 10;
}

/** A tick step of 1, 2 or 5 x 10^n giving about 4 gridlines. */
function niceStep(range: number): number {
  const raw = range / 4, mag = 10 ** Math.floor(Math.log10(raw || 1));
  return [1, 2, 5, 10].map((k) => k * mag).find((s) => s >= raw) ?? 10 * mag;
}

function monthly(w: Writer, b: Extract<Block, { kind: "monthly" }>) {
  const plotH = 100, x0 = M + 34, plotW = CW - 34;
  const values = b.series.flatMap((s) => s.values.filter((v): v is number => v !== null));
  const step = niceStep(Math.max(...values, 0) - Math.min(...values, 0));
  const lo = Math.min(0, Math.floor(Math.min(...values) / step) * step), hi = Math.max(step, Math.ceil(Math.max(...values) / step) * step);
  w.ensure(16 + plotH + 34);
  for (const line of w.wrap(b.title, 10, CW, w.bold)) { w.text(line, M, w.y - 10, 10, { font: w.bold }); w.y -= 14; }
  w.y -= 4;
  const top = w.y, yOf = (v: number) => top - plotH + ((v - lo) / (hi - lo)) * plotH;
  for (let v = lo; v <= hi + 1e-9; v += step) {
    const y = yOf(v);
    w.page.drawLine({ start: { x: x0, y }, end: { x: x0 + plotW, y }, thickness: v === 0 ? 0.8 : 0.4, color: v === 0 ? MUTED : RULE });
    const label = String(Math.round(v * 100) / 100);
    w.text(label, x0 - 4 - w.width(label, 7.5), y - 2.5, 7.5, { color: MUTED });
  }
  const groupW = plotW / 12, barW = (groupW * 0.72) / b.series.length;
  for (let m = 0; m < 12; m++) {
    b.series.forEach((s, k) => {
      const v = s.values[m];
      if (v === null || v === undefined) return;
      const x = x0 + m * groupW + groupW * 0.14 + k * barW;
      w.page.drawRectangle({ x, y: Math.min(yOf(0), yOf(v)), width: barW - 0.6, height: Math.max(0.5, Math.abs(yOf(v) - yOf(0))), color: TONES[s.tone] });
    });
    const ml = w.fit(b.months[m], 7.5, groupW);
    w.text(ml, x0 + m * groupW + (groupW - w.width(ml, 7.5)) / 2, top - plotH - 11, 7.5, { color: MUTED });
  }
  let lx = x0;
  const ly = top - plotH - 25;
  for (const s of b.series) {
    w.page.drawRectangle({ x: lx, y: ly, width: 8, height: 8, color: TONES[s.tone] });
    w.text(s.label, lx + 11, ly + 1, 8.5);
    lx += 24 + w.width(s.label, 8.5);
  }
  w.y = ly - 14;
}

function calendar(w: Writer, b: Extract<Block, { kind: "calendar" }>) {
  const rowH = 15, x0 = M + CW * 0.25, areaW = CW * 0.75, xOf = (d: number) => x0 + (d / 365) * areaW;
  w.ensure(16 + 14 + Math.min(b.rows.length, 3) * rowH);
  for (const line of w.wrap(b.title, 10, CW, w.bold)) { w.text(line, M, w.y - 10, 10, { font: w.bold }); w.y -= 14; }
  const starts = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334, 365];
  b.months.forEach((m, i) => {
    const ml = w.fit(m, 7.5, xOf(starts[i + 1]) - xOf(starts[i]));
    w.text(ml, xOf(starts[i]) + (xOf(starts[i + 1]) - xOf(starts[i]) - w.width(ml, 7.5)) / 2, w.y - 9, 7.5, { color: MUTED });
  });
  w.y -= 13;
  for (const r of b.rows) {
    w.ensure(rowH);
    const mid = w.y - rowH / 2;
    w.text(w.fit(r.label, 9, CW * 0.24), M, mid - 3, 9);
    for (let i = 0; i <= 12; i++) w.page.drawLine({ start: { x: xOf(starts[i]), y: w.y }, end: { x: xOf(starts[i]), y: w.y - rowH }, thickness: 0.4, color: RULE });
    const spans = r.end >= r.start ? [[r.start, r.end]] : [[r.start, 365], [0, r.end]]; // crops that grow over winter wrap around
    for (const [a, z] of spans) w.page.drawRectangle({ x: xOf(a), y: mid - 4.5, width: Math.max(2, xOf(z) - xOf(a)), height: 9, color: TONES[r.tone] });
    w.y -= rowH;
  }
  w.page.drawLine({ start: { x: x0, y: w.y }, end: { x: x0 + areaW, y: w.y }, thickness: 0.4, color: RULE });
  w.y -= 12;
}

async function map(w: Writer, pdf: PDFDocument, ring: [number, number][], caption: string, jpg: Uint8Array | null) {
  w.ensure(MAP_H + 30);
  const view = mapView(ring);
  const x = M, y = w.y - MAP_H;
  const image = jpg ? await pdf.embedJpg(jpg).catch(() => null) : null;
  if (image) w.page.drawImage(image, { x, y, width: MAP_W, height: MAP_H });
  else {
    w.page.drawRectangle({ x, y, width: MAP_W, height: MAP_H, color: STRIPE, borderColor: RULE, borderWidth: 0.8 });
    w.text("Satellite image not available", x + 10, y + 10, 8, { color: MUTED });
  }
  const path = ring.map((p, i) => { const [u, v] = view.toUnit(p); return `${i ? "L" : "M"} ${(u * MAP_W).toFixed(1)} ${(v * MAP_H).toFixed(1)}`; }).join(" ") + " Z";
  w.page.drawSvgPath(path, { x, y: y + MAP_H, color: rgb(1, 0.84, 0.1), opacity: 0.18, borderColor: rgb(1, 0.84, 0.1), borderWidth: 2.5 });
  // scale bar: a round length near a fifth of the map width
  const target = view.metersAcross / 5;
  const meters = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000].reduce((a, c) => (Math.abs(c - target) < Math.abs(a - target) ? c : a));
  const len = (meters / view.metersAcross) * MAP_W, label = meters >= 1000 ? `${meters / 1000} km` : `${meters} m`;
  w.page.drawRectangle({ x: x + 8, y: y + 8, width: len + 16 + w.width(label, 8), height: 16, color: WHITE, opacity: 0.85 });
  w.page.drawLine({ start: { x: x + 14, y: y + 14 }, end: { x: x + 14 + len, y: y + 14 }, thickness: 2, color: INK });
  w.text(label, x + 18 + len, y + 11.5, 8);
  w.y = y - 4;
  for (const line of w.wrap(caption, 9, CW)) { w.text(line, M, w.y - 9, 9, { color: MUTED }); w.y -= 12; }
  w.y -= 6;
}

/** The PDF bytes for a report; `mapJpg` is the satellite image from mapView(doc.ring).url, or null. */
export async function renderPdf(doc: ReportDoc, mapJpg: Uint8Array | null): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(safe(doc.ui.title));
  pdf.setCreator("Farm Helper (NASA Space Apps 2026)");
  const w = new Writer(pdf, await pdf.embedFont(StandardFonts.Helvetica), await pdf.embedFont(StandardFonts.HelveticaBold));
  for (const b of doc.blocks) {
    switch (b.kind) {
      case "title": title(w, b); break;
      case "heading": heading(w, b.text); break;
      case "paragraph": paragraph(w, b.text); break;
      case "map": await map(w, pdf, doc.ring, b.caption, mapJpg); break;
      case "facts": facts(w, b.rows); break;
      case "table": table(w, b); break;
      case "bars": bars(w, b); break;
      case "monthly": monthly(w, b); break;
      case "calendar": calendar(w, b); break;
    }
  }
  w.pages.forEach((p, i) => {
    p.drawText("Farm Helper", { x: M, y: M - 8, size: 8, font: w.font, color: MUTED });
    const n = `${i + 1} / ${w.pages.length}`;
    p.drawText(n, { x: W - M - w.font.widthOfTextAtSize(n, 8), y: M - 8, size: 8, font: w.font, color: MUTED });
  });
  return pdf.save();
}
