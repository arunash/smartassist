/**
 * Calls on disk. Plain JSON in a folder per call — inspectable, greppable, and
 * trivially deletable, which matters when the contents are your medical or
 * financial history. No database, no daemon, nothing to migrate.
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");
export const DATA = process.env.SOTTO_DATA ?? process.env.SMARTASSIST_DATA ?? path.join(ROOT, "data", "calls");

// Medical and financial records: owner-only, on disk as well as over the wire.
fs.mkdirSync(DATA, { recursive: true, mode: 0o700 });
const PRIVATE = { mode: 0o600 };

export function newId() {
  // Sortable and human-readable: 20260918-a3f9
  const d = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return `${d}-${Math.random().toString(36).slice(2, 6)}`;
}

const dir = (id) => path.join(DATA, id);
const file = (id, name) => path.join(dir(id), name);

export function createCall(fields) {
  const id = newId();
  fs.mkdirSync(dir(id), { recursive: true, mode: 0o700 });
  const call = {
    id,
    createdAt: new Date().toISOString(),
    stage: "context",           // context → agenda → live → debrief
    title: fields.title ?? "Untitled call",
    profile: fields.profile ?? "general",
    who: fields.who ?? "",
    goal: fields.goal ?? "",
    allowResearch: fields.allowResearch ?? true,
    contextSources: [],
    contextDigest: "",
    agenda: null,
    questionStatus: {},  // id → { status: answered|dodged|partial, quote }
    now: null,           // the one thing on screen
    nowHistory: [],
    captured: [],
    notes: [],           // for the debrief only
    lines: [],
    consumed: 0,
    debrief: null,
    ...fields,
  };
  save(call);
  return call;
}

export function save(call) {
  fs.mkdirSync(dir(call.id), { recursive: true, mode: 0o700 });
  // Transcript lives beside the record rather than inside it: it is the evidence
  // for every quote in the debrief, and it should be readable on its own.
  const { lines, ...rest } = call;
  fs.writeFileSync(file(call.id, "call.json"), JSON.stringify(rest, null, 2), PRIVATE);
  fs.writeFileSync(
    file(call.id, "transcript.jsonl"),
    (lines ?? []).map((l) => JSON.stringify(l)).join("\n") + (lines?.length ? "\n" : ""),
    PRIVATE,
  );
  return call;
}

export function load(id) {
  try {
    const call = JSON.parse(fs.readFileSync(file(id, "call.json"), "utf8"));
    let lines = [];
    try {
      lines = fs
        .readFileSync(file(id, "transcript.jsonl"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    } catch {
      /* no transcript yet */
    }
    return { ...call, lines };
  } catch {
    return null;
  }
}

export function list() {
  return fs
    .readdirSync(DATA)
    .filter((d) => /^\d{8}-[a-z0-9]{4}$/.test(d) && fs.existsSync(file(d, "call.json")))
    .map((d) => {
      const c = JSON.parse(fs.readFileSync(file(d, "call.json"), "utf8"));
      return {
        id: c.id,
        title: c.title,
        who: c.who,
        profile: c.profile,
        stage: c.stage,
        createdAt: c.createdAt,
        questionCount: c.agenda?.questions?.length ?? 0,
        flagCount: c.nowHistory?.length ?? c.flags?.length ?? 0,
      };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function remove(id) {
  fs.rmSync(dir(id), { recursive: true, force: true });
}

export function writeArtifact(id, name, contents) {
  fs.mkdirSync(dir(id), { recursive: true, mode: 0o700 });
  const p = file(id, name);
  fs.writeFileSync(p, contents, PRIVATE);
  return p;
}

/**
 * Uploaded documents are kept as the originals, beside the call that used them,
 * so deleting the call folder deletes them too.
 */
export function saveDocument(id, name, buf) {
  const docs = path.join(dir(id), "docs");
  fs.mkdirSync(docs, { recursive: true, mode: 0o700 });
  // No separators, no leading dot — so "..", "." or ".env" can't name anything but a plain file here.
  const safe = path.basename(String(name)).replace(/[^\w.\- ()]/g, "_").replace(/^\.+/, "_").slice(0, 150) || "document";
  const ext = path.extname(safe);
  let p = path.join(docs, safe);
  for (let n = 2; fs.existsSync(p); n++) p = path.join(docs, `${path.basename(safe, ext)} (${n})${ext}`);
  fs.writeFileSync(p, buf, PRIVATE);
  return p;
}

export function removeDocument(id, p) {
  // Only ever delete inside this call's own docs folder.
  if (p && path.dirname(p) === path.join(dir(id), "docs")) fs.rmSync(p, { force: true });
}

/** Prior calls with the same person — the continuity that makes this compound. */
export function priorCalls(id, who) {
  if (!who) return [];
  return list()
    .filter((c) => c.id !== id && c.who && c.who.toLowerCase() === who.toLowerCase())
    .map((c) => load(c.id))
    .filter((c) => c?.debrief)
    .slice(0, 3);
}
