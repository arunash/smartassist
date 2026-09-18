# SmartAssist

**A live assistant for the conversations that matter.** You give it your context and
what you want out of a call. It proposes what to ask, sits with you while the call
happens, tells you when to speak up — and afterwards writes up what was actually
agreed, what never got answered, and what to do next.

Runs entirely on your machine. Transcription is local. Your files never move.

---

## Why

In the moment, you have about four seconds to notice that the answer you just got
wasn't an answer. Afterwards it's obvious. That gap is the whole problem.

It shows up differently depending on who you're talking to, and that difference is
what SmartAssist actually encodes:

| | How the conversation fails you | So it… |
|---|---|---|
| **Advisor** — CPA, attorney, financial | Evasion, and confident advice from the wrong chair | detects dodges, checks arithmetic against your records, flags scope |
| **Doctor** | **Time**, not evasion — they're behind, not hiding | triages ruthlessly, insists the plan is complete, catches dropped follow-ups |
| **Insurance / billing** | Facts slipping past | captures the reference number, the denial code, the deadline, the name |
| **School / IEP** | What's said ≠ what's in the document | holds spoken promises against the written plan |
| **Contractor / vendor** | Scope and price drift | pins what's excluded, what would change the price |

## How it works

**1 · Context and goal.** Point it at folders on disk — your filed returns, your
care notes — or paste text in. Say who you're speaking with and what you want out
of it. It reads everything once and builds the briefing it will carry.

**2 · It proposes the topics.** Questions grounded in *your* figures, each with what
would count as a real answer, what a dodge looks like, and the follow-up. You edit,
drop what you don't need, and go.

**3 · Live assist.** Your agenda ticks off on the left as questions genuinely get
answered. Flags accumulate on the right — a dodge, a claim that contradicts your own
records, an opening worth pressing, something being decided against your interest.

The bar at the bottom is the only thing you need while someone is talking. It stays
quiet by default and lights up when interrupting is actually worth it.

**4 · Debrief.** Where it leaves you, commitments made with quotes, what never got
answered and how it was deflected, what contradicted your records, numbered next
steps with owners and dates, what to verify independently and who must *not* be the
one to verify it — and a follow-up message ready to send.

**It compounds.** Each debrief becomes context for the next conversation with the
same person. *"I'll get that referral sent over"* reads differently when it's the
same sentence they said four months ago.

## Privacy

There is no server but the one on your own machine. Transcription runs locally
through whisper.cpp — no cloud speech API, no audio upload. Your context is read
from where it already lives. The only thing that leaves is the model call.

That isn't a feature list item. It's the reason this is usable in an exam room.

## Install

Requires Node 20+, `ffmpeg`, and `whisper-cli` (whisper.cpp).

```bash
git clone https://github.com/arunash/smartassist.git
cd smartassist
npm install

brew install ffmpeg whisper-cpp        # macOS
brew install poppler                   # optional — lets it read PDFs

mkdir -p models && curl -L -o models/ggml-small.en.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin

cp .env.example .env                   # then add your Anthropic API key
npm start                              # portal at http://localhost:7400
```

When a call starts, run the ear in a second terminal with the call's id:

```bash
node listen.mjs 20260918-fwsz
```

## The setup that works best

Take the call on a **second device** — laptop or phone — with its speakers on. Run
SmartAssist on the machine in front of you. It simply hears the room: your voice
directly, and theirs through the other device's speaker.

Nothing is installed on the call device, nothing joins the meeting, and you get a
real second screen instead of a window fighting for space during the conversation.

A browser-mic fallback is built into the portal if you'd rather not run the ear.
It uses the browser's speech API, which sends audio to the browser vendor — the UI
says so plainly, because for these calls that difference is the whole point.

## Where things are

```
data/calls/<id>/
  call.json         context, agenda, flags, everything
  transcript.jsonl  the evidence behind every quote
  debrief.md        written when you end the call
```

Plain files. Read them, grep them, delete them.

## Configuration

| | |
|---|---|
| `ANTHROPIC_API_KEY` | in `.env` — never leaves this machine |
| `PORT` | portal port, default 7400 |
| `SMARTASSIST_MODEL` | default `claude-opus-5` |
| `SMARTASSIST_DATA` | where calls are stored |
| `WHISPER_MODEL` | path to the ggml model |
| `AUDIO_DEVICE` | ffmpeg input, default `:0` |
| `SEGMENT` | seconds per transcription chunk, default 12 |

## Design notes

- **Batched analysis.** Fires on ~25 new words and a 9-second minimum gap, so it
  lands about once per exchange. Per-utterance calls would cost a fortune and arrive
  after the moment passed. A timer also sweeps, because the end of a call — where the
  unanswered questions pile up — is exactly when nobody is talking.
- **Low effort live, full effort on the debrief.** The live judgment is narrow and has
  to be fast. The debrief has no latency pressure.
- **A false tick is worse than a missed one.** When in doubt it leaves a question
  unmarked, because a wrong tick means you stop asking.
- **Repeats are suppressed.** The same concern returns in fresh wording as a call goes
  on. Three phrasings of one point is worse than one — the pane becomes a firehose, you
  stop reading it, and that costs you the flag that mattered.
- **Silence is the default.** It only asks you to interrupt when interrupting is worth it.

## Consent

Many places, California included, require everyone's consent to record. Transcription
here is local and the audio chunks are deleted as they're processed, which puts it
closer to note-taking — but say it out loud at the start anyway. One sentence:
*"I'm taking transcribed notes on my side."*

It also tends to make people more precise.

## License

MIT. Not professional advice of any kind — it helps you ask better questions and
keeps an honest record of the answers.
