import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { profileOf } from "./profiles.mjs";

export const MODEL = process.env.SMARTASSIST_MODEL ?? "claude-opus-5";

const client = (apiKey) => new Anthropic({ apiKey });

/* ------------------------------------------------------------------ digest */

const DigestSchema = z.object({
  digest: z
    .string()
    .describe("The briefing, in Markdown. Dense, specific, figures preserved exactly as given."),
  keyFacts: z
    .array(z.object({ fact: z.string(), value: z.string() }))
    .describe("Checkable figures and dates — the things a claim in the room could contradict."),
  gaps: z.array(z.string()).describe("What is missing from the context that would matter in this conversation"),
});

/**
 * Raw context is too large and too noisy to re-send on every live turn. Condense
 * it once, up front, into the briefing the live loop will carry — and pull the
 * checkable figures out separately, because those are what a claim gets tested
 * against mid-conversation.
 */
export async function digestContext({ apiKey, goal, profile, who, raw }) {
  const p = profileOf(profile);
  const res = await client(apiKey).messages.parse({
    model: MODEL,
    max_tokens: 16000,
    system: `You prepare someone for a conversation that matters to them.

They are about to speak with: ${who || "someone"} (${p.label}).
What they want out of it: ${goal || "not stated"}.

How this kind of conversation fails them: ${p.failureMode}

Read everything they gave you and write the briefing they should have in their head.
Be dense and specific. Preserve every figure and date EXACTLY as given — never round,
never estimate, never invent. If something is unclear in the source, say it is unclear
rather than resolving it.

"keyFacts" are the checkable things: figures, dates, dosages, balances, deadlines,
prior commitments. These get used mid-conversation to test claims, so each needs enough
context to be meaningful on its own.

"gaps" are what is missing that would matter here — say so plainly, so they can find it
before the conversation rather than after.`,
    messages: [{ role: "user", content: raw.slice(0, 600_000) }],
    output_config: { format: zodOutputFormat(DigestSchema) },
  });
  return res.parsed_output;
}

/* ------------------------------------------------------------------ agenda */

const AgendaSchema = z.object({
  title: z.string().describe("Short name for this call, 3-7 words"),
  topics: z.array(z.string()).describe("Topic names, ordered by what matters most for their stated goal"),
  questions: z.array(
    z.object({
      id: z.string().describe("short stable id, e.g. a1, a2"),
      topic: z.string(),
      short: z.string().describe("At most 8 words. This is what they read at a glance mid-conversation."),
      ask: z.string().describe("The full question, phrased so they can read it aloud"),
      why: z.string().describe("Why this matters to them specifically, with their own figures where relevant"),
      answeredWhen: z.string().describe("The specific criterion that makes this genuinely answered"),
      dodgeLooksLike: z.string().describe("What a non-answer to this looks like in practice"),
      followUp: z.string().describe("The one-sentence push if the first answer doesn't land"),
    }),
  ),
  rules: z.array(z.string()).describe("Standing rules for this conversation — the things that outrank the agenda"),
});

export async function proposeAgenda({ apiKey, who, goal, profile, digest, keyFacts, priors }) {
  const p = profileOf(profile);
  const res = await client(apiKey).messages.parse({
    model: MODEL,
    max_tokens: 16000,
    system: `You propose the agenda for a conversation, from someone's own context and their goal.

They are speaking with: ${who || "someone"} (${p.label}).
Their goal: ${goal || "not stated"}.

How this kind of conversation fails them: ${p.failureMode}
What to watch for: ${p.watchFor.join(" ")}
What counts as an answer here: ${p.answerBar}

Rules for the questions you write:
- Ground every question in THEIR context. A question carrying their actual figure lands;
  a generic one does not. Never invent a figure to make a question sound sharper.
- Order by what actually moves their stated goal, not by what is easiest to ask.
- "answeredWhen" has to be checkable by someone listening. "They engage with it" is not
  checkable. "They state a dollar figure, or say plainly that it does not exist" is.
- "short" is read in a glance while someone is talking. Eight words maximum, no clauses.
- Prefer twelve sharp questions to thirty dutiful ones. Things that can wait belong in a
  topic named for waiting.
- "rules" are the things that outrank the agenda — a hard constraint of theirs, a priority
  that must interrupt anything, a line they have decided not to cross.`,
    messages: [
      {
        role: "user",
        content: `BRIEFING:
${digest}

CHECKABLE FACTS:
${(keyFacts ?? []).map((f) => `- ${f.fact}: ${f.value}`).join("\n")}

${priors?.length ? `PRIOR CONVERSATIONS WITH THIS PERSON:\n${priors}\n` : ""}
Propose the agenda.`,
      },
    ],
    output_config: { format: zodOutputFormat(AgendaSchema) },
  });
  return res.parsed_output;
}

/* -------------------------------------------------------------------- live */

const VerdictSchema = z.object({
  answered: z.array(z.object({ id: z.string(), quote: z.string() })),
  dodges: z.array(z.object({ questionId: z.string(), label: z.string(), quote: z.string() })),
  contradictions: z.array(z.object({ label: z.string(), theirClaim: z.string(), yourFigure: z.string() })),
  openings: z.array(z.object({ label: z.string(), ask: z.string() })),
  watchOuts: z.array(z.object({ label: z.string(), why: z.string() })),
  sayNext: z.string(),
});

function liveSystem(call) {
  const p = profileOf(call.profile);
  return `You sit beside someone during a live conversation, on their side of the table. Your job
is to get them the outcome they came for.

WHO THEY ARE TALKING TO: ${call.who || "someone"} (${p.label})
WHAT THEY WANT OUT OF IT: ${call.goal || "not stated"}

HOW THIS KIND OF CONVERSATION FAILS THEM: ${p.failureMode}
WATCH FOR: ${p.watchFor.join(" ")}
WHAT COUNTS AS ANSWERED: ${p.answerBar}

Every label is read in a glance while someone is talking to them: at most 10 words, no
hedging, no pleasantries, never a paragraph.

Mark a question answered ONLY when its answeredWhen criterion is genuinely met. When in
doubt, leave it unmarked — a false tick is worse than a missed one, because they stop asking.

Flag a contradiction only against a specific fact in their context, and cite that fact.

THEY ARE NOT DRIVING THIS CONVERSATION. The other person will do most of the talking.
So "sayNext" is usually EMPTY. Return one only when interrupting is genuinely worth it:
${p.interjectWhen}. Routine disagreement and anything that can wait for the debrief are not
reasons to make them interrupt — a prompt that fires constantly gets ignored at the moment
it matters. When you do return one: one sentence, 25 words maximum, ONE issue, phrased to
read aloud. Never join two topics.

STANDING RULES — these outrank the agenda:
${(call.agenda?.rules ?? []).map((r) => `- ${r}`).join("\n") || "- none given"}

THE AGENDA:
${JSON.stringify(call.agenda?.questions ?? [], null, 1)}

THEIR CONTEXT:
${call.contextDigest}

CHECKABLE FACTS:
${(call.keyFacts ?? []).map((f) => `- ${f.fact}: ${f.value}`).join("\n")}`;
}

export async function analyze({ apiKey, call, transcript }) {
  const res = await client(apiKey).messages.parse({
    model: MODEL,
    max_tokens: 4000,
    system: [{ type: "text", text: liveSystem(call), cache_control: { type: "ephemeral" } }],
    messages: [
      {
        role: "user",
        content: `ALREADY ANSWERED: ${call.answered.join(", ") || "none"}
ALREADY FLAGGED: ${call.flags.map((f) => f.label).join(" | ") || "none"}

NEW TRANSCRIPT:
${transcript}

Report only what is new here. Do not repeat anything already marked or flagged.`,
      },
    ],
    output_config: { format: zodOutputFormat(VerdictSchema), effort: "low" },
  });
  if (res.stop_reason === "refusal") throw new Error("model declined");
  return res.parsed_output;
}

/* ----------------------------------------------------------------- debrief */

export async function debrief({ apiKey, call, priors }) {
  const p = profileOf(call.profile);
  const stream = client(apiKey).messages.stream({
    model: MODEL,
    max_tokens: 32000,
    system: `You write the debrief after a conversation. Be specific and unsparing, and quote.

They spoke with: ${call.who || "someone"} (${p.label})
What they wanted out of it: ${call.goal || "not stated"}
How this kind of conversation fails them: ${p.failureMode}

Sections, in Markdown:
1. **Where this leaves you** — two or three sentences. The honest net position.
2. **Commitments made** — who, what, by when, quoted. Say plainly where a date or an owner is missing.
3. **Still unanswered** — which agenda items did not get a real answer, and how each was deflected.
4. **What contradicted your records** — their claim against the actual fact, with both figures.
5. **What changed since last time** — only if there are prior conversations below.
6. **Next steps** — numbered, each with an owner and a date. Theirs and the other party's, separated.
7. **What to verify independently** — and by whom, naming explicitly who must NOT be the verifier.
8. **The follow-up message** — ready to send, covering only the open items.

Never invent a quote. If something was not said, say it was not raised.

THE AGENDA:
${JSON.stringify(call.agenda?.questions ?? [], null, 1)}

THEIR CONTEXT:
${call.contextDigest}

CHECKABLE FACTS:
${(call.keyFacts ?? []).map((f) => `- ${f.fact}: ${f.value}`).join("\n")}

${priors ? `PRIOR CONVERSATIONS WITH THIS PERSON:\n${priors}` : ""}`,
    messages: [
      {
        role: "user",
        content: `Marked answered: ${call.answered.join(", ") || "none"}
Flags raised: ${call.flags.map((f) => `${f.kind}: ${f.label}`).join(" | ") || "none"}

FULL TRANSCRIPT:
${call.lines.map((l) => `${(l.speaker || "room").toUpperCase()}: ${l.text}`).join("\n")}

Write the debrief.`,
      },
    ],
  });
  return (await stream.finalMessage()).content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
}
