import express from "express";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import * as store from "./lib/store.mjs";
import { readPath, extractText, sourceSummary, READABLE } from "./lib/context.mjs";
import { digestContext, augmentAndValidate, proposeAgenda, analyze, debrief, MODEL } from "./lib/ai.mjs";
import { profileList } from "./lib/profiles.mjs";
import { scanForInjection } from "./lib/guard.mjs";
import * as ear from "./lib/ear.mjs";

const ROOT = import.meta.dirname;
const PORT = Number(process.env.PORT ?? 7400);
// Loopback only by default: this server holds medical and financial records and can
// read files on disk. HOST=0.0.0.0 opens it to the network, and then every request
// needs the access token printed at startup.
const HOST = process.env.HOST ?? "127.0.0.1";
const LOOPBACK = ["127.0.0.1", "::1", "localhost"].includes(HOST);
const TOKEN = LOOPBACK ? null : (process.env.SOTTO_TOKEN || process.env.SMARTASSIST_TOKEN || crypto.randomBytes(24).toString("base64url"));
const STAGES = new Set(["context", "agenda", "live", "debrief"]);
const ID = /^\d{8}-[a-z0-9]{4}$/;
const apiKey = readKey();
if (!apiKey) {
  console.error("No ANTHROPIC_API_KEY. Copy .env.example to .env and add your key.");
  process.exit(1);
}

const app = express();
app.disable("x-powered-by");

app.use((req, r, next) => {
  // DNS rebinding: a hostile site can point its own hostname at 127.0.0.1. Only
  // answer to names that are actually this machine (or any name, once a token is set).
  const host = String(req.headers.host ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  if (LOOPBACK && !["localhost", "127.0.0.1", "::1"].includes(host)) return r.status(421).end("bad host");

  // Cross-site requests: any other web page in the browser could otherwise POST here.
  const origin = req.headers.origin;
  if (origin && req.method !== "GET" && req.method !== "HEAD") {
    try {
      if (new URL(origin).host !== req.headers.host) return r.status(403).json({ error: "cross-origin request refused" });
    } catch {
      return r.status(403).json({ error: "bad origin" });
    }
  }

  if (TOKEN) {
    const cookie = /(?:^|;\s*)sa_token=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
    const given = req.query.t ?? cookie;
    const ok = typeof given === "string" && given.length === TOKEN.length &&
      crypto.timingSafeEqual(Buffer.from(given), Buffer.from(TOKEN));
    if (!ok) return r.status(401).end("Sotto: open the link with the access token printed at startup.");
    if (req.query.t) r.setHeader("Set-Cookie", `sa_token=${TOKEN}; HttpOnly; SameSite=Strict; Path=/`);
  }

  r.setHeader("Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
    "connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  r.setHeader("X-Content-Type-Options", "nosniff");
  r.setHeader("Referrer-Policy", "no-referrer");
  r.setHeader("Cache-Control", "no-store");
  next();
});

app.use(express.json({ limit: "64mb" }));
app.use(express.static(path.join(ROOT, "public")));

// Every call id becomes a directory name — reject anything that is not one of ours,
// so "..%2F.." can never reach the filesystem (load, save, or recursive delete).
app.param("id", (req, r, next, id) => (ID.test(id) ? next() : r.status(400).json({ error: "bad call id" })));

/* --------------------------------------------------------------- sessions */
// One in-memory live session per call: SSE subscribers and the analysis guard.
const live = new Map();
const sessionOf = (id) => {
  if (!live.has(id)) live.set(id, { clients: new Set(), analyzing: false, pendingForce: false, lastAt: 0 });
  return live.get(id);
};

/* ------------------------------------------------------------------ calls */

app.get("/api/profiles", (_q, r) => r.json(profileList()));
app.get("/api/calls", (_q, r) => r.json(store.list()));

app.post("/api/calls", (req, r) => {
  const { title, who, goal, profile, allowResearch } = req.body ?? {};
  r.json(store.createCall({ title: title || "Untitled call", who, goal, profile, allowResearch: allowResearch !== false }));
});

// Settings the user can change until the briefing is built.
app.patch("/api/calls/:id", (req, r) => {
  const call = store.load(req.params.id);
  if (!call) return r.status(404).json({ error: "no such call" });
  if (typeof req.body?.allowResearch === "boolean") call.allowResearch = req.body.allowResearch;
  store.save(call);
  r.json({ ok: true, allowResearch: call.allowResearch });
});

app.get("/api/calls/:id", (req, r) => {
  const c = store.load(req.params.id);
  return c ? r.json({ ...c, contextSources: publicSources(c) }) : r.status(404).json({ error: "no such call" });
});

app.delete("/api/calls/:id", (req, r) => {
  store.remove(req.params.id);
  r.json({ ok: true });
});

/* ---------------------------------------------------------------- context */

app.post("/api/calls/:id/context", (req, r) => {
  const call = store.load(req.params.id);
  if (!call) return r.status(404).json({ error: "no such call" });
  const { kind, label, text, path: target } = req.body ?? {};

  try {
    if (kind === "upload") {
      // One document per request, sent as base64 from the browser. The original is
      // kept in the call folder; only its text goes into the briefing.
      const { name, data } = req.body;
      if (!name || !data) return r.status(400).json({ error: "no file" });
      const saved = store.saveDocument(call.id, name, Buffer.from(data, "base64"));
      const extracted = extractText(saved);
      if (extracted === null) {
        store.removeDocument(call.id, saved);
        return r.status(400).json({ error: `${name}: can't read this format. Supported: ${READABLE.join(" ")}` });
      }
      if (!extracted.trim()) {
        store.removeDocument(call.id, saved);
        return r.status(400).json({ error: `${name}: no text found — if it's a scanned PDF, it needs OCR first` });
      }
      call.contextSources.push({ kind: "upload", label: String(name).slice(0, 200), file: saved, text: extracted, chars: extracted.length });
    } else if (kind === "path") {
      const files = readPath(target);
      if (!files.length) return r.status(400).json({ error: `Nothing readable at ${target}` });
      for (const f of files) {
        call.contextSources.push({ kind: "path", label: f.path, text: f.text, chars: f.chars });
      }
      if (files.skipped) console.log(`[context] skipped ${files.skipped} sensitive or non-file entries under ${target}`);
    } else {
      if (!text?.trim()) return r.status(400).json({ error: "empty" });
      call.contextSources.push({ kind: "paste", label: String(label || "pasted").slice(0, 200), text: String(text), chars: text.length });
    }
  } catch (e) {
    return r.status(400).json({ error: e.message });
  }

  // Surface anything that reads like instructions to an AI — the user should see it,
  // not just the model.
  for (const src of call.contextSources) if (!src.scanned) {
    src.scanned = true;
    const hits = scanForInjection(src.text);
    if (hits.length) src.warning = `Contains text that looks like instructions to an AI — it will be treated as data, not obeyed: “${hits[0]}”`;
  }
  store.save(call);
  r.json({ ok: true, sources: publicSources(call) });
});

// Never send document text or on-disk locations back to the browser — only what it shows.
const publicSources = (call) => call.contextSources.map(({ kind, label, chars, warning }) => ({ kind, label, chars, warning }));

app.delete("/api/calls/:id/context/:idx", (req, r) => {
  const call = store.load(req.params.id);
  if (!call) return r.status(404).json({ error: "no such call" });
  const idx = Number(req.params.idx);
  if (!Number.isInteger(idx) || idx < 0 || idx >= call.contextSources.length) return r.status(400).json({ error: "bad index" });
  const [gone] = call.contextSources.splice(idx, 1);
  if (gone?.kind === "upload") store.removeDocument(call.id, gone.file);
  store.save(call);
  r.json({ ok: true });
});

/* -------------------------------------------------- digest + agenda (step 2) */

const prepProgress = new Map();
app.get("/api/calls/:id/progress", (req, r) => r.json(prepProgress.get(req.params.id) ?? null));

app.post("/api/calls/:id/prepare", async (req, r) => {
  const call = store.load(req.params.id);
  if (!call) return r.status(404).json({ error: "no such call" });
  if (!call.contextSources.length) return r.status(400).json({ error: "Add some context first" });

  // Progress for the page: preparing takes a few minutes and should never look frozen.
  const step = (text) => { prepProgress.set(call.id, { text, at: Date.now() }); };
  try {
    step("Reading your documents…");
    const raw = sourceSummary(call.contextSources);
    const d = await digestContext({ apiKey, goal: call.goal, profile: call.profile, who: call.who, raw });
    call.contextDigest = d.digest;
    call.keyFacts = d.keyFacts;
    call.gaps = d.gaps;

    // Second pass: what the files don't say, and what in them doesn't hold up.
    step(call.allowResearch !== false ? "Researching what your documents don't say…" : "Checking your documents against each other…");
    const augment = await augmentAndValidate({
      apiKey, who: call.who, goal: call.goal, profile: call.profile,
      digest: d.digest, keyFacts: d.keyFacts,
      allowResearch: call.allowResearch !== false,
    });
    call.augment = augment;

    const priors = store
      .priorCalls(call.id, call.who)
      .map((p) => `### ${p.title} (${p.createdAt.slice(0, 10)})\n${p.debrief.slice(0, 6000)}`)
      .join("\n\n");

    step("Writing your questions…");
    const agenda = await proposeAgenda({
      apiKey,
      who: call.who,
      goal: call.goal,
      profile: call.profile,
      digest: d.digest,
      keyFacts: d.keyFacts,
      augment,
      priors,
    });
    // Hold the model to the limits the live screen is designed around.
    agenda.questions = agenda.questions.slice(0, 7);
    let musts = 0;
    for (const q of agenda.questions) if (q.mustAsk && ++musts > 3) q.mustAsk = false;
    agenda.rules = (agenda.rules ?? []).slice(0, 3);
    call.agenda = agenda;
    if (!call.title || call.title === "Untitled call") call.title = agenda.title;
    call.stage = "agenda";
    store.save(call);
    r.json(call);
  } catch (e) {
    console.error("[prepare]", e.stack ?? e.message);
    r.status(500).json({ error: e.message });
  } finally {
    prepProgress.delete(call.id);
  }
});

// The agenda is a proposal — the user edits it before it becomes the thing
// they are judged against.
app.put("/api/calls/:id/agenda", (req, r) => {
  const call = store.load(req.params.id);
  if (!call) return r.status(404).json({ error: "no such call" });
  const a = req.body?.agenda;
  if (!a || !Array.isArray(a.questions)) return r.status(400).json({ error: "bad agenda" });
  if (req.body.stage && !STAGES.has(req.body.stage)) return r.status(400).json({ error: "bad stage" });
  call.agenda = a;
  if (req.body.stage) call.stage = req.body.stage;
  store.save(call);
  r.json(call);
});

/* ------------------------------------------------------------ live (step 3) */

// The ear: the server runs listen.mjs so going live is one click, not a terminal.
app.get("/api/microphones", (_q, r) => r.json({ microphones: ear.microphones(), problems: ear.preflight() }));

app.get("/api/calls/:id/listen", (req, r) => r.json(ear.status(req.params.id)));

app.post("/api/calls/:id/listen", (req, r) => {
  const call = store.load(req.params.id);
  if (!call) return r.status(404).json({ error: "no such call" });
  if (req.body?.on === false) {
    ear.stop(call.id);
    return r.json({ on: false });
  }
  if (!call.agenda) return r.status(400).json({ error: "Build the topics first" });
  try {
    const st = ear.start({
      callId: call.id,
      device: req.body?.device,
      deviceName: String(req.body?.deviceName ?? "").slice(0, 80),
      port: PORT,
      token: TOKEN,
      emit,
    });
    if (call.stage === "agenda") { call.stage = "live"; store.save(call); }
    r.json(st);
  } catch (e) {
    r.status(400).json({ error: e.message });
  }
});

app.post("/api/calls/:id/line", (req, r) => {
  const call = store.load(req.params.id);
  if (!call) return r.status(404).json({ error: "no such call" });
  const text = String(req.body?.text ?? "").trim().slice(0, 5000);
  if (!text) return r.json({ ok: true });
  call.lines.push({ speaker: String(req.body?.speaker ?? "room").slice(0, 40), text, at: Date.now() });
  if (call.stage === "agenda") call.stage = "live";
  store.save(call);
  emit(call.id, { type: "line", text });
  void maybeAnalyze(call.id);
  r.json({ ok: true, lines: call.lines.length });
});

app.post("/api/calls/:id/analyze", (req, r) => {
  if (!store.load(req.params.id)) return r.status(404).json({ error: "no such call" });
  void maybeAnalyze(req.params.id, true);
  r.json({ ok: true });
});

// The user overrides the model: tick a question themselves, or clear the Now card.
app.post("/api/calls/:id/answered", (req, r) => {
  const call = store.load(req.params.id);
  if (!call) return r.status(404).json({ error: "no such call" });
  const id = String(req.body?.id ?? "");
  if (!call.agenda?.questions?.some((q) => q.id === id)) return r.status(400).json({ error: "no such question" });
  call.questionStatus = { ...(call.questionStatus ?? {}), [id]: { status: "answered", quote: "marked by you" } };
  if (call.now?.questionId === id) call.now = null;
  store.save(call);
  emit(call.id, { type: "question", id, status: "answered", quote: "marked by you" });
  if (!call.now) emit(call.id, { type: "now", now: null });
  r.json({ ok: true });
});

app.post("/api/calls/:id/now/dismiss", (req, r) => {
  const call = store.load(req.params.id);
  if (!call) return r.status(404).json({ error: "no such call" });
  call.now = null;
  store.save(call);
  emit(call.id, { type: "now", now: null });
  r.json({ ok: true });
});

app.get("/api/calls/:id/events", (req, r) => {
  r.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  r.write(": connected\n\n");
  if (!store.load(req.params.id)) return r.end();
  r.write(`data: ${JSON.stringify({ type: "ear", ...ear.status(req.params.id) })}\n\n`);
  const s = sessionOf(req.params.id);
  s.clients.add(r);
  req.on("close", () => s.clients.delete(r));
});

function emit(id, payload) {
  const frame = `data: ${JSON.stringify(payload)}\n\n`;
  for (const c of sessionOf(id).clients) c.write(frame);
}

/* ------------------------------------------------ repeat suppression + loop */

const STOP = new Set(["the","a","an","and","or","of","to","in","on","is","it","that","this","for","not","no","be","are","you","your","with","at","as","his","her"]);
const themeOf = (label) =>
  new Set(String(label).toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)));

/**
 * The same concern returns in fresh wording as a conversation goes on. Three
 * phrasings of one point is worse than one: the pane becomes a firehose, they stop
 * reading it, and that costs them the flag that actually mattered.
 */
function isRepeat(items, text) {
  const a = themeOf(text);
  if (!a.size) return false;
  return items.slice(-25).some((f) => {
    const b = themeOf(f.line ?? f.label ?? "");
    if (!b.size) return false;
    let shared = 0;
    for (const w of a) if (b.has(w)) shared++;
    return shared / Math.min(a.size, b.size) >= 0.5;
  });
}

/**
 * One pass of the live model → what the screen shows. The screen has room for ONE
 * thing, so the model's suggestion has to earn its place: it replaces what's showing
 * only if nothing is, if it matters more, or if the current one has had its moment.
 * Losers aren't lost — they go to the debrief.
 */
const NOW_MIN_MS = 30_000;
const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9$.%]/g, "");

function applyLive(id, call, result) {
  call.questionStatus ??= {};
  call.captured ??= [];
  call.notes ??= [];
  call.nowHistory ??= [];

  const known = new Set((call.agenda?.questions ?? []).map((q) => q.id));
  for (const q of result.questions ?? []) {
    if (!known.has(q.id)) continue;
    const cur = call.questionStatus[q.id]?.status;
    if (cur === "answered") continue; // a tick never gets taken back by the model
    if (cur === q.status) continue;
    call.questionStatus[q.id] = { status: q.status, quote: q.quote };
    emit(id, { type: "question", id: q.id, status: q.status, quote: q.quote });
  }

  for (const c of result.captured ?? []) {
    const dup = call.captured.some((x) => norm(x.value) === norm(c.value) || (norm(x.label) === norm(c.label) && norm(x.value) === norm(c.value)));
    if (dup || !c.value?.trim()) continue;
    const item = { label: c.label, value: c.value, quote: c.quote, at: Date.now() };
    call.captured.push(item);
    emit(id, { type: "captured", item });
  }

  for (const n of result.forDebrief ?? []) call.notes.push({ ...n, at: Date.now() });

  if (result.clearNow && call.now) {
    call.now = null;
    emit(id, { type: "now", now: null });
  }

  const cand = result.now;
  if (cand?.line?.trim()) {
    const answered = cand.questionId && call.questionStatus[cand.questionId]?.status === "answered";
    const stale = !call.now || Date.now() - call.now.at > NOW_MIN_MS;
    // A claim contradicting their own record outranks a suggestion at the same priority.
    const rank = (n) => n.priority * 2 + (n.kind === "caught" ? 1 : 0);
    const stronger = call.now && rank(cand) > rank(call.now);
    if (answered || isRepeat(call.nowHistory, cand.line)) {
      call.notes.push({ note: cand.line, quote: cand.evidence, at: Date.now() });
    } else if (stale || stronger) {
      call.now = { ...cand, at: Date.now() };
      call.nowHistory.push(call.now);
      emit(id, { type: "now", now: call.now });
    } else {
      call.notes.push({ note: cand.line, quote: cand.evidence, at: Date.now() });
    }
  }
  // If what's showing was about a question that just got answered, clear it.
  if (call.now?.questionId && call.questionStatus[call.now.questionId]?.status === "answered") {
    call.now = null;
    emit(id, { type: "now", now: null });
  }
}

const MIN_GAP_MS = 9000;
const MIN_NEW_WORDS = 25;

async function maybeAnalyze(id, force = false) {
  const s = sessionOf(id);
  if (s.analyzing) {
    if (force) s.pendingForce = true;
    return;
  }
  const call = store.load(id);
  if (!call?.agenda) return;

  const fresh = call.lines.slice(call.consumed);
  const words = fresh.reduce((n, l) => n + l.text.split(/\s+/).length, 0);
  if (!fresh.length) return;
  if (!force && (words < MIN_NEW_WORDS || Date.now() - s.lastAt < MIN_GAP_MS)) return;

  s.analyzing = true;
  const upTo = call.lines.length;
  try {
    // A little prior context, so a mid-sentence boundary doesn't lose the question.
    const from = Math.max(0, call.consumed - 4);
    const transcript = call.lines.slice(from).map((l) => `${(l.speaker || "room").toUpperCase()}: ${l.text}`).join("\n");
    const result = await analyze({ apiKey, call, transcript });

    const fresh2 = store.load(id); // re-read: lines may have arrived during the call
    fresh2.consumed = upTo;

    applyLive(id, fresh2, result);
    store.save(fresh2);
    s.lastAt = Date.now();
    console.log(`[analyze ${id}] now=${result.now ? `${result.now.kind}/${result.now.priority}` : "-"} q=${result.questions?.length ?? 0} cap=${result.captured?.length ?? 0} later=${result.forDebrief?.length ?? 0}`);
  } catch (e) {
    console.error(`[analyze ${id}]`, e.stack ?? e.message);
    emit(id, { type: "error", message: e.message });
  } finally {
    s.analyzing = false;
    if (s.pendingForce) {
      s.pendingForce = false;
      void maybeAnalyze(id, true);
    }
  }
}

// Lines alone can't drive this: if the other person pauses, or speech arrives while
// a pass is running, the tail of the conversation never gets looked at — and the end
// of a call is exactly where the unanswered questions pile up.
setInterval(() => {
  for (const id of live.keys()) void maybeAnalyze(id);
}, 5000);

/* --------------------------------------------------------- debrief (step 5) */

app.post("/api/calls/:id/debrief", async (req, r) => {
  const call = store.load(req.params.id);
  if (!call) return r.status(404).json({ error: "no such call" });
  ear.stop(call.id); // the call is over — close the microphone before anything else
  try {
    const priors = store
      .priorCalls(call.id, call.who)
      .map((p) => `### ${p.title} (${p.createdAt.slice(0, 10)})\n${p.debrief.slice(0, 6000)}`)
      .join("\n\n");
    const md = await debrief({ apiKey, call, priors });
    call.debrief = md;
    call.stage = "debrief";
    store.save(call);
    const file = store.writeArtifact(call.id, "debrief.md", md);
    r.json({ ok: true, file, markdown: md });
  } catch (e) {
    console.error("[debrief]", e.stack ?? e.message);
    r.status(500).json({ error: e.message });
  }
});

function readKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  try {
    const m = fs.readFileSync(path.join(ROOT, ".env"), "utf8").match(/^ANTHROPIC_API_KEY=(.+)$/m);
    return m ? m[1].trim() : "";
  } catch {
    return "";
  }
}

app.listen(PORT, HOST, () => {
  console.log(`Sotto — http://localhost:${PORT}`);
  if (TOKEN) console.log(`⚠ listening on ${HOST} — open from another device with: http://<this-machine>:${PORT}/?t=${TOKEN}`);
  console.log(`model: ${MODEL} · data: ${store.DATA}`);
});
