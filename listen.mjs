/**
 * The local ear.  node listen.mjs <call-id>
 *
 * Records the microphone in fixed segments and transcribes each one with
 * whisper.cpp on this machine, then posts the text to the portal. No cloud speech
 * API and no audio upload — which is the only reason this is usable in a doctor's
 * office or on a call about your finances.
 *
 * Put a model at models/ggml-small.en.bin (or set WHISPER_MODEL).
 */
import { spawn, execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const ROOT = import.meta.dirname;
const callId = process.argv[2];
if (!callId) {
  console.error("usage: node listen.mjs <call-id>   (copy it from the portal)");
  process.exit(1);
}

const SERVER = process.env.SERVER ?? `http://localhost:${process.env.PORT ?? 7400}`;
const MODEL = process.env.WHISPER_MODEL ?? path.join(ROOT, "models/ggml-small.en.bin");
const DEVICE = process.env.AUDIO_DEVICE ?? ":0";
const SEGMENT = Number(process.env.SEGMENT ?? 12);
const CHUNKS = path.join(ROOT, "chunks", callId);

if (!fs.existsSync(MODEL)) {
  console.error(`No whisper model at ${MODEL}
Download one, e.g.:
  mkdir -p models && curl -L -o models/ggml-small.en.bin \\
    https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin`);
  process.exit(1);
}

fs.rmSync(CHUNKS, { recursive: true, force: true });
fs.mkdirSync(CHUNKS, { recursive: true });
console.log(`listening (${DEVICE}, ${SEGMENT}s segments) → ${SERVER} call ${callId}`);

// One long-lived ffmpeg writing back-to-back segments. Spawning per chunk would
// drop audio in the gap between processes, which is where the answer lands.
const ff = spawn("ffmpeg", [
  "-hide_banner", "-loglevel", "error",
  "-f", process.platform === "darwin" ? "avfoundation" : "alsa",
  "-i", DEVICE,
  "-ar", "16000", "-ac", "1",
  "-f", "segment", "-segment_time", String(SEGMENT), "-reset_timestamps", "1",
  path.join(CHUNKS, "seg%05d.wav"),
]);
ff.stderr.on("data", (d) => process.stderr.write(`[ffmpeg] ${d}`));
ff.on("exit", (c) => {
  console.error(`ffmpeg exited (${c}). If that was immediate, grant your terminal microphone access.`);
  process.exit(1);
});

const done = new Set();
let busy = false;

setInterval(async () => {
  if (busy) return;
  const files = fs.readdirSync(CHUNKS).filter((f) => f.endsWith(".wav")).sort();
  const ready = files.slice(0, -1).filter((f) => !done.has(f)); // last is still being written
  if (!ready.length) return;

  busy = true;
  for (const f of ready) {
    done.add(f);
    const full = path.join(CHUNKS, f);
    try {
      const { stdout } = await exec("whisper-cli", ["-m", MODEL, "-f", full, "-nt", "-np", "-t", "6", "-l", "en"]);
      // Whisper narrates the room when nobody speaks — "(dog barks)", "[BLANK_AUDIO]".
      // Posting those burns an analysis pass on nothing.
      const speech = stdout.replace(/[[(][^\])]*[\])]/g, "").replace(/\s+/g, " ").trim();
      if (speech.length > 8) {
        console.log(`· ${speech}`);
        await fetch(`${SERVER}/api/calls/${callId}/line`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: speech, speaker: "room" }),
        }).catch((e) => console.error(`portal unreachable: ${e.message}`));
      }
    } catch (e) {
      console.error(`whisper failed on ${f}: ${e.message}`);
    } finally {
      fs.rmSync(full, { force: true });
    }
  }
  busy = false;
}, 1500);

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    ff.kill("SIGINT");
    fs.rmSync(CHUNKS, { recursive: true, force: true });
    process.exit(0);
  });
}
