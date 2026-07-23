/* Console — vanilla client (no framework, no build, no CDN). Same-origin /api/* only.
 * Every rendered value is bound to a REAL field returned by apps/console/src/server.ts:
 *   GET  /api/health           -> { ok, mode }
 *   GET  /api/stats            -> ConsoleStats { activeAgents, autonomousRuns, pipelineVelocity,
 *                                  signals, accounts, decisions, drafts, approvals }
 *   GET  /api/signals?limit=N  -> { mode, signals: Signal[] }
 *                                  Signal: { id, ts, source, kind,
 *                                            actor:{userId?,anonId?,email?,company?,handle?}, action? }
 *   GET  /api/accounts         -> { mode, accounts: RankedAccountView[] }
 *                                  RankedAccountView: { domain, name, score, tier, signalCount }
 *                                  (no id / firmographic.industry / next-best-action at THIS endpoint —
 *                                   next-best-action only appears after POST /api/activate)
 *   POST /api/activate {domain,name?,mode?}
 *                              -> { mode, decision:{ accountId, ts, score, tier, relevantSignals[],
 *                                   buyingCommittee[], nextBestAction:{action,channel,targetMember},
 *                                   rationale, byAgent, agentMode }, draftId, draftSubject, draftBody }
 *   GET  /api/drafts           -> { drafts: [{id,kind,refId,subject,body,status,createdAt,createdBy}] }
 *                                  (no channel at THIS endpoint)
 *   POST /api/drafts/:id/approve -> { ok, dispatched, draftId, outcome, auditVerified }
 *                                  (404 = no such draft, 409 = already dispatched)
 */

"use strict";

const state = {
  mode: "offline",
  agentMode: "copilot",
  accounts: [],
  drafts: [],
  armTimers: {}, // draftId -> auto-revert timeout handle (arm window only)
  inFlight: new Set(), // draftIds currently armed OR mid-send — protected from the periodic re-render
};

const ARM_WINDOW_MS = 7000;
const TOAST_MS = 4000;

/* ── tiny DOM + fetch helpers ──────────────────────────────────────── */
const $ = (sel) => document.querySelector(sel);

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = text;
  return n;
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  let body = {};
  try {
    body = await res.json();
  } catch (_) {
    /* empty / non-JSON body */
  }
  if (!res.ok) {
    const err = new Error((body && body.error) || `${res.status} ${path}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

function postJSON(path, payload) {
  return api(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
}

let toastTimer = null;
function toast(message, isError) {
  const t = $("#toast");
  t.textContent = message;
  t.classList.toggle("is-error", Boolean(isError));
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.hidden = true;
  }, TOAST_MS);
}

/* ── boot ──────────────────────────────────────────────────────────── */
async function init() {
  wireAgentToggle();

  try {
    const health = await api("/api/health");
    state.mode = health.mode || "offline";
  } catch (_) {
    /* non-fatal — mode pill stays at its default */
  }
  renderMode();

  await Promise.all([loadStats(), loadSignals(), loadAccounts(), loadDrafts()]);

  setInterval(loadStats, 8000);
  setInterval(loadDrafts, 6000);
}

function renderMode() {
  const pill = $("#mode-pill");
  pill.textContent = state.mode;
  pill.classList.toggle("live", state.mode === "live");
}

function wireAgentToggle() {
  const toggle = $("#agent-toggle");
  toggle.addEventListener("click", (e) => {
    const btn = e.target.closest(".at-opt");
    if (!btn) return;
    const mode = btn.dataset.mode;
    if (mode === state.agentMode) return;
    state.agentMode = mode;
    for (const opt of toggle.querySelectorAll(".at-opt")) {
      const on = opt.dataset.mode === mode;
      opt.classList.toggle("is-active", on);
      opt.setAttribute("aria-selected", on ? "true" : "false");
    }
  });
}

/* ── 01 · funnel (hero) ────────────────────────────────────────────── */
async function loadStats() {
  try {
    const s = await api("/api/stats");
    renderChips(s);
    renderFunnel(s);
  } catch (_) {
    /* keep last-rendered values on transient failure */
  }
}

function renderChips(s) {
  $("#chip-agents").textContent = String(s.activeAgents);
  $("#chip-runs").textContent = Number(s.autonomousRuns).toLocaleString();
  const v = s.pipelineVelocity;
  $("#chip-velocity").textContent = `${v >= 0 ? "+" : ""}${v}%`;
}

/** The 5 sequential pipeline counts from ConsoleStats, shown as a horizontal flow with
 * conversion % between adjacent stages. activeAgents/autonomousRuns/pipelineVelocity are
 * system throughput stats (see server.ts's own "top-bar stat chips" comment on deriveStats)
 * and are rendered separately above as chips, not as funnel stages with false conversions. */
function renderFunnel(s) {
  const stages = [
    { label: "Signals", count: s.signals },
    { label: "Accounts", count: s.accounts },
    { label: "Decisions", count: s.decisions },
    { label: "Drafts", count: s.drafts },
    { label: "Approvals", count: s.approvals },
  ];
  const max = Math.max(1, ...stages.map((st) => st.count));
  const flow = $("#funnel-flow");
  flow.textContent = "";
  stages.forEach((st, i) => {
    if (i > 0) {
      const prev = stages[i - 1].count;
      const conv = el("div", "funnel-conv");
      conv.appendChild(el("span", "fc-arrow", "→"));
      conv.appendChild(el("span", "fc-pct", prev > 0 ? `${Math.round((st.count / prev) * 100)}%` : "—"));
      flow.appendChild(conv);
    }
    const stage = el("div", "funnel-stage");
    stage.appendChild(el("div", "fs-label", st.label));
    const track = el("div", "fs-bar-track");
    const fill = el("div", "fs-bar-fill");
    const pct = Math.max(Math.round((st.count / max) * 100), 3);
    fill.style.setProperty("--pct", `${pct}%`);
    track.appendChild(fill);
    stage.appendChild(track);
    stage.appendChild(el("div", "fs-count", Number(st.count).toLocaleString()));
    flow.appendChild(stage);
  });
}

/* ── 02 · signals ──────────────────────────────────────────────────── */
async function loadSignals() {
  const body = $("#signals-body");
  try {
    const resp = await api("/api/signals?limit=40");
    const signals = resp.signals || [];
    body.textContent = "";
    if (signals.length === 0) {
      body.appendChild(emptyRow(5, "No signals ingested yet. Run mstack seed to load the sample stream."));
      return;
    }
    for (const s of signals) body.appendChild(signalRow(s));
  } catch (err) {
    body.textContent = "";
    body.appendChild(emptyRow(5, `Couldn't load signals: ${err.message}`));
  }
}

function actorLabel(actor) {
  if (!actor) return "—";
  return actor.company || actor.email || actor.handle || actor.userId || actor.anonId || "—";
}

function signalRow(s) {
  const row = el("tr");
  row.appendChild(el("td", "mono", s.source || "—"));
  row.appendChild(el("td", "mono", s.kind || "—"));
  row.appendChild(el("td", "mono", actorLabel(s.actor)));
  row.appendChild(el("td", "mono", s.action || "—"));
  row.appendChild(el("td", "mono", fmtTime(s.ts)));
  return row;
}

/* ── 03 · accounts ─────────────────────────────────────────────────── */
async function loadAccounts() {
  const body = $("#accounts-body");
  try {
    const resp = await api("/api/accounts");
    state.accounts = resp.accounts || [];
    body.textContent = "";
    if (state.accounts.length === 0) {
      body.appendChild(emptyRow(6, "No accounts resolved yet. Run mstack seed to build the account universe."));
      return;
    }
    for (const a of state.accounts) body.appendChild(accountRow(a));
  } catch (err) {
    body.textContent = "";
    body.appendChild(emptyRow(6, `Couldn't load accounts: ${err.message}`));
  }
}

function tierLabel(t) {
  return (t || "—").replace(/_/g, " ");
}

function accountRow(a) {
  const row = el("tr");
  row.appendChild(el("td", "mono", a.domain));
  row.appendChild(el("td", "col-name", a.name));
  row.appendChild(el("td", "mono", `${a.score}/100`));
  const tierCell = el("td");
  tierCell.appendChild(el("span", `tier-chip tier-${a.tier}`, tierLabel(a.tier)));
  row.appendChild(tierCell);
  row.appendChild(el("td", "mono", String(a.signalCount)));
  const actionCell = el("td");
  const btn = el("button", "activate-btn", "Activate");
  btn.type = "button";
  btn.addEventListener("click", () => activate(a.domain, a.name, btn));
  actionCell.appendChild(btn);
  row.appendChild(actionCell);
  return row;
}

async function activate(domain, name, btn) {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Activating…";
  try {
    const resp = await postJSON("/api/activate", { domain, name, mode: state.agentMode });
    renderActivationResult(resp, domain, name);
    toast("Draft created — awaiting your approval.");
    await Promise.all([loadStats(), loadDrafts()]);
  } catch (err) {
    toast(`Activation failed: ${err.message}`, true);
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

function renderActivationResult(resp, domain, name) {
  const d = resp.decision;
  $("#activation-result").hidden = false;
  $("#ar-domain").textContent = name ? `${name} · ${domain}` : domain;
  $("#ar-score").textContent = `${d.score}/100`;
  const tier = $("#ar-tier");
  tier.textContent = tierLabel(d.tier);
  tier.className = `tier-chip tier-${d.tier}`;
  $("#ar-rationale").textContent = d.rationale || "";
  $("#ar-meta").textContent =
    `${d.byAgent || "agent"} · ${d.agentMode} · ${d.relevantSignals.length} relevant signal(s) · ${fmtTime(d.ts)}`;

  const nba = $("#ar-nba");
  nba.textContent = "";
  nba.appendChild(document.createTextNode("Next best action: "));
  nba.appendChild(el("span", "nba-strong", d.nextBestAction.action));
  nba.appendChild(document.createTextNode(` via ${d.nextBestAction.channel} → ${d.nextBestAction.targetMember}`));

  $("#ar-draft-subject").textContent = resp.draftSubject || "(no subject)";
  $("#ar-draft-body").textContent = resp.draftBody || "";
}

/* ── 04 · drafts (the signature gate: arm -> confirm) ─────────────── */
async function loadDrafts() {
  const list = $("#drafts-list");
  try {
    const resp = await api("/api/drafts");
    const drafts = resp.drafts || [];
    state.drafts = drafts;
    $("#rail-draft-count").textContent = drafts.length > 0 ? `(${drafts.length})` : "";

    // Preserve any card currently armed or mid-send so the periodic refresh below never
    // clobbers an in-progress arm->confirm interaction out from under the operator.
    const keep = new Map();
    for (const node of list.querySelectorAll(".gate-card")) {
      const id = node.dataset.draftId;
      if (state.inFlight.has(id)) keep.set(id, node);
    }

    list.textContent = "";

    if (drafts.length === 0 && keep.size === 0) {
      list.appendChild(el("p", "empty-invite", "No drafts awaiting approval. Run mstack demo or activate an account to generate one."));
      return;
    }

    const seen = new Set();
    for (const d of drafts) {
      seen.add(d.id);
      list.appendChild(keep.has(d.id) ? keep.get(d.id) : draftCard(d));
    }
    for (const [id, node] of keep) {
      if (!seen.has(id)) list.appendChild(node); // in-flight but no longer in the server's pending list
    }
  } catch (err) {
    list.textContent = "";
    list.appendChild(el("p", "empty-invite", `Couldn't load drafts: ${err.message}`));
  }
}

function draftCard(d) {
  const card = el("div", "gate-card is-pending");
  card.dataset.draftId = d.id;

  const head = el("div", "gc-head");
  head.appendChild(el("span", "gc-kind", (d.kind || "").replace(/_/g, " ")));
  head.appendChild(el("span", "gc-status pending", "Awaiting your approval"));
  card.appendChild(head);

  card.appendChild(el("div", "gc-subject", d.subject || "(no subject)"));
  card.appendChild(el("p", "gc-body", d.body || ""));
  card.appendChild(el("div", "gc-meta", `${d.id} · ${d.refId} · ${fmtTime(d.createdAt)} · ${d.createdBy}`));

  const actions = el("div", "gc-actions");
  const approveBtn = el("button", "btn btn-approve", "Approve & send");
  approveBtn.type = "button";
  approveBtn.addEventListener("click", () => armDraft(d.id, card, actions));
  actions.appendChild(approveBtn);
  card.appendChild(actions);

  return card;
}

/** Arm step: reversible, no network call yet. "Undo" (or the auto-expiring arm window)
 * returns the card to pending with nothing sent. Only "Confirm send" fires the POST. */
function armDraft(id, card, actions) {
  state.inFlight.add(id);
  card.classList.remove("is-pending", "is-error");
  card.classList.add("is-armed");
  const status = card.querySelector(".gc-status");
  status.className = "gc-status pending";
  status.textContent = "Confirm send?";

  actions.textContent = "";
  const confirmBtn = el("button", "btn btn-confirm", "Confirm send");
  confirmBtn.type = "button";
  const undoBtn = el("button", "btn btn-undo", "Undo");
  undoBtn.type = "button";
  actions.appendChild(confirmBtn);
  actions.appendChild(undoBtn);

  const revert = () => {
    clearTimeout(state.armTimers[id]);
    delete state.armTimers[id];
    state.inFlight.delete(id);
    card.classList.remove("is-armed");
    card.classList.add("is-pending");
    status.textContent = "Awaiting your approval";
    actions.textContent = "";
    const btn = el("button", "btn btn-approve", "Approve & send");
    btn.type = "button";
    btn.addEventListener("click", () => armDraft(id, card, actions));
    actions.appendChild(btn);
  };

  undoBtn.addEventListener("click", revert);
  confirmBtn.addEventListener("click", () => {
    clearTimeout(state.armTimers[id]);
    delete state.armTimers[id];
    confirmApprove(id, card, actions);
  });

  state.armTimers[id] = setTimeout(revert, ARM_WINDOW_MS);
}

/** Confirm step: the one irreversible action. Fires POST /api/drafts/:id/approve. */
async function confirmApprove(id, card, actions) {
  const status = card.querySelector(".gc-status");
  status.textContent = "Sending…";
  actions.textContent = "";
  const sendingBtn = el("button", "btn btn-confirm", "Sending…");
  sendingBtn.type = "button";
  sendingBtn.disabled = true;
  actions.appendChild(sendingBtn);

  try {
    const out = await postJSON(`/api/drafts/${id}/approve`, { actor: "console-user" });
    card.classList.remove("is-armed");
    card.classList.add("is-sent");
    status.className = "gc-status sent";
    status.textContent = "Sent";
    const verified = out.auditVerified ? "audit verified" : "audit UNVERIFIED";
    const outboxPath = out.outcome && out.outcome.metrics && out.outcome.metrics.outboxPath;
    actions.textContent = "";
    actions.appendChild(
      el("p", "gc-note", `${(out.outcome && out.outcome.result) || "sent"} · ${verified}${outboxPath ? ` · ${outboxPath}` : ""}`),
    );
    toast("Sent.");
    loadStats(); // approvals count moves; the next periodic loadDrafts() naturally drops this pending-only entry
  } catch (err) {
    if (err.status === 404) {
      card.remove();
      toast("That draft no longer exists — it may have already been handled.", true);
      return;
    }
    if (err.status === 409) {
      card.classList.remove("is-armed");
      card.classList.add("is-sent");
      status.className = "gc-status sent";
      status.textContent = "Already sent";
      actions.textContent = "";
      actions.appendChild(el("p", "gc-note", "This draft was already dispatched elsewhere."));
      toast("Already sent.");
      return;
    }
    card.classList.remove("is-armed");
    card.classList.add("is-error");
    status.className = "gc-status error";
    status.textContent = "Send failed";
    actions.textContent = "";
    const retryBtn = el("button", "btn btn-retry", "Retry approve & send");
    retryBtn.type = "button";
    retryBtn.addEventListener("click", () => {
      card.classList.remove("is-error");
      card.classList.add("is-pending");
      armDraft(id, card, actions);
    });
    actions.appendChild(retryBtn);
    actions.appendChild(el("p", "gc-note", err.message));
    toast(`Couldn't send: ${err.message}`, true);
  } finally {
    state.inFlight.delete(id);
  }
}

/* ── shared helpers ────────────────────────────────────────────────── */
function emptyRow(colspan, message) {
  const row = el("tr");
  const cell = el("td", "empty-row", message);
  cell.colSpan = colspan;
  row.appendChild(cell);
  return row;
}

function fmtTime(ts) {
  try {
    return new Date(ts).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch (_) {
    return ts || "—";
  }
}

document.addEventListener("DOMContentLoaded", init);
