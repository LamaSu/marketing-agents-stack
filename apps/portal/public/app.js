"use strict";
/**
 * app.js — Partner Content Portal, the approval bench. Vanilla JS, no build step,
 * no framework, no CDN. Talks ONLY to this same origin's /api/* JSON endpoints
 * (see ../src/server.ts) — fully offline-capable.
 *
 * The signature is the GATE: a pending draft is approved through a deliberate
 * arm -> confirm, with a pre-commit UNDO window. The POST /api/drafts/:id/approve
 * is the real irreversible dispatch, so it fires only AFTER the undo window closes
 * — undo genuinely prevents the send (there is no un-dispatch route).
 */

/* ── tiny DOM + format helpers ─────────────────────────────────────────── */
function $(sel, root) { return (root || document).querySelector(sel); }
function $all(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }

function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}
function formatDate(iso) {
  try { return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }); }
  catch { return String(iso); }
}
function prefersReducedMotion() {
  return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/* ── announce (screen readers) + toast (transient) ─────────────────────── */
function announce(message) { const el = $("#live"); if (el) el.textContent = message; }
let toastTimer = null;
function toast(message, isError) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.toggle("is-error", Boolean(isError));
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3400);
}

/* ── fetch wrappers (same-origin /api/* only) ──────────────────────────── */
async function apiGet(path) {
  const res = await fetch(path);
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON error page */ }
  if (!res.ok) throw new Error((data && data.error) || `GET ${path} failed (${res.status})`);
  return data;
}
async function apiPost(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON error page */ }
  if (!res.ok) throw new Error((data && data.error) || `POST ${path} failed (${res.status})`);
  return data;
}

/* ── enum → human labels (bound to @mstack/core enums) ─────────────────── */
const CATEGORY_LABELS = {
  guaranteed_outcome: "Guaranteed-outcome language",
  uncited_quantitative: "Quantitative claim without a citation",
  unapproved_superlative: "Unapproved superlative claim",
  unapproved_spokesperson_quote: "Unapproved spokesperson quote",
  roadmap_disclosure: "Roadmap disclosure",
  badge_tier_misuse: "Badge / partner-tier misuse",
  pii_leak: "Exposed personal data (PII)",
};
const KIND_LABELS = {
  partner_email: "Partner email",
  outreach_email: "Outreach email",
  review_export: "Review export",
};
const DETECTED_BY_LABELS = { deterministic: "found by rule", claude: "found by Claude", nli: "found by NLI" };
const categoryLabel = (c) => CATEGORY_LABELS[c] || c;
const kindLabel = (k) => KIND_LABELS[k] || k;
const detectedByLabel = (d) => DETECTED_BY_LABELS[d] || ("found by " + d);

/* ── shared render: verdict + findings (Review result + Approvals detail) ── */
function verdictHtml(review) {
  const approved = review.verdict === "APPROVED";
  const note = approved
    ? "No required changes — okay to publish."
    : review.changesCount + " required change" + (review.changesCount === 1 ? "" : "s") + " before this can go out.";
  return (
    '<div class="verdict ' + (approved ? "v-approved" : "v-returned") + '">' +
    '<div class="verdict-score">' + escapeHtml(review.score) + "<small>/5</small></div>" +
    "<div><div class=\"verdict-word\">" + escapeHtml(review.verdict) + "</div>" +
    '<div class="verdict-note">' + escapeHtml(note) + "</div></div>" +
    "</div>"
  );
}
function findingHtml(f) {
  const req = f.required ? '<span class="chip chip-required">required</span>' : "";
  const evidence = f.supportingPassageId
    ? "evidence " + escapeHtml(f.supportingPassageId)
    : "no approved-corpus support";
  return (
    '<div class="finding">' +
    '<div class="finding-head">' +
    '<span class="finding-cat">' + escapeHtml(categoryLabel(f.category)) + "</span>" +
    req +
    '<span class="chip chip-sev-' + escapeHtml(f.severity) + '">' + escapeHtml(f.severity) + "</span>" +
    "</div>" +
    '<blockquote class="finding-quote">' + escapeHtml(f.quote) + "</blockquote>" +
    '<div class="finding-change"><b>Change:</b> ' + escapeHtml(f.recommendedChange) + "</div>" +
    '<div class="finding-foot"><span>' + escapeHtml(detectedByLabel(f.detectedBy)) + "</span><span>" + evidence + "</span></div>" +
    "</div>"
  );
}
function findingsHtml(findings) {
  if (!findings || findings.length === 0) return '<p class="no-findings">No findings — okay to publish.</p>';
  return (
    '<div class="findings-h">Findings (' + findings.length + ")</div>" +
    '<div class="finding-list">' + findings.map(findingHtml).join("") + "</div>"
  );
}

/* ══════════════════════════════════════════════════════════════════════
 *  THE GATE CARD — arm → confirm → (undo window) → sent.  The signature.
 * ════════════════════════════════════════════════════════════════════ */
const UNDO_WINDOW_MS = 5000;

function gateHeaderHtml(draft) {
  return (
    '<div class="gate-top">' +
    '<span class="gate-eyebrow">Awaiting your approval</span>' +
    '<span class="chip chip-status-pending" data-status-chip>' + escapeHtml(draft.status) + "</span>" +
    "</div>" +
    '<h2 class="gate-subject">' + escapeHtml(draft.subject || "(no subject)") + "</h2>" +
    '<div class="gate-meta">' +
    "<span>" + escapeHtml(kindLabel(draft.kind)) + "</span>" +
    "<span>id " + escapeHtml(draft.id) + "</span>" +
    "<span>" + escapeHtml(draft.channel) + "</span>" +
    "<span>by " + escapeHtml(draft.createdBy) + "</span>" +
    "<span>" + escapeHtml(formatDate(draft.createdAt)) + "</span>" +
    "</div>" +
    '<div class="gate-body">' + escapeHtml(draft.body) + "</div>"
  );
}

function makeGateCard(draft) {
  const el = document.createElement("article");
  el.className = "gate-card";
  el.dataset.draftId = draft.id;
  el.tabIndex = -1;
  el.setAttribute("aria-label", "Draft awaiting approval: " + (draft.subject || kindLabel(draft.kind)));
  el.innerHTML = gateHeaderHtml(draft) + '<div class="gate-control"></div>';

  const control = $(".gate-control", el);
  const eyebrow = $(".gate-eyebrow", el);
  const statusChip = $("[data-status-chip]", el);
  let timerId = null, tickId = null;

  const clearTimers = () => { clearTimeout(timerId); clearInterval(tickId); timerId = tickId = null; };
  const setEyebrow = (t) => { if (eyebrow) eyebrow.textContent = t; };

  function renderIdle() {
    clearTimers();
    el.classList.remove("is-armed", "is-committing", "is-sent", "is-returned");
    control.innerHTML =
      '<div class="gate-actions">' +
      '<button type="button" class="btn btn-key" data-act="arm">Approve &amp; send</button>' +
      '<button type="button" class="btn btn-reject" data-act="return">Return for changes</button>' +
      "</div>" +
      '<p class="gate-help">Approving sends this to the partner. You&rsquo;ll get a moment to undo.</p>';
    $('[data-act="arm"]', control).addEventListener("click", arm);
    $('[data-act="return"]', control).addEventListener("click", returnForChanges);
  }

  function arm() {
    el.classList.add("is-armed");
    control.innerHTML =
      '<div class="gate-actions">' +
      '<button type="button" class="btn btn-key" data-act="confirm">Confirm — send now</button>' +
      '<button type="button" class="btn btn-ghost" data-act="cancel">Cancel</button>' +
      "</div>" +
      '<p class="gate-help">This send goes to the partner. Confirm to start, or cancel.</p>';
    $('[data-act="confirm"]', control).addEventListener("click", confirmSend);
    $('[data-act="cancel"]', control).addEventListener("click", cancel);
    $('[data-act="confirm"]', control).focus();
    announce("Armed. Confirm to send this draft to the partner, or cancel.");
  }

  function cancel() {
    el.classList.remove("is-armed");
    renderIdle();
    $('[data-act="arm"]', control).focus();
    announce("Cancelled. Draft still awaiting your approval.");
  }

  function confirmSend() {
    el.classList.remove("is-armed");
    el.classList.add("is-committing");
    let remaining = Math.ceil(UNDO_WINDOW_MS / 1000);
    control.innerHTML =
      '<div class="gate-countdown">' +
      '<span class="gate-count-num" data-count>' + remaining + "</span>" +
      '<span class="gate-bar run"><span></span></span>' +
      '<button type="button" class="btn btn-ghost" data-act="undo">Undo</button>' +
      "</div>" +
      '<p class="gate-help">Sending in <span data-count2>' + remaining + "</span>s — undo to stop.</p>";
    const bar = $(".gate-bar > span", control);
    if (bar && !prefersReducedMotion()) {
      bar.style.transitionDuration = UNDO_WINDOW_MS + "ms";
      requestAnimationFrame(() => { bar.style.transform = "scaleX(0)"; });
    }
    $('[data-act="undo"]', control).addEventListener("click", undo);
    $('[data-act="undo"]', control).focus();
    announce("Sending in " + remaining + " seconds. Press undo to stop.");
    tickId = setInterval(() => {
      remaining -= 1;
      const a = $("[data-count]", control), b = $("[data-count2]", control);
      if (a) a.textContent = String(Math.max(remaining, 0));
      if (b) b.textContent = String(Math.max(remaining, 0));
      if (remaining <= 0) { clearInterval(tickId); tickId = null; }
    }, 1000);
    timerId = setTimeout(commit, UNDO_WINDOW_MS);
  }

  function undo() {
    clearTimers();
    el.classList.remove("is-committing");
    renderIdle();
    $('[data-act="arm"]', control).focus();
    announce("Send cancelled. Draft still awaiting your approval.");
    refreshQueueBadge();
  }

  async function commit() {
    clearTimers();
    control.innerHTML = '<p class="gate-help mono">dispatching…</p>';
    try {
      const res = await apiPost("/api/drafts/" + encodeURIComponent(draft.id) + "/approve");
      const result = (res && res.outcome && res.outcome.result) || "sent";
      const finalStatus = (res && res.draft && res.draft.status) || "dispatched";
      el.classList.remove("is-committing");
      el.classList.add("is-sent");
      setEyebrow("Sent");
      if (statusChip) { statusChip.className = "chip chip-status-sent"; statusChip.textContent = finalStatus; }
      control.innerHTML =
        '<p class="gate-sent-note">Sent. <span class="muted mono">outcome: ' + escapeHtml(result) + "</span></p>";
      announce("Sent.");
      toast("Sent.");
      el.focus();
      refreshQueueBadge();
    } catch (err) {
      // 409 already-dispatched / other — surface honestly, return to idle so the human can inspect.
      el.classList.remove("is-committing");
      renderIdle();
      const msg = (err && err.message) || "Send failed.";
      toast(msg, true);
      announce("Send failed. " + msg);
    }
  }

  function returnForChanges() {
    // The portal exposes no reject route (server.ts) — this is a session-scoped signal,
    // stated honestly. The draft stays pending on the server until the partner revises it.
    clearTimers();
    el.classList.add("is-returned");
    setEyebrow("Returned");
    control.innerHTML =
      '<div class="gate-actions">' +
      '<span class="gate-returned-note">Returned for changes.</span>' +
      '<button type="button" class="btn btn-ghost" data-act="undo-return">Undo</button>' +
      "</div>" +
      '<p class="gate-help">Marked in this session — it stays in the partner&rsquo;s queue until revised.</p>';
    $('[data-act="undo-return"]', control).addEventListener("click", () => {
      el.classList.remove("is-returned");
      setEyebrow("Awaiting your approval");
      renderIdle();
      announce("Return undone. Draft awaiting your approval.");
      refreshQueueBadge();
    });
    announce("Returned for changes.");
    toast("Returned for changes.");
    el.focus();
    refreshQueueBadge();
  }

  renderIdle();
  return el;
}

/* ── the rail badge = drafts still awaiting you in this session ──────────── */
function refreshQueueBadge() {
  const badge = $("#rail-queue-count");
  const awaiting = $all("#queue-cards .gate-card:not(.is-sent):not(.is-returned)").length;
  badge.textContent = String(awaiting);
  badge.hidden = awaiting === 0;
  badge.setAttribute("aria-label", awaiting + " awaiting your approval");
}

/* ══════════════════════════ 1 · Queue (hero) ══════════════════════════ */
async function loadQueue() {
  const host = $("#queue-cards");
  host.setAttribute("aria-busy", "true");
  host.innerHTML = '<p class="stage-loading mono">loading the queue…</p>';
  try {
    const drafts = await apiGet("/api/drafts");
    host.innerHTML = "";
    if (!drafts || drafts.length === 0) {
      host.innerHTML =
        '<div class="panel panel-quiet"><p class="muted">The queue is clear — nothing awaits you.</p>' +
        '<p class="muted">Run <span class="mono">mstack demo</span>, or score a partner asset in <strong>Review</strong> to generate a draft to approve.</p></div>';
      refreshQueueBadge();
      return;
    }
    const frag = document.createDocumentFragment();
    drafts.forEach((d) => frag.appendChild(makeGateCard(d)));
    host.appendChild(frag);
    refreshQueueBadge();
  } catch (err) {
    host.innerHTML = '<div class="notice notice-error" role="alert">Could not load the queue: ' +
      escapeHtml((err && err.message) || "unknown error") + "</div>";
  } finally {
    host.setAttribute("aria-busy", "false");
  }
}

/* ══════════════════════════ 2 · Review ══════════════════════════ */
let partnerTierMap = {};
let partnersLoaded = false;

async function loadPartners() {
  const select = $("#f-partner");
  try {
    const partners = await apiGet("/api/partners");
    partnerTierMap = {};
    select.innerHTML = "";
    if (!partners || partners.length === 0) {
      select.innerHTML = '<option value="">No partners found</option>';
      return;
    }
    partners.forEach((p, i) => {
      partnerTierMap[p.partnerId] = p.partnerTier;
      const opt = document.createElement("option");
      opt.value = p.partnerId;
      opt.textContent = p.partnerId + " (" + p.partnerTier + ")";
      if (i === 0) opt.selected = true;
      select.appendChild(opt);
    });
    partnersLoaded = true;
  } catch (err) {
    select.innerHTML = '<option value="">Failed to load partners</option>';
    toast((err && err.message) || "Failed to load partners", true);
  }
}

function showReviewError(message) {
  const el = $("#review-error");
  el.textContent = message;
  el.hidden = false;
}
function hideReviewError() { const el = $("#review-error"); el.hidden = true; el.textContent = ""; }

function renderReviewResult(review, draftIds) {
  const panel = $("#review-result");
  panel.innerHTML =
    '<h2 class="panel-h">Review result</h2>' +
    verdictHtml(review) +
    '<p class="muted">Two drafts were queued for your approval: a partner email and a review export.</p>' +
    '<div class="field-actions">' +
    '<button type="button" class="btn btn-key" data-go="queue">Approve in Queue</button>' +
    '<button type="button" class="btn btn-ghost" data-go="approvals" data-review-id="' + escapeHtml(review.id) + '">Open in Approvals</button>' +
    "</div>" +
    findingsHtml(review.findings);
  panel.hidden = false;
  $('[data-go="queue"]', panel).addEventListener("click", () => { loadQueue(); showView("queue"); });
  $('[data-go="approvals"]', panel).addEventListener("click", (e) => {
    const id = e.currentTarget.getAttribute("data-review-id");
    showView("approvals");
    loadReviews().then(() => selectReview(id));
  });
  panel.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "nearest" });
}

async function handleReviewSubmit(event) {
  event.preventDefault();
  hideReviewError();
  const partnerId = $("#f-partner").value;
  const partnerTier = partnerTierMap[partnerId];
  if (!partnerId || !partnerTier) { showReviewError("Choose a partner first."); return; }
  const contentTitle = $("#f-title").value.trim();
  const content = $("#f-content").value;
  if (!contentTitle || !content.trim()) { showReviewError("A content title and the content are both required."); return; }

  const btn = $("#btn-review");
  btn.disabled = true; btn.textContent = "Reviewing…";
  try {
    const res = await apiPost("/api/review", {
      partnerId, partnerTier, contentTitle, contentType: $("#f-type").value, content,
    });
    renderReviewResult(res.review, res.draftIds);
    toast("Reviewed — " + res.review.verdict + " (" + res.review.score + "/5). 2 drafts queued.");
  } catch (err) {
    showReviewError((err && err.message) || "Review failed.");
  } finally {
    btn.disabled = false; btn.textContent = "Submit for review";
  }
}

async function handleLoadSample() {
  const partnerId = $("#f-partner").value;
  if (!partnerId) { showReviewError("Choose a partner first, then load a sample draft."); return; }
  try {
    const sample = await apiGet("/api/sample-draft?partnerId=" + encodeURIComponent(partnerId));
    $("#f-title").value = sample.contentTitle;
    $("#f-type").value = sample.contentType;
    $("#f-content").value = sample.content;
    hideReviewError();
    toast("Sample draft loaded.");
  } catch (err) {
    showReviewError((err && err.message) || "No sample draft for this partner.");
  }
}

function handleClearReview() {
  $("#review-form").reset();
  hideReviewError();
  $("#review-result").hidden = true;
}

/* ══════════════════════════ 3 · Approvals ══════════════════════════ */
function renderReviewRow(r) {
  const cls = r.verdict === "RETURNED" ? "chip-status-returned" : "chip-status-dispatched";
  return (
    '<tr class="is-clickable" data-review-id="' + escapeHtml(r.id) + '">' +
    "<td>" + escapeHtml(r.partnerId) + '<div class="muted mono">' + escapeHtml(r.partnerTier) + "</div></td>" +
    "<td>" + escapeHtml(r.contentTitle) + "</td>" +
    '<td><span class="chip ' + cls + '">' + escapeHtml(r.verdict) + "</span></td>" +
    '<td class="mono">' + escapeHtml(r.score) + "/5</td>" +
    "</tr>"
  );
}

async function loadReviews() {
  const tbody = $("#reviews-tbody");
  tbody.innerHTML = '<tr><td colspan="4" class="empty-cell mono">loading…</td></tr>';
  try {
    const rows = await apiGet("/api/reviews");
    if (!rows || rows.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" class="empty-cell">No reviews yet — score an asset in <strong>Review</strong>.</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map(renderReviewRow).join("");
    $all("tr[data-review-id]", tbody).forEach((tr) => {
      tr.addEventListener("click", () => selectReview(tr.dataset.reviewId));
    });
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty-cell">Failed to load: ' +
      escapeHtml((err && err.message) || "unknown error") + "</td></tr>";
  }
}

async function selectReview(reviewId) {
  $all("#reviews-tbody tr").forEach((tr) => tr.classList.toggle("is-selected", tr.dataset.reviewId === reviewId));
  const detail = $("#review-detail");
  detail.innerHTML = '<p class="stage-loading mono">loading review…</p>';
  try {
    const data = await apiGet("/api/reviews/" + encodeURIComponent(reviewId));
    const review = data.review, meta = data.meta, drafts = data.drafts || {};
    const pe = drafts.partnerEmail, rx = drafts.reviewExport;

    let draftsHtml = '<h3 class="findings-h">Linked drafts</h3>';
    if (pe) {
      const pending = pe.status === "pending";
      draftsHtml +=
        '<div class="finding"><div class="finding-head">' +
        '<span class="finding-cat">' + escapeHtml(kindLabel(pe.kind)) + "</span>" +
        '<span class="chip chip-status-' + escapeHtml(pe.status) + '">' + escapeHtml(pe.status) + "</span></div>" +
        '<div class="muted mono" style="margin-bottom:8px">' + escapeHtml(pe.subject || "(no subject)") + "</div>" +
        '<div class="email-preview">' + escapeHtml(pe.body) + "</div>" +
        (pending ? '<div class="field-actions"><button type="button" class="btn btn-key" data-approve-in-queue>Approve in Queue</button></div>' : "") +
        "</div>";
    }
    if (rx) {
      draftsHtml +=
        '<div class="finding"><div class="finding-head">' +
        '<span class="finding-cat">' + escapeHtml(kindLabel(rx.kind)) + "</span>" +
        '<span class="chip chip-status-' + escapeHtml(rx.status) + '">' + escapeHtml(rx.status) + "</span></div>" +
        '<div class="muted mono">id ' + escapeHtml(rx.id) + "</div></div>";
    }
    if (!pe && !rx) draftsHtml += '<p class="muted">No linked drafts for this review.</p>';

    detail.innerHTML =
      '<div class="detail-title">' + escapeHtml(meta.contentTitle || review.assetId) + "</div>" +
      '<div class="detail-sub">' + escapeHtml(review.partnerId) + " · " + escapeHtml(review.partnerTier) +
        " · " + escapeHtml(formatDate(review.createdAt)) + "</div>" +
      verdictHtml(review) +
      findingsHtml(review.findings) +
      draftsHtml;

    const approveBtn = $("[data-approve-in-queue]", detail);
    if (approveBtn) approveBtn.addEventListener("click", () => { loadQueue(); showView("queue"); });
  } catch (err) {
    detail.innerHTML = '<div class="notice notice-error" role="alert">Could not load review: ' +
      escapeHtml((err && err.message) || "unknown error") + "</div>";
  }
}

/* ══════════════════════════ 4 · Ledger + mode ══════════════════════════ */
async function loadLedger() {
  const tbody = $("#ledger-tbody"), tfoot = $("#ledger-tfoot");
  tbody.innerHTML = '<tr><td colspan="4" class="empty-cell mono">loading…</td></tr>';
  try {
    const data = await apiGet("/api/internal");
    if (!data || !data.partners || data.partners.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" class="empty-cell">No decisions yet — reviews will tally here.</td></tr>';
      tfoot.hidden = true;
      return;
    }
    tbody.innerHTML = data.partners.map((p) =>
      "<tr><td>" + escapeHtml(p.partnerId) + '</td><td class="mono">' + escapeHtml(p.approved) +
      '</td><td class="mono">' + escapeHtml(p.returned) + '</td><td class="mono">' + escapeHtml(p.total) + "</td></tr>"
    ).join("");
    $("#tot-approved").textContent = data.totals.approved;
    $("#tot-returned").textContent = data.totals.returned;
    $("#tot-total").textContent = data.totals.total;
    tfoot.hidden = false;
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty-cell">Failed to load: ' +
      escapeHtml((err && err.message) || "unknown error") + "</td></tr>";
  }
}

async function loadMode() {
  const chip = $("#mode-chip"), chipText = $("#mode-chip-text");
  const banner = $("#mode-banner"), bTitle = $("#mode-banner-title"), bDetail = $("#mode-banner-detail");
  try {
    const data = await apiGet("/api/mode");
    const live = data.mode === "live";
    chip.classList.toggle("is-live", live);
    chipText.textContent = live ? "LIVE" : "OFFLINE";
    chip.title = data.detail || "";
    banner.classList.toggle("is-live", live);
    bTitle.textContent = live ? "LIVE" : "OFFLINE";
    bDetail.textContent = data.detail || "";
  } catch (err) {
    chipText.textContent = "mode?";
    chip.title = (err && err.message) || "";
  }
}

/* ── view switching (the rail) ─────────────────────────────────────────── */
const VIEW_LOADED = { review: false };
function showView(name) {
  $all(".rail-item").forEach((btn) => {
    const active = btn.dataset.view === name;
    btn.classList.toggle("is-active", active);
    if (active) btn.setAttribute("aria-current", "page");
    else btn.removeAttribute("aria-current");
  });
  $all(".view").forEach((v) => { v.hidden = v.id !== "view-" + name; });
  announce(name.charAt(0).toUpperCase() + name.slice(1) + " view.");
  if (name === "queue") loadQueue();
  if (name === "review" && !VIEW_LOADED.review) { loadPartners(); VIEW_LOADED.review = true; }
  if (name === "approvals") loadReviews();
  if (name === "ledger") { loadLedger(); loadMode(); }
}

/* ── wire up ────────────────────────────────────────────────────────────── */
$all(".rail-item").forEach((btn) => btn.addEventListener("click", () => showView(btn.dataset.view)));
$("#queue-refresh").addEventListener("click", loadQueue);
$("#approvals-refresh").addEventListener("click", loadReviews);
$("#ledger-refresh").addEventListener("click", () => { loadLedger(); loadMode(); });
$("#review-form").addEventListener("submit", handleReviewSubmit);
$("#btn-sample").addEventListener("click", handleLoadSample);
$("#btn-clear").addEventListener("click", handleClearReview);

/* initial paint: mode + the hero queue; partners lazy-load on first Review visit */
loadMode();
loadQueue();
