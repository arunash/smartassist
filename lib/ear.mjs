/**
 * The ear, run from the portal. Starting a second terminal mid-appointment is the
 * step people skip, so the server owns the listen.mjs process instead: one click to
 * start, one to stop, and its failures (no mic permission, no model) show up in the
 * live view rather than in a terminal nobody is looking at.
 *
 * One ear at a time — there is one microphone.
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");
const MODEL = process.env.WHISPER_MODEL ?? path.join(ROOT, "models/ggml-small.en.bin");

let ear = null; // { callId, proc, device, heard, error }

const onPath = (bin) => {
  try {
    execFileSync("which", [bin], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

/** What's missing before listening can work, in words the user can act on. */
export function preflight() {
  const problems = [];
  if (!onPath("ffmpeg")) problems.push("ffmpeg is not installed — brew install ffmpeg");
  if (!onPath("whisper-cli")) problems.push("whisper.cpp is not installed — brew install whisper-cpp");
  if (!fs.existsSync(MODEL)) problems.push(`No whisper model at ${MODEL} — see the README`);
  return problems;
}

/** Microphones, from ffmpeg's avfoundation listing (macOS). */
export function microphones() {
  if (process.platform !== "darwin") return [];
  let out = "";
  try {
    execFileSync("ffmpeg", ["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    out = String(e.stderr ?? ""); // ffmpeg always "fails" here; the listing is on stderr
  }
  const audio = out.split(/audio devices:/i)[1] ?? "";
  return [...audio.matchAll(/\[(\d+)\]\s+(.+)/g)].map((m) => ({ id: `:${m[1]}`, name: m[2].trim() }));
}

export function status(callId) {
  if (!ear) return { on: false };
  return {
    on: true,
    mine: ear.callId === callId,
    callId: ear.callId,
    device: ear.deviceName,
    heard: ear.heard,
  };
}

/**
 * @param emit (callId, payload) — pushes ear state into that call's live stream.
 */
export function start({ callId, device, deviceName, port, token, emit }) {
  if (ear?.callId === callId) return status(callId);
  if (ear) throw new Error("Already listening for another call — stop that one first");
  const problems = preflight();
  if (problems.length) throw new Error(problems.join("\n"));
  if (device && !/^:\d{1,2}$/.test(device)) throw new Error("bad microphone");

  const proc = spawn(process.execPath, [path.join(ROOT, "listen.mjs"), callId], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      ...(device ? { AUDIO_DEVICE: device } : {}),
      ...(token ? { SMARTASSIST_TOKEN: token } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const me = { callId, proc, deviceName: deviceName || "default microphone", heard: "", error: "" };
  ear = me;

  const lines = (stream, fn) => {
    let buf = "";
    stream.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        fn(buf.slice(0, i).trim());
        buf = buf.slice(i + 1);
      }
    });
  };
  lines(proc.stdout, (l) => {
    if (l.startsWith("· ")) me.heard = l.slice(2);
  });
  lines(proc.stderr, (l) => {
    if (!l) return;
    console.error(`[ear ${callId}] ${l}`);
    me.error = l.replace(/^\[ffmpeg\]\s*/, "");
    // Transcription failures on one chunk are survivable; surface them without stopping.
    if (/whisper failed|portal unreachable/.test(l)) emit(callId, { type: "ear", ...status(callId), warning: me.error });
  });
  proc.on("exit", (code, signal) => {
    if (ear === me) ear = null;
    const stopped = signal === "SIGTERM" || signal === "SIGINT" || code === 0;
    const hint = /permission|not authorized|Input\/output error|ffmpeg exited/i.test(me.error)
      ? "Could not open the microphone. Give your terminal app microphone access in System Settings → Privacy & Security → Microphone, then restart SmartAssist."
      : me.error;
    emit(callId, { type: "ear", on: false, ...(stopped ? {} : { error: hint || `listener exited (${code})` }) });
  });

  emit(callId, { type: "ear", ...status(callId) });
  return status(callId);
}

export function stop(callId) {
  if (ear && (!callId || ear.callId === callId)) ear.proc.kill("SIGTERM");
}

// Never leave a microphone open behind a dead server.
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    stop();
    process.exit(0);
  });
}
process.on("exit", () => stop());
