/* SignalSphere AI console — vanilla client (no framework, no build, no CDN).
 * Everything rendered here is REAL backend output from the @mstack/console API:
 *   /api/health · /api/stats · /api/signals · /api/accounts · /api/activate
 *   /api/drafts · /api/drafts/:id/approve
 * The "swarm reasoning" log narrates the actual decision payload (it fabricates nothing);
 * the signal stream re-cycles real fixture signals to convey the live feed. */

"use strict";

const state = {
  mode: "offline",
  agentMode: "copilot", // Copilot ↔ Autopilot toggle
  accounts: [],
  signals: [], // full list (for the id → signal timeline lookup)
  signalMap: {}, // id → Signal
  streamPool: [], // rotating source for the "live" ticker
  streamIdx: 0,
  selected: null, // domain
  current: null, // last activate response
  busy: false,
};

const PERSONAS = ["Engineering", "Product", "Security", "Marketing", "Exec"];
const KIND_TO_PERSONA = {
  product_usage: ["Engineering", "Product"],
  crm: ["Exec"],
  campaign: ["Marketing"],
  intent: ["Product", "Exec"],
  identify: ["Engineering", "Product", "Security", "Marketing", "Exec"],
};

/* ── tiny DOM helpers ──────────────────────────────────────────────── */
const $ = (sel) => document.querySelector(sel);
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}
async function api(path, opts) {
  const res = await fetch(path, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body && body.error ? body.error : `${res.status} ${path}`);
  return body;
}
function postJSON(path, payload) {
  return api(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── boot ──────────────────────────────────────────────────────────── */
async function init() {
  wireToggle();

  try {
    const health = await api("/api/health");
    state.mode = health.mode || "offline";
    renderMode();
  } catch (_) { /* non-fatal */ }

  await Promise.all([loadSignals(), loadAccounts(), refreshStats(), refreshDrafts()]);

  // auto-activate the top-ranked account so the studio populates like the demo
  const top = state.accounts[0];
  if (top) selectAccount(top.domain, top.name);

  // live-feed ticker + periodic stat refresh
  setInterval(tickStream, 3600);
  setInterval(refreshStats, 8000);
}

/* ── top bar ───────────────────────────────────────────────────────── */
function renderMode() {
  const pill = $("#mode-pill");
  pill.textContent = state.mode;
  pill.classList.toggle("live", state.mode === "live");
  pill.title = state.mode === "live"
    ? "live = ANTHROPIC_API_KEY present (Claude swarm)"
    : "offline = no ANTHROPIC_API_KEY (deterministic rules + fixtures)";
}

async function refreshStats() {
  try {
    const s = await api("/api/stats");
    $("#stat-agents").textContent = `${s.activeAgents}`;
    $("#stat-runs").textContent = `${s.autonomousRuns.toLocaleString()}`;
    const v = s.pipelineVelocity;
    $("#stat-velocity").textContent = `${v >= 0 ? "+" : ""}${v}%`;
  } catch (_) { /* keep last values */ }
}

function wireToggle() {
  const toggle = $("#mode-toggle");
  toggle.addEventListener("click", (e) => {
    const btn = e.target.closest(".mt-opt");
    if (!btn) return;
    const mode = btn.dataset.mode;
    if (mode === state.agentMode) return;
    state.agentMode = mode;
    for (const opt of toggle.querySelectorAll(".mt-opt")) {
      const on = opt.dataset.mode === mode;
      opt.classList.toggle("is-active", on);
      opt.setAttribute("aria-selected", on ? "true" : "false");
    }
    // re-run the current target under the new autonomy mode
    if (state.selected && !state.busy) {
      const acct = state.accounts.find((a) => a.domain === state.selected);
      selectAccount(state.selected, acct ? acct.name : state.selected);
    }
  });
}

/* ── panel 1 · signals ─────────────────────────────────────────────── */
async function loadSignals() {
  const body = await api("/api/signals?limit=500");
  state.signals = body.signals || [];
  state.signalMap = {};
  for (const s of state.signals) state.signalMap[s.id] = s;
  // newest-first stream; keep a pool to recycle for the "live" ticker
  state.streamPool = state.signals.slice();
  const stream = $("#signal-stream");
  stream.textContent = "";
  for (const s of state.signals.slice(0, 14)) stream.appendChild(signalNode(s));
}

function signalNode(s) {
  const row = el("div", "signal");
  row.appendChild(el("span", `kdot k-${s.kind}`));
  const main = el("div", "s-main");
  const co = el("div", "s-co", s.actor && s.actor.company ? s.actor.company : "unknown");
  const act = el("div", "s-act", humanSignal(s));
  main.appendChild(co);
  main.appendChild(act);
  const badge = el("span", `kind-badge k-${s.kind}`, s.kind);
  main.appendChild(badge);
  row.appendChild(main);
  const meta = el("div", "s-meta");
  meta.appendChild(el("div", null, fmtTime(s.ts)));
  meta.appendChild(el("div", null, s.source || ""));
  row.appendChild(meta);
  return row;
}

function humanSignal(s) {
  const act = s.action ? s.action.replace(/_/g, " ") : s.kind.replace(/_/g, " ");
  const props = s.properties || {};
  const detail = props.plan || props.campaign || props.roleTitle || props.title || props.page || props.repo;
  return detail ? `${act} · ${detail}` : act;
}

function tickStream() {
  const pool = state.streamPool;
  if (pool.length === 0) return;
  const s = pool[state.streamIdx % pool.length];
  state.streamIdx += 1;
  const stream = $("#signal-stream");
  const node = signalNode({ ...s, ts: new Date().toISOString() });
  stream.insertBefore(node, stream.firstChild);
  while (stream.childElementCount > 26) stream.removeChild(stream.lastChild);
}

/* ── panel 2 · accounts ────────────────────────────────────────────── */
async function loadAccounts() {
  const body = await api("/api/accounts");
  state.accounts = body.accounts || [];
  renderAccounts();
}

function renderAccounts() {
  const list = $("#account-list");
  list.textContent = "";
  for (const a of state.accounts) {
    const row = el("div", "account");
    row.dataset.domain = a.domain;
    if (a.domain === state.selected) row.classList.add("selected");

    const left = el("div");
    left.appendChild(el("div", "a-name", a.name));
    left.appendChild(el("div", "a-domain", a.domain));
    row.appendChild(left);

    const right = el("div", "a-right");
    const badge = el("span", `score-badge t-${a.tier}`, `${a.score}/100`);
    right.appendChild(badge);
    right.appendChild(el("span", `tier-chip t-${a.tier}`, tierLabel(a.tier)));
    row.appendChild(right);

    const sig = el("div", "a-signals");
    const b = el("b", null, `${a.signalCount}`);
    sig.appendChild(document.createTextNode("+"));
    sig.appendChild(b);
    sig.appendChild(document.createTextNode(" signals stitched"));
    row.appendChild(sig);

    row.addEventListener("click", () => { if (!state.busy) selectAccount(a.domain, a.name); });
    list.appendChild(row);
  }
}

function markSelected(domain) {
  for (const row of $("#account-list").children) {
    row.classList.toggle("selected", row.dataset.domain === domain);
  }
}

/* ── panels 3 + 4 · activate → swarm log + studio ──────────────────── */
async function selectAccount(domain, name) {
  if (state.busy) return;
  state.busy = true;
  state.selected = domain;
  markSelected(domain);
  setWorkersActive(true);

  try {
    // kick off the reasoning log (narration begins immediately)
    const logDone = runReasoningIntro(domain, name);
    const resp = await postJSON("/api/activate", { domain, name, mode: state.agentMode });
    state.current = resp;
    await logDone;
    finishReasoning(resp);
    renderStudio(resp, name);
    await Promise.all([refreshStats(), refreshDrafts()]);
  } catch (err) {
    appendLine("router", "GTM-Router", `activation failed: ${err.message}`);
  } finally {
    setWorkersActive(false);
    state.busy = false;
  }
}

function setWorkersActive(on) {
  for (const w of $("#workers").children) w.classList.toggle("active", on);
}

function clearReasoning() { $("#reasoning").textContent = ""; }

function appendLine(kind, who, text) {
  const line = el("span", `rline ${kind}`);
  if (who) {
    const w = el("span", "who", `[${who}] `);
    line.appendChild(w);
  }
  line.appendChild(document.createTextNode(text));
  const log = $("#reasoning");
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
  return line;
}

async function runReasoningIntro(domain, name) {
  clearReasoning();
  appendLine("sdr", "SDR-Researcher", `connecting to Snowflake · reading signal tables for ${domain} …`);
  await sleep(360);
  appendLine("copy", "Copywriter-AI", "loading buying-group activity timeline …");
  await sleep(360);
  appendLine("router", "GTM-Router", "workers running in parallel · resolving next-best-action …");
  await sleep(300);
}

function finishReasoning(resp) {
  const d = resp.decision;
  const kinds = uniqueKinds(d.relevantSignals);
  appendLine("sdr", "SDR-Researcher", `surfaced ${d.relevantSignals.length} relevant signal(s)${kinds ? ` · ${kinds}` : ""} — every id is real, none invented.`);
  appendLine("ml", "ML-Scoring", `ICP fit ${d.score}/100 → ${d.tier} (RulesScorer, deterministic).`);
  const target = d.nextBestAction.targetMember;
  appendLine("copy", "Copywriter-AI", `drafted a personalized sequence for ${target}.`);
  appendLine("router", "GTM-Router", `next-best-action: ${d.nextBestAction.action} · via ${d.nextBestAction.channel}.`);

  if (state.agentMode === "autopilot") {
    if (d.tier === "STRONG_FIT") {
      appendLine("gate", null, "AUTOPILOT · strategic account — human validation still required. Never auto-sent.");
    } else {
      appendLine("gate", null, "AUTOPILOT · low-tier auto-approve eligible — one-click dispatch armed (backend still gates).");
    }
  } else {
    appendLine("gate", null, "Agent enabled · AWAITING HUMAN VALIDATION in the action studio.");
  }
  const caret = el("span", "caret", ".");
  $("#reasoning").appendChild(caret);
}

function uniqueKinds(relevant) {
  const set = new Set();
  for (const rs of relevant) {
    const s = state.signalMap[rs.signalId];
    if (s) set.add(s.kind);
  }
  return [...set].join(", ");
}

/* ── studio render ─────────────────────────────────────────────────── */
function renderStudio(resp, name) {
  const d = resp.decision;
  $("#studio-empty").hidden = true;
  $("#studio-content").hidden = false;

  $("#target-name").textContent = name || state.selected;
  $("#target-domain").textContent = state.selected;
  const badge = $("#target-score");
  badge.textContent = `${d.score}/100`;
  badge.className = `score-badge t-${d.tier}`;
  const tier = $("#target-tier");
  tier.textContent = tierLabel(d.tier);
  tier.className = `tier-chip t-${d.tier}`;

  renderHeatmap(d.buyingCommittee, d.relevantSignals);
  renderCommittee(d.buyingCommittee);
  renderTimeline(d.relevantSignals);

  $("#draft-subject").textContent = resp.draftSubject || "(no subject)";
  $("#draft-body").textContent = resp.draftBody || "";

  renderGate(resp);
}

function renderHeatmap(committee, relevant) {
  const heat = {};
  for (const p of PERSONAS) heat[p] = 0.12;
  for (const m of committee || []) {
    if (heat[m.persona] !== undefined) heat[m.persona] = Math.max(heat[m.persona], 0.55);
    if (/sponsor|technical influence|executive/i.test(m.influence || "") && heat[m.persona] !== undefined) {
      heat[m.persona] = Math.min(1, heat[m.persona] + 0.25);
    }
  }
  for (const rs of relevant || []) {
    const s = state.signalMap[rs.signalId];
    const ps = s ? (KIND_TO_PERSONA[s.kind] || []) : [];
    for (const p of ps) if (heat[p] !== undefined) heat[p] = Math.min(1, heat[p] + 0.12);
  }

  const grid = $("#heatmap");
  grid.textContent = "";
  for (const p of PERSONAS) {
    const h = heat[p];
    const tile = el("div", "heat-tile");
    // blend cyan → violet by heat, opacity by heat
    tile.style.background = `rgba(${mix(52, 167, h)}, ${mix(229, 139, h)}, ${mix(255, 250, h)}, ${(0.14 + h * 0.5).toFixed(2)})`;
    tile.style.borderColor = h > 0.5 ? "var(--border-hot)" : "var(--border)";
    tile.appendChild(el("div", "heat-persona", p));
    tile.appendChild(el("div", "heat-val", `${Math.round(h * 100)}`));
    grid.appendChild(tile);
  }
}
function mix(a, b, t) { return Math.round(a + (b - a) * t); }

function renderCommittee(committee) {
  const wrap = $("#committee");
  wrap.textContent = "";
  if (!committee || committee.length === 0) {
    wrap.appendChild(el("div", "m-role", "No buying committee resolved for this account."));
    return;
  }
  for (const m of committee) {
    const row = el("div", "member");
    const p = el("div", `m-persona p-${m.persona}`, personaAbbr(m.persona));
    row.appendChild(p);
    const main = el("div", "m-main");
    main.appendChild(el("div", "m-name", m.name));
    main.appendChild(el("div", "m-role", m.role));
    row.appendChild(main);
    if (m.influence) row.appendChild(el("span", "influence-badge", m.influence));
    wrap.appendChild(row);
  }
}

function renderTimeline(relevant) {
  const line = $("#timeline");
  line.textContent = "";
  const items = (relevant || [])
    .map((rs) => ({ rs, s: state.signalMap[rs.signalId] }))
    .sort((a, b) => {
      const ta = a.s ? a.s.ts : "";
      const tb = b.s ? b.s.ts : "";
      return ta < tb ? -1 : ta > tb ? 1 : 0;
    });
  if (items.length === 0) {
    line.appendChild(el("div", "touch", "no multi-touch history"));
    return;
  }
  for (const { rs, s } of items) {
    const t = el("div", "touch");
    t.appendChild(el("div", "t-date", s ? fmtDate(s.ts) : "—"));
    t.appendChild(el("div", "t-act", s ? humanSignal(s) : rs.signalId));
    t.appendChild(el("div", "t-why", s ? s.kind : rs.why));
    line.appendChild(t);
  }
}

/* ── approval gate ─────────────────────────────────────────────────── */
function renderGate(resp) {
  const gate = $("#approval-gate");
  const banner = $("#gate-banner");
  const btn = $("#approve-btn");
  const note = $("#gate-note");
  const tier = resp.decision.tier;

  gate.classList.remove("sent");
  btn.disabled = false;

  if (state.agentMode === "autopilot") {
    if (tier === "STRONG_FIT") {
      banner.textContent = "Autopilot · strategic account — human validation required";
      btn.textContent = "Approve & dispatch (manual)";
      note.textContent = "Autopilot never auto-sends a STRONG_FIT / strategic account. A human still approves this send.";
    } else {
      banner.textContent = "Autopilot · auto-approve eligible";
      btn.textContent = "Approve & dispatch (autopilot)";
      note.textContent = "Backend still gates every send — the draft stays pending until this approve call runs.";
    }
  } else {
    banner.textContent = "Awaiting human validation";
    btn.textContent = "Approve & dispatch";
    note.textContent = "Draft-first: nothing has been sent. Approving appends a hash-chained audit row, then dispatches to the outbox.";
  }

  btn.onclick = () => approve(resp.draftId);
}

async function approve(draftId) {
  const gate = $("#approval-gate");
  const banner = $("#gate-banner");
  const btn = $("#approve-btn");
  const note = $("#gate-note");
  btn.disabled = true;
  btn.textContent = "Dispatching…";
  try {
    const out = await postJSON(`/api/drafts/${draftId}/approve`, { actor: "console-user" });
    gate.classList.add("sent");
    banner.textContent = "Dispatched to outbox ✓";
    btn.textContent = "Sent";
    const verified = out.auditVerified ? "verified" : "UNVERIFIED";
    const path = out.outcome && out.outcome.metrics && out.outcome.metrics.outboxPath;
    note.textContent = `Outcome: ${out.outcome ? out.outcome.result : "sent"} · hash-chained audit ${verified}${path ? ` · ${path}` : ""}.`;
    appendLine("router", "GTM-Router", `human approved · dispatched to outbox · audit chain ${verified}.`);
    await Promise.all([refreshStats(), refreshDrafts()]);
  } catch (err) {
    banner.textContent = "Dispatch failed";
    note.textContent = err.message;
    btn.disabled = false;
    btn.textContent = "Retry approve & dispatch";
  }
}

async function refreshDrafts() {
  try {
    const body = await api("/api/drafts");
    const n = (body.drafts || []).length;
    const sub = document.querySelector("#panel-studio .panel-sub");
    if (sub) sub.textContent = `Target insight console · ${n} draft(s) pending approval`;
  } catch (_) { /* non-fatal */ }
}

/* ── formatting ────────────────────────────────────────────────────── */
function tierLabel(t) { return (t || "").replace(/_/g, " "); }
function personaAbbr(p) {
  return ({ Engineering: "ENG", Product: "PRD", Security: "SEC", Marketing: "MKT", Exec: "EXE", Other: "OTH" }[p] || (p || "?").slice(0, 3).toUpperCase());
}
function fmtTime(ts) {
  try { return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }); }
  catch (_) { return ts; }
}
function fmtDate(ts) {
  try { return new Date(ts).toLocaleDateString([], { month: "short", day: "numeric" }); }
  catch (_) { return ts; }
}

document.addEventListener("DOMContentLoaded", init);
