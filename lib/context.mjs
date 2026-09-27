/**
 * Context ingestion: pasted text, uploaded text, and paths on disk.
 *
 * Local paths are the important one. It means pointing at the folder where your
 * filed returns or your child's care notes already live, instead of copying
 * sensitive material somewhere new to use this.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { untrusted } from "./guard.mjs";

const TEXTY = new Set([".txt", ".md", ".json", ".csv", ".jsonl", ".yaml", ".yml", ".html", ".xml", ".log"]);
// Word-processor formats macOS can convert natively via textutil — no extra install.
const RICH = new Set([".docx", ".doc", ".rtf", ".odt", ".wordml", ".webarchive"]);
export const READABLE = [...TEXTY, ".pdf", ...RICH];
const MAX_FILE = 400_000;   // one file
const MAX_TOTAL = 1_500_000; // everything, before digesting
const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "dist", "build", "venv", "__pycache__"]);

/**
 * Paths that must never be read, even when pointed at directly: key material,
 * credentials, shell and app config. Everything read here goes to the model, so
 * a path typo must not be able to ship ~/.ssh or an API key file off the machine.
 * Checked on the REAL path, so a symlink can't smuggle one in.
 */
const SENSITIVE_NAME = /(^id_(rsa|dsa|ecdsa|ed25519)|\.(pem|key|p12|pfx|keychain(-db)?|kdbx|gpg|asc)$|^\.?env(\..*)?$|credential|secret|password|passwd|token|api[_-]?key|private[_-]?key)/i;
const SENSITIVE_DIR = /^(\..*|Library|Keychains)$/;

function isSensitive(real) {
  const parts = path.relative(path.parse(real).root, real).split(path.sep);
  // iCloud Drive and Google/Dropbox sync folders live under ~/Library and are
  // ordinary documents — allow those two, block the rest of Library.
  const cloud = parts.findIndex((d, i) => d === "Library" && /^(Mobile Documents|CloudStorage)$/.test(parts[i + 1] ?? ""));
  const dirs = parts.slice(0, -1).filter((_, i) => cloud < 0 || (i !== cloud && i !== cloud + 1));
  if (dirs.some((d) => SENSITIVE_DIR.test(d))) return true;
  const base = parts.at(-1);
  return base.startsWith(".") || SENSITIVE_NAME.test(base);
}

export function readPath(target, { maxFiles = 60 } = {}) {
  const out = [];
  let total = 0;
  if (!target || typeof target !== "string") throw new Error("No path given");
  const abs = target.startsWith("~") ? path.join(process.env.HOME, target.slice(1)) : path.resolve(target);
  const root = fs.realpathSync(abs); // throws if missing — the caller reports it
  if (isSensitive(root)) throw new Error(`Refusing to read ${target}: it looks like credentials, keys or hidden config`);
  let skipped = 0;

  const take = (p) => {
    if (out.length >= maxFiles || total >= MAX_TOTAL) return;
    let real;
    try { real = fs.realpathSync(p); } catch { return; }
    if (isSensitive(real) || !fs.statSync(real).isFile()) { skipped++; return; }
    const text = extractText(real);
    if (!text?.trim()) return;
    out.push({ path: p, chars: text.length, text });
    total += text.length;
  };

  const walk = (d, depth) => {
    if (depth > 3 || out.length >= maxFiles) return;
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p, depth + 1);
      else if (entry.isFile() || entry.isSymbolicLink()) take(p);
    }
  };

  if (fs.statSync(root).isDirectory()) walk(root, 0);
  else take(root);

  out.skipped = skipped;
  return out;
}

/**
 * Text of one file, or null for formats it can't read (binary or unknown —
 * skipped rather than guessed at).
 */
export function extractText(p) {
  const ext = path.extname(p).toLowerCase();
  if (TEXTY.has(ext)) return fs.readFileSync(p, "utf8").slice(0, MAX_FILE);
  if (ext === ".pdf") return pdfText(p);
  if (RICH.has(ext)) return richText(p);
  return null;
}

function richText(p) {
  try {
    return execFileSync("textutil", ["-convert", "txt", "-stdout", p], {
      encoding: "utf8",
      maxBuffer: MAX_FILE * 4,
    }).slice(0, MAX_FILE);
  } catch {
    return `[Document not read: ${path.basename(p)} — textutil could not convert it]`;
  }
}

/**
 * PDFs need a converter. pdftotext (poppler) is the common one; if it isn't
 * installed we say so rather than silently dropping the file, because a missing
 * tax return is not a detail the user should discover during the call.
 */
function pdfText(p) {
  try {
    return execFileSync("pdftotext", ["-q", "-layout", p, "-"], {
      encoding: "utf8",
      maxBuffer: MAX_FILE * 4,
    }).slice(0, MAX_FILE);
  } catch {
    return `[PDF not read: ${path.basename(p)} — install pdftotext (brew install poppler) to include PDFs]`;
  }
}

export function sourceSummary(sources) {
  // Each document is wrapped as untrusted data — see lib/guard.mjs.
  return sources
    .map((s) => untrusted("document", s.text, { source: s.kind === "paste" ? "pasted" : s.kind, name: s.label }))
    .join("\n\n");
}
