/**
 * Calls on disk. Plain JSON in a folder per call — inspectable, greppable, and
 * trivially deletable, which matters when the contents are your medical or
 * financial history. No database, no daemon, nothing to migrate.
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");
export const DATA = process.env.SMARTASSIST_DATA ?? path.join(ROOT, "data", "calls");

fs.mkdirSync(DATA, { recursive: true });

export function newId() {
  // Sortable and human-readable: 20260918-a3f9
  const d = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return `${d}-${Math.random().toString(36).slice(2, 6)}`;
}

const dir = (id) => path.join(DATA, id);
const file = (id, name) => path.join(dir(id), name);

export function createCall(fields) {
  const id = newId();
  fs.mkdirSync(dir(id), { recursive: true });
  const call = {
    id,
    createdAt: new Date().toISOString(),
    stage: "context",           // context → agenda → live → debrief
    title: fields.title ?? "Untitled call",
    profile: fields.profile ?? "general",
    who: fields.who ?? "",
    goal: fields.goal ?? "",
    contextSources: [],
    contextDigest: "",
    agenda: null,
    answered: [],
    flags: [],
    sayNext: "",
    lines: [],
    consumed: 0,
    debrief: null,
    ...fields,
  };
  save(call);
  return call;
}

export function save(call) {
  fs.mkdirSync(dir(call.id), { recursive: true });
  // Transcript lives beside the record rather than inside it: it is the evidence
  // for every quote in the debrief, and it should be readable on its own.
  const { lines, ...rest } = call;
  fs.writeFileSync(file(call.id, "call.json"), JSON.stringify(rest, null, 2));
  fs.writeFileSync(
    file(call.id, "transcript.jsonl"),
    (lines ?? []).map((l) => JSON.stringify(l)).join("\n") + (lines?.length ? "\n" : ""),
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
    .filter((d) => fs.existsSync(file(d, "call.json")))
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
        flagCount: c.flags?.length ?? 0,
      };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function remove(id) {
  fs.rmSync(dir(id), { recursive: true, force: true });
}

export function writeArtifact(id, name, contents) {
  fs.mkdirSync(dir(id), { recursive: true });
  const p = file(id, name);
  fs.writeFileSync(p, contents);
  return p;
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
