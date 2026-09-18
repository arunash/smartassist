import express from "express";
import fs from "node:fs";
import path from "node:path";
import * as store from "./lib/store.mjs";
import { readPath, sourceSummary } from "./lib/context.mjs";
import { digestContext, proposeAgenda, analyze, debrief, MODEL } from "./lib/ai.mjs";
import { profileList } from "./lib/profiles.mjs";

const ROOT = import.meta.dirname;
const PORT = Number(process.env.PORT ?? 7400);
const apiKey = readKey();
if (!apiKey) {
  console.error("No ANTHROPIC_API_KEY. Copy .env.example to .env and add your key.");
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: "32mb" }));
app.use(express.static(path.join(ROOT, "public")));

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
  const { title, who, goal, profile } = req.body ?? {};
  r.json(store.createCall({ title: title || "Untitled call", who, goal, profile }));
});

app.get("/api/calls/:id", (req, r) => {
  const c = store.load(req.params.id);
  return c ? r.json(c) : r.status(404).json({ error: "no such call" });
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
    if (kind === "path") {
      const files = readPath(target);
      if (!files.length) return r.status(400).json({ error: `Nothing readable at ${target}` });
      for (const f of files) {
        call.contextSources.push({ kind: "path", label: f.path, text: f.text, chars: f.chars });
      }
    } else {
      if (!text?.trim()) return r.status(400).json({ error: "empty" });
      call.contextSources.push({ kind: kind ?? "paste", label: label || "pasted", text, chars: text.length });
    }
  } catch (e) {
    return r.status(400).json({ error: e.message });
  }

  store.save(call);
  r.json({ ok: true, sources: call.contextSources.map(({ text, ...s }) => s) });
});

app.delete("/api/calls/:id/context/:idx", (req, r) => {
  const call = store.load(req.params.id);
  if (!call) return r.status(404).json({ error: "no such call" });
  call.contextSources.splice(Number(req.params.idx), 1);
  store.save(call);
  r.json({ ok: true });
});

/* -------------------------------------------------- digest + agenda (step 2) */

app.post("/api/calls/:id/prepare", async (req, r) => {
  const call = store.load(req.params.id);
  if (!call) return r.status(404).json({ error: "no such call" });
  if (!call.contextSources.length) return r.status(400).json({ error: "Add some context first" });

  try {
    const raw = sourceSummary(call.contextSources);
    const d = await digestContext({ apiKey, goal: call.goal, profile: call.profile, who: call.who, raw });
    call.contextDigest = d.digest;
    call.keyFacts = d.keyFacts;
    call.gaps = d.gaps;

    const priors = store
      .priorCalls(call.id, call.who)
      .map((p) => `### ${p.title} (${p.createdAt.slice(0, 10)})\n${p.debrief.slice(0, 6000)}`)
      .join("\n\n");

    const agenda = await proposeAgenda({
      apiKey,
      who: call.who,
      goal: call.goal,
      profile: call.profile,
      digest: d.digest,
      keyFacts: d.keyFacts,
      priors,
    });
    call.agenda = agenda;
    if (!call.title || call.title === "Untitled call") call.title = agenda.title;
    call.stage = "agenda";
    store.save(call);
    r.json(call);
  } catch (e) {
    console.error("[prepare]", e.stack ?? e.message);
    r.status(500).json({ error: e.message });
  }
});

// The agenda is a proposal — the user edits it before it becomes the thing
// they are judged against.
app.put("/api/calls/:id/agenda", (req, r) => {
  const call = store.load(req.params.id);
  if (!call) return r.status(404).json({ error: "no such call" });
  call.agenda = req.body.agenda;
  if (req.body.stage) call.stage = req.body.stage;
  store.save(call);
  r.json(call);
});

/* ------------------------------------------------------------ live (step 3) */

app.post("/api/calls/:id/line", (req, r) => {
  const call = store.load(req.params.id);
  if (!call) return r.status(404).json({ error: "no such call" });
  const text = String(req.body?.text ?? "").trim();
  if (!text) return r.json({ ok: true });
  call.lines.push({ speaker: String(req.body?.speaker ?? "room").slice(0, 40), text, at: Date.now() });
  if (call.stage === "agenda") call.stage = "live";
  store.save(call);
  emit(call.id, { type: "line", text });
  void maybeAnalyze(call.id);
  r.json({ ok: true, lines: call.lines.length });
});

app.post("/api/calls/:id/analyze", (req, r) => {
  void maybeAnalyze(req.params.id, true);
  r.json({ ok: true });
});

app.post("/api/calls/:id/answered", (req, r) => {
  const call = store.load(req.params.id);
  if (!call) return r.status(404).json({ error: "no such call" });
  const id = String(req.body?.id ?? "");
  if (id && !call.answered.includes(id)) call.answered.push(id);
  store.save(call);
  emit(call.id, { type: "answered", id });
  r.json({ ok: true });
});

app.get("/api/calls/:id/events", (req, r) => {
  r.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  r.write(": connected\n\n");
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
function isRepeat(flags, label) {
  const a = themeOf(label);
  if (!a.size) return false;
  return flags.slice(-25).some((f) => {
    const b = themeOf(f.label);
    if (!b.size) return false;
    let shared = 0;
    for (const w of a) if (b.has(w)) shared++;
    return shared / Math.min(a.size, b.size) >= 0.5;
  });
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

    for (const a of result.answered ?? []) {
      if (!fresh2.answered.includes(a.id)) {
        fresh2.answered.push(a.id);
        emit(id, { type: "answered", id: a.id, quote: a.quote });
      }
    }
    const add = (flag) => {
      if (isRepeat(fresh2.flags, flag.label)) return;
      fresh2.flags.push(flag);
      emit(id, { type: "flag", flag });
    };
    for (const d of result.dodges ?? []) add({ kind: "dodge", label: d.label, quote: d.quote, questionId: d.questionId, at: Date.now() });
    for (const c of result.contradictions ?? []) add({ kind: "contradiction", label: c.label, quote: `${c.theirClaim} — your record: ${c.yourFigure}`, at: Date.now() });
    for (const o of result.openings ?? []) add({ kind: "opening", label: o.label, quote: o.ask, at: Date.now() });
    for (const w of result.watchOuts ?? []) add({ kind: "watchout", label: w.label, quote: w.why, at: Date.now() });

    fresh2.sayNext = result.sayNext ?? "";
    emit(id, { type: "sayNext", text: fresh2.sayNext });
    store.save(fresh2);
    s.lastAt = Date.now();
    console.log(`[analyze ${id}] ${(result.dodges??[]).length}d ${(result.contradictions??[]).length}c ${(result.openings??[]).length}o ${(result.watchOuts??[]).length}w`);
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

app.listen(PORT, "0.0.0.0", () => {
  console.log(`SmartAssist — http://localhost:${PORT}`);
  console.log(`model: ${MODEL} · data: ${store.DATA}`);
});
