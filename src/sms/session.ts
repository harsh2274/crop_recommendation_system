// One Agent (Agents SDK, a Durable Object) per farmer: profile in Agent state, latest result.
// The webhook only queues work; `this.queue` runs turns durably, one at a time, in order, after
// Twilio has been answered (it needs a reply within 15 s, the analysis takes ~1 min).
//
// No-hallucination rule: every text is written by code (flow.ts, facts.ts) from the profile and the
// pipeline result. The model only reads the farmer's message into fields and translates code text;
// links are appended by code after translation.
import { Agent } from "agents";
import type { Env } from "../env";
import { buildReport, localizeReport, type ReportDoc } from "../report/content";
import type { PipelineOutput } from "../types";
import { translate } from "./ai";
import { factSnippets, marketMessages, reportMessages } from "./facts";
import { apply, emptyUnderstanding, nextStep, parseDirect, question, TEXT, understand, type Understanding } from "./flow";
import { MAP_UI_DEFAULTS, MAP_UI_KEYS, mergeUi, type MapPageConfig, type MapUi } from "./mappage";
import { checkBoundary, newProfile, toPipelineInput, type FarmerProfile } from "./profile";
import { sendSms } from "./twilio";

interface FarmerState { profile: FarmerProfile | null }
type TurnItem = { kind: "sms"; text: string } | { kind: "boundary"; areaHa: number };
interface MapLink { token: string; ui: MapUi; language?: string | null; createdAt: number } // language the page texts are in
interface PdfReport { token: string; createdAt: number; generatedAt: string; language: string | null; doc: ReportDoc } // language asked for

const LINK_TTL_MS = 72 * 3600_000;
const PDF_TTL_MS = 30 * 24 * 3600_000;
const SMS_GAP_MS = 1500; // between consecutive texts, so carriers deliver a series in order
const NO_RETRY = { retry: { maxAttempts: 1 } }; // a retried turn would text the farmer twice
const OPT_OUT = /^\s*(stop|stopall|unsubscribe|cancel|end|quit)\s*$/i; // Twilio opt-out keywords: Twilio handles them

type Status = FarmerProfile["analysisStatus"];

export class FarmerSession extends Agent<Env, FarmerState> {
  initialState: FarmerState = { profile: null };

  // ------------------------------------------------------------ called by the Worker

  async inbound(phone: string, text: string, messageSid: string, origin: string): Promise<void> {
    if (OPT_OUT.test(text)) return; // Twilio handles opt-out keywords itself; replying would fail anyway
    const seen = (await this.ctx.storage.get<string[]>("seen")) ?? [];
    if (seen.includes(messageSid)) return; // Twilio retried the webhook
    await this.ctx.storage.put("seen", [...seen.slice(-49), messageSid]);
    await this.ctx.storage.put("origin", origin);
    if (!this.state.profile) this.setState({ profile: newProfile(phone) });
    await this.queue("handleTurn", { kind: "sms", text } satisfies TurnItem, NO_RETRY);
  }

  async mapContext(token: string, ipCenter: [number, number] | null): Promise<MapPageConfig | null> {
    const valid = await this.validLink(token);
    const stored = this.state.profile;
    if (!valid || !stored) return null;
    const p: FarmerProfile = { ...newProfile(stored.phone), ...stored };
    const link = await this.inFarmerLanguage(valid, p); // page always in the language of the farmer's first message
    const gps = p.location?.source === "gps" ? ([p.location.lat, p.location.lon] as [number, number]) : null;
    return { ui: link.ui, center: gps ?? ipCenter ?? [20, 0], zoom: gps ? 16 : ipCenter ? 12 : 2, lang: "" };
  }

  async saveBoundary(token: string, ring: [number, number][], location: { lat: number; lon: number; accuracyM: number } | null) {
    const stored = this.state.profile;
    if (!stored || !(await this.validLink(token))) return { ok: false as const, error: "expired" };
    const check = checkBoundary(ring);
    if ("error" in check) return { ok: false as const, error: check.error };
    const p: FarmerProfile = { ...newProfile(stored.phone), ...stored }; // copy: never mutate cached state
    p.boundary = { ring, areaHa: check.areaHa, savedAt: new Date().toISOString() };
    if (location && Number.isFinite(location.lat) && Number.isFinite(location.lon)) {
      p.location = { lat: location.lat, lon: location.lon, accuracyM: Number(location.accuracyM) || null, source: "gps" };
    }
    if (p.analysisStatus === "done" || p.analysisStatus === "failed") p.analysisStatus = "stale";
    this.setState({ profile: p });
    // (The Worker's map handler starts the data prefetch in its own request, so nothing slow runs here.)
    await this.queue("handleTurn", { kind: "boundary", areaHa: check.areaHa } satisfies TurnItem, NO_RETRY);
    return { ok: true as const, areaHa: check.areaHa };
  }

  /** The translated report document behind a PDF link, or null if the link is unknown or expired. */
  async reportDoc(token: string): Promise<ReportDoc | null> {
    const pdf = await this.ctx.storage.get<PdfReport>("pdfReport");
    return pdf && pdf.token === token && Date.now() - pdf.createdAt < PDF_TTL_MS ? pdf.doc : null;
  }

  // ------------------------------------------------------------ queued work

  /** One turn (queue callback). Builds the reply from code-written texts only. Never throws. */
  async handleTurn(item: TurnItem): Promise<void> {
    const stored = this.state.profile!;
    const p: FarmerProfile = { ...newProfile(stored.phone), ...stored }; // fields added later get defaults
    try {
      if (item.kind === "boundary") {
        const next = nextStep(p);
        await this.reply(p, [TEXT.boundary(item.areaHa), question(next, p)], next === "map");
        return;
      }
      if (/^\s*reset\s*$/i.test(item.text)) return await this.reset(p);

      const result = (await this.ctx.storage.get<PipelineOutput>("result")) ?? null;
      const snippets = result ? factSnippets(result) : [];
      const step = nextStep(p);
      const firstContact = !p.language && p.crops.length === 0;
      const offered = p.pdfOffered; // only the turn right after the offer can accept it with YES
      p.pdfOffered = false;

      let u: Understanding = emptyUnderstanding();
      const direct = parseDirect(step, item.text);
      if (direct) u = { ...u, ...direct };
      else u = await understand(this.env, p, step, item.text, snippets).catch((e) => (console.error("understand failed", e), u));
      const changed = apply(p, step, u, item.text);
      // A turn only sets the status on purpose (new information, NEW, YES); otherwise the analysis owns it.
      let status: Status | null = changed && (p.analysisStatus === "done" || p.analysisStatus === "failed") ? "stale" : null;
      if (status) p.analysisStatus = status;

      const parts: (string | null)[] = firstContact ? [TEXT.intro] : [];
      let start = false;
      let withLink = false;
      let extra: string[] = []; // additional messages sent after the reply (market answer)
      let url: string | null = null; // PDF report link, appended by code
      const next = nextStep(p);
      if (p.analysisStatus === "running") {
        parts.push(u.intent === "resend_link" ? TEXT.redrawLater : TEXT.busy);
      } else if (u.intent === "resend_link") {
        // Link requested (to mark, fix or redraw the farm). The flow continues when the new shape arrives.
        parts.push(p.boundary ? TEXT.redraw : question("map", p));
        withLink = true;
      } else if (u.intent === "pdf_report" || (u.intent === "yes" && offered && next === "done" && result)) {
        // The complete report as a PDF (offered as the last report text): a link to a page that holds it.
        if (result) {
          parts.push(TEXT.pdfLink);
          url = await this.pdfLink(p, result);
        } else parts.push(TEXT.answerLater);
        if (next !== "done") parts.push(question(next, p));
      } else if (u.intent === "market") {
        // "How / where / when should I sell?": market texts written from result.market, sent as separate messages.
        const market = result ? marketMessages(result) : null;
        if (market) extra = market;
        else parts.push(result ? TEXT.noMarket : TEXT.answerLater);
        if (next !== "done") parts.push(question(next, p));
      } else if (u.intent === "question") {
        // Answers are pre-written snippets chosen by id; nothing else can be said.
        const answers = snippets.filter((s) => u.topics.includes(s.id)).map((s) => s.text);
        parts.push(...(result ? (answers.length ? answers : [TEXT.noInfo]) : [TEXT.answerLater]));
        if (next !== "done") parts.push(question(next, p));
      } else {
        if (u.intent === "report_outcome") parts.push(TEXT.outcomeSaved);
        if (u.intent === "new_report" && next === "done") p.analysisStatus = status = "stale";
        const now = nextStep(p);
        if (step === "confirm" && now === "confirm" && u.intent === "yes") {
          start = true;
          parts.push(TEXT.running);
        } else {
          if (!changed && u.intent === "other" && !firstContact) parts.push(TEXT.notUnderstood);
          parts.push(question(now, p) ?? TEXT.askMore);
        }
      }
      if (start) status = "running";
      this.commit(p, status);
      if (extra.length) for (const m of await translate(this.env, p.language, extra)) await this.text(p.phone, m);
      if (parts.some(Boolean) || withLink) await this.reply(p, parts, withLink || (nextStep(p) === "map" && !p.boundary), url);
      // The analysis takes ~1 min: detach it so the queue stays free for the farmer's next message.
      if (start) this.ctx.waitUntil(this.keepAliveWhile(() => this.analyze(p)));
    } catch (e) {
      console.error("turn failed", e);
      await this.text(p.phone, TEXT.turnFailed);
    }
  }

  private async analyze(p: FarmerProfile): Promise<void> {
    const shape = p.boundary?.savedAt;
    const sameFarmer = () => this.state.profile?.createdAt === p.createdAt; // false after RESET
    try {
      // Run the analysis in a separate Worker invocation (service binding to ourselves): its ~24 data downloads
      // get their own connection pool, so this agent's texts and model calls are never queued behind them.
      const res = await this.env.SELF.fetch("https://self/analyze?format=json", { method: "POST", body: JSON.stringify(toPipelineInput(p, this.name)) });
      if (!res.ok) throw new Error(`analysis HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const result = (await res.json()) as PipelineOutput;
      if (!sameFarmer()) return; // the farmer reset during the analysis: drop the old report
      await this.ctx.storage.put({ result, resultRing: p.boundary?.ring ?? [] }); // the shape this report is for (PDF map)
      await this.ctx.storage.delete("pdfReport");
      // If the farm was redrawn while we calculated, this report is for the old shape: offer a new one.
      const redrawn = this.state.profile?.boundary?.savedAt !== shape;
      this.setStatus(redrawn ? "stale" : "done");
      // The report texts, then the offer of the complete PDF report as the last text of the series.
      for (const m of await translate(this.env, p.language, [...reportMessages(result), TEXT.pdfOffer])) await this.text(p.phone, m);
      if (sameFarmer()) this.setState({ profile: { ...this.state.profile!, pdfOffered: true } });
      if (redrawn) await this.reply(p, [TEXT.shapeChanged], false);
    } catch (e) {
      console.error("analysis failed", e);
      if (!sameFarmer()) return;
      this.setStatus("failed");
      await this.reply(p, [TEXT.failed], false);
    }
  }

  /**
   * Save a turn's profile. saveBoundary() and the detached analysis can change state while a turn awaits the
   * model, so the boundary, location and analysis status always come from the latest stored state, unless the
   * turn deliberately changes the status (`status`).
   */
  private commit(p: FarmerProfile, status: Status | null): void {
    const latest = this.state.profile;
    if (!latest || latest.createdAt !== p.createdAt) return; // reset meanwhile
    let next: Status = status ?? latest.analysisStatus;
    if (latest.boundary?.savedAt !== p.boundary?.savedAt && (next === "done" || next === "failed")) next = "stale";
    this.setState({ profile: { ...p, boundary: latest.boundary, location: latest.location, analysisStatus: next } });
  }

  private setStatus(status: FarmerProfile["analysisStatus"]): void {
    this.setState({ profile: { ...this.state.profile!, analysisStatus: status } });
  }

  // ------------------------------------------------------------ helpers

  /**
   * Translate code-written parts into the farmer's language (one model call; the map-page texts ride
   * along in the same call when the link needs them), append the map link (code) if needed, send.
   */
  private async reply(p: FarmerProfile, parts: (string | null)[], withLink: boolean, extraUrl: string | null = null): Promise<void> {
    const english = parts.filter((x): x is string => !!x);
    const link = withLink ? await this.currentLink() : null;
    const needUi = !!link && link.language !== p.language;
    const localized = await translate(this.env, p.language, [...english, ...(needUi ? MAP_UI_KEYS.map((k) => MAP_UI_DEFAULTS[k]) : [])]);
    if (link && needUi) await this.saveLinkTexts(link, p, localized.slice(english.length));
    const url = (link ? `\n${await this.linkUrl(link)}` : "") + (extraUrl ? `\n${extraUrl}` : "");
    await this.text(p.phone, localized.slice(0, english.length).join(" ") + url);
  }

  private async reset(p: FarmerProfile): Promise<void> {
    const [bye] = await translate(this.env, p.language, [TEXT.reset]);
    await this.ctx.storage.delete(["result", "resultRing", "mapLink", "pdfReport"]);
    this.setState({ profile: newProfile(p.phone) });
    await this.text(p.phone, bye);
  }

  private sending: Promise<void> = Promise.resolve();
  private lastSent = 0;

  /** Send one text. Texts go out one at a time, SMS_GAP_MS apart (turns and the detached analysis share this). */
  private text(to: string, body: string): Promise<void> {
    const send = async () => {
      const wait = this.lastSent + SMS_GAP_MS - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      try {
        await sendSms(this.env, to, body);
      } catch (e) {
        console.error("sms send failed", e);
      } finally {
        this.lastSent = Date.now();
      }
    };
    this.sending = this.sending.then(send);
    return this.sending;
  }

  /** Link to the PDF report of `result`; the document is built and translated once per result and language. */
  private async pdfLink(p: FarmerProfile, result: PipelineOutput): Promise<string> {
    let pdf = await this.ctx.storage.get<PdfReport>("pdfReport");
    const fresh = pdf && pdf.generatedAt === result.generatedAt && pdf.language === p.language && Date.now() - pdf.createdAt < PDF_TTL_MS;
    if (!pdf || !fresh) {
      if (p.language && !/^english\b/i.test(p.language)) await this.reply(p, [TEXT.pdfPreparing], false); // translating takes a few seconds
      const ring = (await this.ctx.storage.get<[number, number][]>("resultRing")) ?? p.boundary?.ring ?? [];
      const doc = await localizeReport(this.env, p.language, buildReport(result, ring));
      pdf = { token: crypto.randomUUID().replace(/-/g, ""), createdAt: Date.now(), generatedAt: result.generatedAt, language: p.language, doc };
      await this.ctx.storage.put("pdfReport", pdf);
    }
    return `${await this.ctx.storage.get<string>("origin")}/report/${this.name}/${pdf.token}`;
  }

  /** The farmer's valid map link (a new one when missing or expired). */
  private async currentLink(): Promise<MapLink> {
    const link = await this.ctx.storage.get<MapLink>("mapLink");
    if (link && Date.now() - link.createdAt < LINK_TTL_MS) return link;
    const fresh: MapLink = { token: crypto.randomUUID().replace(/-/g, ""), ui: MAP_UI_DEFAULTS, language: null, createdAt: Date.now() };
    await this.ctx.storage.put("mapLink", fresh);
    return fresh;
  }

  private async linkUrl(link: MapLink): Promise<string> {
    const origin = await this.ctx.storage.get<string>("origin");
    return `${origin}/map/${this.name}/${link.token}`;
  }

  private async saveLinkTexts(link: MapLink, p: FarmerProfile, values: string[]): Promise<MapLink> {
    const updated = { ...link, ui: mergeUi(Object.fromEntries(MAP_UI_KEYS.map((k, i) => [k, values[i]])) as Partial<MapUi>), language: p.language };
    await this.ctx.storage.put("mapLink", updated);
    return updated;
  }

  /**
   * Page texts follow the farmer's current language (profile.language). If it changed after the link was sent,
   * the same link is re-translated when opened, so a link already sent keeps working.
   */
  private async inFarmerLanguage(link: MapLink, p: FarmerProfile): Promise<MapLink> {
    if (link.language === p.language) return link;
    return this.saveLinkTexts(link, p, await translate(this.env, p.language, MAP_UI_KEYS.map((k) => MAP_UI_DEFAULTS[k]))); // number-checked
  }

  private async validLink(token: string): Promise<MapLink | null> {
    const link = await this.ctx.storage.get<MapLink>("mapLink");
    return link && link.token === token && Date.now() - link.createdAt < LINK_TTL_MS ? link : null;
  }
}
