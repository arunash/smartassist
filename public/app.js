const $ = (s, r = document) => r.querySelector(s);
const view = $("#view");
// Only http(s) links from model output — a researched "source" could be javascript:.
const safeUrl = (u) => { try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.href : ""; } catch { return ""; } };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const api = async (url, opts) => {
  const r = await fetch(url, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `${r.status}`);
  return j;
};
const post = (u, b) => api(u, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b ?? {}) });

function panel(title, items, tone, render) {
  if (!items?.length) return "";
  return `<details class="panel ${tone}"><summary>${esc(title)} <span class="ct">${items.length}</span></summary>
    <ul>${items.map((i) => `<li>${render(i)}</li>`).join("")}</ul></details>`;
}

function researchToggle(id, on) {
  return `<label class="toggle"><input type="checkbox" id="${id}" ${on ? "checked" : ""} />
    <span><b>Allow external research</b><br /><span class="m">Searches the web for what your files don't
    say — normal ranges, limits, guidelines, deadlines. Search queries are built from your context, so they
    leave your machine. Off: it works only from your material and the arithmetic on it.</span></span></label>`;
}

const readFile64 = (f) =>
  new Promise((ok, no) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).split(",")[1] ?? "");
    r.onerror = () => no(r.error);
    r.readAsDataURL(f);
  });

const STAGES = [
  ["context", "Context & goal"],
  ["agenda", "Topics"],
  ["live", "Live assist"],
  ["debrief", "Debrief"],
];

function steps(stage) {
  const i = STAGES.findIndex((s) => s[0] === stage);
  return `<div class="steps">${STAGES.map(
    (s, n) => `<div class="step ${n < i ? "done" : n === i ? "now" : ""}"><b>${n + 1}</b>${s[1]}</div>`,
  ).join("")}</div>`;
}

/* ------------------------------------------------------------------ routes */

async function route() {
  const h = location.hash || "#/";
  $("#crumb").textContent = "";
  if (h === "#/") return listCalls();
  const m = h.match(/^#\/c\/([\w-]+)$/);
  if (m) return showCall(m[1]);
  location.hash = "#/";
}
addEventListener("hashchange", route);
document.addEventListener("click", (e) => {
  const go = e.target.closest("[data-go]");
  if (go) location.hash = go.dataset.go;
});
$("#home").onclick = () => (location.hash = "#/");

/* ------------------------------------------------------------------- list */

async function listCalls() {
  const [calls, profiles] = await Promise.all([api("/api/calls"), api("/api/profiles")]);
  view.innerHTML = `<div class="wrap">
    <h1>Your calls</h1>
    <p class="sub">Add your context and what you want out of a conversation. SmartAssist proposes what to
    ask, sits with you while it happens, and writes up what was actually agreed.</p>

    <h2>New call</h2>
    <div class="card">
      <div class="grid2">
        <label><span class="lb">Who are you speaking with?</span><input id="who" placeholder="Dr. Patel · my CPA · Anthem appeals" /></label>
        <label><span class="lb">What kind of conversation?</span><select id="profile">
          ${profiles.map((p) => `<option value="${p.id}">${esc(p.label)}</option>`).join("")}
        </select></label>
      </div>
      <label><span class="lb">What do you want out of it?</span>
        <textarea id="goal" rows="3" placeholder="Be specific. &quot;Leave with a written answer on whether the losses offset my W-2 income&quot; beats &quot;discuss taxes&quot;."></textarea></label>
      ${researchToggle("research", true)}
      <div class="row"><button id="create">Create call</button></div>
      <div id="err"></div>
    </div>

    <h2>Recent</h2>
    ${
      calls.length
        ? calls
            .map(
              (c) => `<div class="card click" data-go="#/c/${esc(c.id)}">
        <div class="row" style="justify-content:space-between">
          <div><div class="t">${esc(c.title)}</div>
          <div class="m">${esc(c.who || "—")} · ${c.questionCount} questions · ${c.flagCount} flags · ${c.createdAt.slice(0, 10)}</div></div>
          <span class="tag stage-${esc(c.stage)}">${esc(c.stage)}</span>
        </div></div>`,
            )
            .join("")
        : `<p class="sub">Nothing yet.</p>`
    }
  </div>`;

  $("#create").onclick = async () => {
    try {
      const c = await post("/api/calls", {
        who: $("#who").value.trim(),
        goal: $("#goal").value.trim(),
        profile: $("#profile").value,
        allowResearch: $("#research").checked,
      });
      location.hash = `#/c/${c.id}`;
    } catch (e) {
      $("#err").innerHTML = `<div class="err">${esc(e.message)}</div>`;
    }
  };
}

/* ------------------------------------------------------------------- call */

async function showCall(id) {
  const call = await api(`/api/calls/${id}`);
  $("#crumb").textContent = `${call.title} · ${call.who || "—"}`;
  if (call.stage === "context") return stageContext(call);
  if (call.stage === "agenda") return stageAgenda(call);
  if (call.stage === "debrief" && call.debrief) return stageDebrief(call);
  return stageLive(call);
}

/* --------------------------------------------------------------- 1 context */

function stageContext(call) {
  view.innerHTML = `<div class="wrap">
    ${steps("context")}
    <h1>${esc(call.title)}</h1>
    <p class="sub">Give it everything relevant. Nothing leaves your machine except the model calls.</p>

    <h2>Upload documents</h2>
    <div class="card drop" id="drop">
      <p style="margin:0 0 10px">Drop files here, or <label class="linkish">choose files<input type="file" id="files" multiple hidden
        accept=".pdf,.docx,.doc,.rtf,.odt,.txt,.md,.csv,.json,.jsonl,.html,.xml,.yaml,.yml,.log" /></label></p>
      <span class="m">PDF, Word, RTF, text, Markdown, CSV, JSON. Originals are kept in this call's folder on your machine.</span>
      <div id="upl" class="m" style="margin-top:8px"></div>
    </div>

    <h2>Or point at files on disk</h2>
    <div class="card">
      <label><span class="lb">A file or folder — it reads PDF, Word, RTF, text, Markdown, JSON and CSV. Keys, credentials and hidden files are always skipped</span>
        <input id="path" placeholder="~/tax-returns  ·  ~/notes/visit-summary.pdf" /></label>
      <div class="row"><button class="ghost" id="addPath">Add path</button></div>
    </div>

    <h2>Or paste it in</h2>
    <div class="card">
      <label><span class="lb">Label</span><input id="plabel" placeholder="Last visit notes" /></label>
      <label><span class="lb">Text</span><textarea id="ptext" rows="7"></textarea></label>
      <div class="row"><button class="ghost" id="addPaste">Add text</button></div>
    </div>

    <h2>Added (<span id="n">${call.contextSources.length}</span>)</h2>
    <div class="card" id="srcs"></div>

    <h2>Research</h2>
    <div class="card">${researchToggle("research", call.allowResearch !== false)}</div>
    <div id="err"></div>
    <div class="row" style="margin-top:18px">
      <button id="prep" ${call.contextSources.length ? "" : "disabled"}>Suggest topics →</button>
      <span class="spin" id="spin"></span>
    </div>
    <div class="note">This step reads everything once and builds the briefing the live assist carries.
    It takes a minute and it is the step that makes every question specific to you.</div>
  </div>`;

  const paint = (sources) => {
    $("#n").textContent = sources.length;
    $("#srcs").innerHTML = sources.length
      ? sources
          .map(
            (s, i) =>
              `<div class="src"><span class="p"><span class="tag">${s.kind === "upload" ? "uploaded" : s.kind === "path" ? "on disk" : "pasted"}</span> ${esc(s.label)}</span>
               ${s.warning ? `<div class="err srcwarn">${esc(s.warning)}</div>` : ""}
               <span>${(s.chars / 1000).toFixed(1)}k <button class="danger" data-i="${i}" style="padding:2px 8px;font-size:12px">remove</button></span></div>`,
          )
          .join("")
      : `<p class="sub" style="margin:0">Nothing added yet.</p>`;
    $("#srcs").querySelectorAll("button[data-i]").forEach((b) => {
      b.onclick = async () => {
        await api(`/api/calls/${call.id}/context/${b.dataset.i}`, { method: "DELETE" });
        showCall(call.id);
      };
    });
    $("#prep").disabled = !sources.length;
  };
  paint(call.contextSources.map(({ text, ...s }) => s));

  const fail = (e) => ($("#err").innerHTML = `<div class="err">${esc(e.message)}</div>`);

  const upload = async (list) => {
    $("#err").innerHTML = "";
    const files = [...list];
    const problems = [];
    for (const [n, f] of files.entries()) {
      $("#upl").textContent = `Reading ${f.name} (${n + 1} of ${files.length})…`;
      try {
        const r = await post(`/api/calls/${call.id}/context`, { kind: "upload", name: f.name, data: await readFile64(f) });
        paint(r.sources);
      } catch (e) { problems.push(e.message); }
    }
    $("#upl").textContent = "";
    if (problems.length) fail(new Error(problems.join("\n")));
  };
  $("#files").onchange = (e) => { upload(e.target.files); e.target.value = ""; };
  const drop = $("#drop");
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add("over"); };
  drop.ondragleave = () => drop.classList.remove("over");
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove("over"); upload(e.dataTransfer.files); };

  $("#research").onchange = async (e) => {
    try { await api(`/api/calls/${call.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ allowResearch: e.target.checked }) }); } catch (err) { fail(err); }
  };

  $("#addPath").onclick = async () => {
    $("#err").innerHTML = "";
    try {
      const r = await post(`/api/calls/${call.id}/context`, { kind: "path", path: $("#path").value.trim() });
      $("#path").value = "";
      paint(r.sources);
    } catch (e) { fail(e); }
  };
  $("#addPaste").onclick = async () => {
    $("#err").innerHTML = "";
    try {
      const r = await post(`/api/calls/${call.id}/context`, {
        kind: "paste", label: $("#plabel").value.trim() || "pasted", text: $("#ptext").value,
      });
      $("#ptext").value = ""; $("#plabel").value = "";
      paint(r.sources);
    } catch (e) { fail(e); }
  };
  $("#prep").onclick = async () => {
    $("#prep").disabled = true;
    $("#spin").textContent = $("#research").checked
      ? "Reading your context, researching what it does not cover, then proposing topics…"
      : "Reading your context, checking it against itself, then proposing topics — no external research…";
    try {
      await post(`/api/calls/${call.id}/prepare`);
      showCall(call.id);
    } catch (e) { fail(e); $("#prep").disabled = false; $("#spin").textContent = ""; }
  };
}

/* ---------------------------------------------------------------- 2 agenda */

function stageAgenda(call) {
  const a = call.agenda;
  view.innerHTML = `<div class="wrap">
    ${steps("agenda")}
    <h1>${esc(a.title)}</h1>
    <p class="sub">Proposed from your context. Edit anything, drop what you don't need, then start the call.</p>

    ${a.rules?.length ? `<div class="note"><b>Standing rules — these outrank the agenda</b>
      <ul>${a.rules.map((r) => `<li>${esc(r)}</li>`).join("")}</ul></div>` : ""}

    <div id="qs"></div>

    <h2>What the engine did with your context</h2>
    ${call.augment?.researched === false ? `<p class="sub">External research was off — nothing below comes from outside your material.</p>` : ""}
    ${panel("This doesn't hold up", call.augment?.validations, "warn", (v) =>
      `<b>${esc(v.issue)}</b> <span class="tag">${esc(v.severity)}</span><br />${esc(v.detail)}<br /><span class="m">Settle it: ${esc(v.howToSettle)}</span>`)}
    ${panel("Added — researched, not from your files", call.augment?.augmentations, "", (a) =>
      `<b>${esc(a.point)}</b> <span class="tag">${esc(a.confidence)}</span><br />${esc(a.detail)}<br /><span class="m">${esc(a.basis)}${
        safeUrl(a.source) ? ` · <a href="${esc(safeUrl(a.source))}" target="_blank" rel="noopener noreferrer">source</a>` : ""}</span>`)}
    ${panel("Derived from your own numbers", call.augment?.derivedFacts, "", (f) =>
      `<b>${esc(f.fact)}:</b> ${esc(f.value)}<br /><span class="m">${esc(f.basis)}</span>`)}
    ${panel("Still missing from your context", call.gaps, "warn", (g) => esc(g))}



    <h2>Start the call</h2>
    <div class="card">
      <p style="margin:0 0 10px">Go live, pick the microphone, and press <b>Start listening</b>. Take the call on another
      device with its speakers on — or sit in the room with this machine. It transcribes locally; the audio never leaves here.</p>
      <p class="m" style="margin:0">Prefer a terminal? <span class="mono">node listen.mjs ${esc(call.id)}</span> does the same thing.</p>
    </div>
    <div class="row" style="margin-top:16px"><button id="go">Go live →</button></div>
  </div>`;

  const paint = () => {
    const byTopic = {};
    for (const q of a.questions) (byTopic[q.topic] ??= []).push(q);
    $("#qs").innerHTML = Object.entries(byTopic)
      .map(
        ([t, qs]) => `<div class="topic">${esc(t)}</div>` + qs.map((q) => `
        <div class="q" data-id="${esc(q.id)}">
          <div class="qs">${esc(q.short)}</div>
          <div class="qd">
            <p><b>Ask:</b> ${esc(q.ask)}</p>
            <p><b>Why:</b> ${esc(q.why)}</p>
            <p><b>Answered when:</b> ${esc(q.answeredWhen)}</p>
            <p><b>A dodge looks like:</b> ${esc(q.dodgeLooksLike)}</p>
            <p><b>Follow up:</b> ${esc(q.followUp)}</p>
            <button class="danger" data-drop="${esc(q.id)}" style="padding:3px 9px;font-size:12px">Remove question</button>
          </div>
        </div>`).join(""),
      )
      .join("");
    $("#qs").querySelectorAll(".q").forEach((el) => {
      el.querySelector(".qs").onclick = () => el.classList.toggle("open");
    });
    $("#qs").querySelectorAll("button[data-drop]").forEach((b) => {
      b.onclick = async () => {
        a.questions = a.questions.filter((q) => q.id !== b.dataset.drop);
        await api(`/api/calls/${call.id}/agenda`, {
          method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agenda: a }),
        });
        paint();
      };
    });
  };
  paint();

  $("#go").onclick = async () => {
    await api(`/api/calls/${call.id}/agenda`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agenda: a, stage: "live" }),
    });
    showCall(call.id);
  };
}

/* ------------------------------------------------------------------ 3 live */

function stageLive(call) {
  const answered = new Set(call.answered);
  view.innerHTML = `<div class="wrap wide">
    ${steps("live")}
    <div class="row" style="justify-content:space-between;margin-bottom:12px">
      <div><b>${esc(call.title)}</b> <span class="m">· ${esc(call.who || "")}</span></div>
      <div class="row">
        <span class="spin" id="conn">connecting…</span>
        <span class="spin" id="lines">${call.lines?.length ?? 0} lines</span>
        <button class="ghost" id="force">Check now</button>
        <button id="end">End &amp; debrief</button>
      </div>
    </div>
    <div class="earbar" id="earbar">
      <span class="dot" id="eardot"></span>
      <span id="earstate">Not listening</span>
      <select id="micsel" title="Microphone"><option value="">Default microphone</option></select>
      <button id="listen">Start listening</button>
      <span class="heard" id="heard"></span>
      <button class="ghost small" id="mic" title="Fallback: sends audio to your browser vendor">Browser mic instead</button>
    </div>
    <div class="liveboard">
      <div><h2>Agenda</h2><div id="qs"></div></div>
      <div><h2>Live</h2><div id="flags"></div></div>
    </div>
    <div id="say" class="idle">Listening — nothing worth interrupting for.</div>
    <div id="err"></div>
  </div>`;

  const paintQs = () => {
    const byTopic = {};
    for (const q of call.agenda.questions) (byTopic[q.topic] ??= []).push(q);
    $("#qs").innerHTML = Object.entries(byTopic)
      .map(([t, qs]) => `<div class="topic">${esc(t)}</div>` + qs.map((q) => `
        <div class="q ${answered.has(q.id) ? "done" : ""}" data-id="${esc(q.id)}">
          <div class="qs">${answered.has(q.id) ? "✓ " : ""}${esc(q.short)}</div>
          <div class="qd"><p><b>Ask:</b> ${esc(q.ask)}</p><p><b>Answered when:</b> ${esc(q.answeredWhen)}</p>
          <p><b>Follow up:</b> ${esc(q.followUp)}</p></div>
        </div>`).join(""))
      .join("");
    $("#qs").querySelectorAll(".q").forEach((el) => {
      el.querySelector(".qs").onclick = (e) => {
        if (e.shiftKey) {
          answered.add(el.dataset.id);
          post(`/api/calls/${call.id}/answered`, { id: el.dataset.id });
          paintQs();
        } else el.classList.toggle("open");
      };
    });
  };
  paintQs();

  const addFlag = (f) => {
    const d = document.createElement("div");
    d.className = "flag " + f.kind;
    d.innerHTML = `<div class="fl">${esc(f.label)}</div><div class="fq">${esc(f.quote ?? "")}</div>`;
    $("#flags").prepend(d);
    if (f.questionId) $(`.q[data-id="${CSS.escape(f.questionId)}"]`)?.classList.add("hot");
  };
  (call.flags ?? []).forEach(addFlag);

  const setSay = (t) => {
    const el = $("#say");
    if (!t) { el.textContent = "Listening — nothing worth interrupting for."; el.className = "idle"; return; }
    el.textContent = "“" + t + "”";
    el.className = "";
  };
  setSay(call.sayNext);

  // The local ear — the server runs listen.mjs; audio stays on this machine.
  let listening = false;
  const paintEar = (st) => {
    listening = !!(st.on && st.mine !== false);
    $("#eardot").className = "dot" + (listening ? " on" : "");
    $("#earstate").textContent = listening
      ? `Listening · ${st.device || "microphone"} · on this machine`
      : st.on && st.mine === false ? "The mic is in use by another call" : "Not listening";
    $("#listen").textContent = listening ? "Stop listening" : "Start listening";
    $("#listen").className = listening ? "danger" : "";
    $("#micsel").disabled = listening;
    if (st.heard) $("#heard").textContent = `heard: “${st.heard}”`;
  };
  api("/api/microphones").then(({ microphones, problems }) => {
    for (const m of microphones) $("#micsel").insertAdjacentHTML("beforeend", `<option value="${esc(m.id)}">${esc(m.name)}</option>`);
    if (problems.length) {
      $("#listen").disabled = true;
      $("#err").innerHTML = `<div class="err">Can't listen on this machine yet:\n${esc(problems.join("\n"))}</div>`;
    }
  }).catch(() => {});
  $("#listen").onclick = async () => {
    $("#err").innerHTML = "";
    $("#listen").disabled = true;
    try {
      const sel = $("#micsel");
      paintEar(await post(`/api/calls/${call.id}/listen`, listening
        ? { on: false }
        : { on: true, device: sel.value, deviceName: sel.selectedOptions[0]?.textContent }));
    } catch (e) { $("#err").innerHTML = `<div class="err">${esc(e.message)}</div>`; }
    $("#listen").disabled = false;
  };

  const es = new EventSource(`/api/calls/${call.id}/events`);
  es.onopen = () => ($("#conn").textContent = "live");
  es.onerror = () => ($("#conn").textContent = "disconnected");
  let n = call.lines?.length ?? 0;
  es.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === "line") { $("#lines").textContent = `${++n} lines`; $("#heard").textContent = `heard: “${m.text}”`; }
    if (m.type === "ear") {
      paintEar(m);
      if (m.error) $("#err").innerHTML = `<div class="err">${esc(m.error)}</div>`;
      else if (m.warning) $("#err").innerHTML = `<div class="note warn">${esc(m.warning)}</div>`;
    }
    if (m.type === "flag") addFlag(m.flag);
    if (m.type === "answered") { answered.add(m.id); paintQs(); }
    if (m.type === "sayNext") setSay(m.text);
    if (m.type === "error") $("#err").innerHTML = `<div class="err">${esc(m.message)}</div>`;
  };

  // Browser mic is the fallback when the local ear isn't running. It uses the
  // platform speech API, which sends audio to the browser vendor — said plainly
  // rather than buried, because that is a real difference for these calls.
  let recog = null;
  $("#mic").onclick = () => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return ($("#err").innerHTML = `<div class="err">No speech API here — use node listen.mjs instead.</div>`);
    if (recog) { recog.stop(); recog = null; $("#mic").textContent = "Browser mic instead"; return; }
    recog = new SR();
    recog.continuous = true; recog.interimResults = false; recog.lang = "en-US";
    recog.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++)
        if (e.results[i].isFinal)
          post(`/api/calls/${call.id}/line`, { text: e.results[i][0].transcript.trim(), speaker: "room" });
    };
    recog.onend = () => { if (recog) recog.start(); };
    recog.start();
    $("#mic").textContent = "Stop browser mic";
    if (listening) post(`/api/calls/${call.id}/listen`, { on: false }).then(paintEar);
    $("#err").innerHTML = `<div class="note warn">Browser mic on — this one sends audio to your browser vendor. The local ear (<span class="mono">node listen.mjs ${call.id}</span>) does not.</div>`;
  };

  $("#force").onclick = () => post(`/api/calls/${call.id}/analyze`);
  $("#end").onclick = async () => {
    if (!confirm("End the call and write the debrief?")) return;
    $("#end").textContent = "Writing…"; $("#end").disabled = true;
    try { await post(`/api/calls/${call.id}/debrief`); es.close(); showCall(call.id); }
    catch (e) { $("#err").innerHTML = `<div class="err">${esc(e.message)}</div>`; $("#end").disabled = false; $("#end").textContent = "End & debrief"; }
  };
}

/* --------------------------------------------------------------- 4 debrief */

function stageDebrief(call) {
  view.innerHTML = `<div class="wrap">
    ${steps("debrief")}
    <div class="row" style="justify-content:space-between;margin-bottom:14px">
      <h1 style="margin:0">${esc(call.title)}</h1>
      <div class="row">
        <button class="ghost" id="copy">Copy Markdown</button>
        <button class="ghost" data-go="#/">Done</button>
      </div>
    </div>
    <p class="sub">Saved to <span class="mono">data/calls/${call.id}/debrief.md</span>, with the transcript beside it.</p>
    <div class="md" id="md"></div>
  </div>`;
  $("#md").innerHTML = md(call.debrief);
  $("#copy").onclick = async () => {
    await navigator.clipboard.writeText(call.debrief);
    $("#copy").textContent = "Copied";
    setTimeout(() => ($("#copy").textContent = "Copy Markdown"), 1800);
  };
}

/* Small Markdown renderer — headings, lists, tables, quotes, bold, code. */
function md(src) {
  const inline = (s) =>
    esc(s)
      .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
      .replace(/(^|[\s(])\*([^*]+)\*/g, "$1<i>$2</i>")
      .replace(/`([^`]+)`/g, "<code>$1</code>");
  const out = [];
  let list = null, tbl = null;
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  const closeTbl = () => { if (tbl) { out.push("</tbody></table>"); tbl = null; } };

  for (const raw of String(src).split("\n")) {
    const line = raw.trimEnd();
    if (/^\|/.test(line)) {
      const cells = line.split("|").slice(1, -1).map((c) => c.trim());
      if (/^\|[\s|:-]+\|?$/.test(line)) continue;
      if (!tbl) { closeList(); out.push(`<table><thead><tr>${cells.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>`); tbl = 1; }
      else out.push(`<tr>${cells.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`);
      continue;
    }
    closeTbl();
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { closeList(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue; }
    const ol = line.match(/^\s*\d+\.\s+(.*)$/);
    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    if (ol || ul) {
      const want = ol ? "ol" : "ul";
      if (list !== want) { closeList(); out.push(`<${want}>`); list = want; }
      out.push(`<li>${inline((ol || ul)[1])}</li>`);
      continue;
    }
    closeList();
    if (/^>\s?/.test(line)) { out.push(`<blockquote>${inline(line.replace(/^>\s?/, ""))}</blockquote>`); continue; }
    if (/^---+$/.test(line)) { out.push("<hr />"); continue; }
    if (!line.trim()) continue;
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList(); closeTbl();
  return out.join("\n");
}

route();
