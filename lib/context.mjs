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

const TEXTY = new Set([".txt", ".md", ".json", ".csv", ".jsonl", ".yaml", ".yml", ".html", ".xml", ".log"]);
const MAX_FILE = 400_000;   // one file
const MAX_TOTAL = 1_500_000; // everything, before digesting
const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "dist", "build", "venv", "__pycache__"]);

export function readPath(target, { maxFiles = 60 } = {}) {
  const out = [];
  let total = 0;
  const abs = target.startsWith("~") ? path.join(process.env.HOME, target.slice(1)) : path.resolve(target);

  const take = (p) => {
    if (out.length >= maxFiles || total >= MAX_TOTAL) return;
    const ext = path.extname(p).toLowerCase();
    let text = null;

    if (TEXTY.has(ext)) {
      text = fs.readFileSync(p, "utf8").slice(0, MAX_FILE);
    } else if (ext === ".pdf") {
      text = pdfText(p);
    } else {
      return; // binary or unknown — skipped rather than guessed at
    }
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
      else take(p);
    }
  };

  const stat = fs.statSync(abs); // throws if missing — the caller reports it
  if (stat.isDirectory()) walk(abs, 0);
  else take(abs);

  return out;
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
  return sources
    .map((s) => {
      if (s.kind === "paste") return `--- pasted: ${s.label} ---\n${s.text}`;
      if (s.kind === "file") return `--- file: ${s.label} ---\n${s.text}`;
      return `--- ${s.label} ---\n${s.text}`;
    })
    .join("\n\n");
}
