"use strict";
/**
 * app.js — Partner Content Portal frontend. Vanilla JS, no build step, no
 * framework, no CDN — self-contained so the portal works fully offline. Talks
 * only to this same origin's /api/* JSON endpoints (see ../src/server.ts).
 */

/* ── tiny DOM helpers ──────────────────────────────────────────────────── */

function $(sel, root) {
  return (root || document).querySelector(sel);
}
function $all(sel, root) {
  return Array.from((root || document).querySelectorAll(sel));
}

function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function formatDate(iso) {
  try {
    return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return String(iso);
  }
}

/* ── fetch wrappers ────────────────────────────────────────────────────── */

async function apiGet(path) {
  const res = await fetch(path);
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* non-JSON error page — fall through with an empty body */
  }
  if (!res.ok) {
    throw new Error((data && data.error) || `GET ${path} failed (${res.status})`);
  }
  return data;
}

async function apiPost(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* non-JSON error page — fall through with an empty body */
  }
  if (!res.ok) {
    throw new Error((data && data.error) || `POST ${path} failed (${res.status})`);
  }
  return data;
}

/* ── findings / review-detail rendering (shared: Submit result + Dashboard) ── */

const CATEGORY_LABELS = {
  guaranteed_outcome: "Guaranteed-outcome language",
  uncited_quantitative: "Quantitative claim without citation",
  unapproved_superlative: "Unapproved superlative claim",
  unapproved_spokesperson_quote: "Unapproved spokesperson quote",
  roadmap_disclosure: "Roadmap disclosure",
  badge_tier_misuse: "Badge / partner-tier misuse",
};

function categoryLabel(category) {
  return CATEGORY_LABELS[category] || category;
}

function renderFindingHtml(finding) {
  const requiredBadge = finding.required ? '<span class="badge-required">REQUIRED</span>' : "";
  const severity = escapeHtml(finding.severity || "medium");
  return (
    '<div class="finding">' +
    '<div class="finding-head">' +
    '<span class="finding-category">' + escapeHtml(categoryLabel(finding.category)) + "</span>" +
    requiredBadge +
    '<span class="severity severity-' + severity + '">' + severity + "</span>" +
    "</div>" +
    '<blockquote class="finding-quote">“' + escapeHtml(finding.quote) + "”</blockquote>" +
    '<div class="finding-change"><strong>Recommended change:</strong> ' + escapeHtml(finding.recommendedChange) + "</div>" +
    "</div>"
  );
}

function renderFindingsHtml(findings) {
  if (!findings || findings.length === 0) {
    return '<p class="no-findings">No findings — publish-ready.</p>';
  }
  return '<div class="finding-list">' + findings.map(renderFindingHtml).join("") + "</div>";
}

function renderVerdictBannerHtml(review) {
  const isReturned = review.verdict === "RETURNED";
  const pillClass = isReturned ? "status-returned" : "status-approved";
  const note = isReturned
    ? review.changesCount + " required change(s) found."
    : "No required changes — publish-ready.";
  return (
    '<div class="verdict-banner">' +
    '<div class="verdict-score">' + escapeHtml(review.score) + "<span>/5</span></div>" +
    '<div class="verdict-text">' +
    '<span class="status-pill ' + pillClass + '">' + escapeHtml(review.verdict) + "</span>" +
    "<p>" + escapeHtml(note) + "</p>" +
    "</div>" +
    "</div>"
  );
}

/* ── modal ─────────────────────────────────────────────────────────────── */

function openModal(html) {
  $("#modal-body").innerHTML = html;
  $("#modal-overlay").hidden = false;
}

function closeModal() {
  $("#modal-overlay").hidden = true;
  $("#modal-body").innerHTML = "";
}

async function openReviewDetail(reviewId, opts) {
  const options = opts || {};
  try {
    const data = await apiGet("/api/reviews/" + encodeURIComponent(reviewId));
    const review = data.review;
    const meta = data.meta;
    const drafts = data.drafts;

    const emailHtml = drafts && drafts.partnerEmail
      ? '<div class="findings-heading">Drafted partner email</div>' +
        '<p class="rubric-intro">' + escapeHtml(drafts.partnerEmail.subject || "") + "</p>" +
        '<div class="email-body">' + escapeHtml(drafts.partnerEmail.body) + "</div>"
      : '<p class="no-findings">No partner-email draft found for this review.</p>';

    openModal(
      '<div class="modal-title">' + escapeHtml(meta.contentTitle) + "</div>" +
        '<div class="modal-subtitle">' +
        escapeHtml(review.partnerId) + " (" + escapeHtml(review.partnerTier) + ") · " + escapeHtml(formatDate(review.createdAt)) +
        "</div>" +
        renderVerdictBannerHtml(review) +
        '<div class="findings-heading">Findings (' + review.findings.length + ")</div>" +
        renderFindingsHtml(review.findings) +
        emailHtml,
    );

    if (options.focus === "email") {
      requestAnimationFrame(() => {
        const emailEl = document.querySelector(".email-body");
        if (emailEl) emailEl.scrollIntoView({ behavior: "smooth", block: "center" });
      });
    }
  } catch (err) {
    showToast((err && err.message) || "Failed to load review detail", true);
  }
}

/* ── toast ─────────────────────────────────────────────────────────────── */

let toastTimer = null;
function showToast(message, isError) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.toggle("toast-error", Boolean(isError));
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, 3200);
}

/* ── tabs ──────────────────────────────────────────────────────────────── */

function switchTab(name) {
  $all(".tab-btn").forEach((btn) => {
    const active = btn.dataset.tab === name;
    btn.classList.toggle("is-active", active);
    btn.setAttribute("aria-selected", String(active));
  });
  $all(".tab-panel").forEach((panel) => {
    panel.hidden = panel.id !== "panel-" + name;
  });
  if (name === "dashboard") loadDashboard();
  if (name === "internal") loadInternal();
}

/* ── mode badge ────────────────────────────────────────────────────────── */

async function loadMode() {
  const badge = $("#mode-badge");
  const text = $("#mode-badge-text");
  try {
    const data = await apiGet("/api/mode");
    badge.classList.remove("mode-offline", "mode-live");
    badge.classList.add(data.mode === "live" ? "mode-live" : "mode-offline");
    text.textContent = data.mode === "live" ? "LIVE MODE" : "OFFLINE MODE";
    badge.title = data.detail || "";
  } catch (err) {
    text.textContent = "mode unknown";
    badge.title = (err && err.message) || "";
  }
}

/* ── Submit Content tab ────────────────────────────────────────────────── */

let partnerTierMap = {};

async function loadPartners() {
  const select = $("#field-partner");
  try {
    const partners = await apiGet("/api/partners");
    partnerTierMap = {};
    select.innerHTML = "";

    if (partners.length === 0) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "No partners found";
      select.appendChild(opt);
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
  } catch (err) {
    select.innerHTML = '<option value="">Failed to load partners</option>';
    showToast((err && err.message) || "Failed to load partners", true);
  }
}

function showFormError(message) {
  const el = $("#form-error");
  el.textContent = message;
  el.hidden = false;
}

function hideFormError() {
  const el = $("#form-error");
  el.hidden = true;
  el.textContent = "";
}

function setSubmitting(isSubmitting) {
  const btn = $("#btn-submit");
  btn.disabled = isSubmitting;
  btn.textContent = isSubmitting ? "Reviewing…" : "Submit for review";
}

function renderSubmitResult(review) {
  const resultsCard = $("#results-card");
  const body = $("#results-body");
  body.innerHTML =
    renderVerdictBannerHtml(review) +
    '<div class="result-actions">' +
    '<button type="button" class="btn btn-secondary" id="btn-view-email">View drafted partner email</button>' +
    '<button type="button" class="btn btn-ghost" id="btn-view-dashboard">View in Review Dashboard</button>' +
    "</div>" +
    '<div class="findings-heading">Findings (' + review.findings.length + ")</div>" +
    renderFindingsHtml(review.findings);

  resultsCard.hidden = false;
  resultsCard.scrollIntoView({ behavior: "smooth", block: "nearest" });

  $("#btn-view-email").addEventListener("click", () => openReviewDetail(review.id, { focus: "email" }));
  $("#btn-view-dashboard").addEventListener("click", () => switchTab("dashboard"));
}

async function handleSubmit(event) {
  event.preventDefault();
  hideFormError();

  const partnerId = $("#field-partner").value;
  const partnerTier = partnerTierMap[partnerId];
  if (!partnerId || !partnerTier) {
    showFormError("Choose a partner first.");
    return;
  }

  const contentTitle = $("#field-title").value.trim();
  const content = $("#field-content").value;
  if (!contentTitle || !content.trim()) {
    showFormError("Content title and content are both required.");
    return;
  }

  const payload = {
    partnerId,
    partnerTier,
    contentTitle,
    contentType: $("#field-type").value,
    content,
  };

  setSubmitting(true);
  try {
    const result = await apiPost("/api/review", payload);
    renderSubmitResult(result.review);
    showToast("Review complete — " + result.review.verdict + " (" + result.review.score + "/5)");
  } catch (err) {
    showFormError((err && err.message) || "Review failed.");
  } finally {
    setSubmitting(false);
  }
}

async function handleLoadSample() {
  const partnerId = $("#field-partner").value;
  if (!partnerId) {
    showFormError("Choose a partner first, then Load sample draft.");
    return;
  }
  try {
    const sample = await apiGet("/api/sample-draft?partnerId=" + encodeURIComponent(partnerId));
    $("#field-title").value = sample.contentTitle;
    $("#field-type").value = sample.contentType;
    $("#field-content").value = sample.content;
    hideFormError();
  } catch (err) {
    showFormError((err && err.message) || "No sample draft available for this partner.");
  }
}

function handleClear() {
  $("#submit-form").reset();
  hideFormError();
  $("#results-card").hidden = true;
}

/* ── Review Dashboard tab ─────────────────────────────────────────────── */

function renderDashboardRow(r) {
  const pillClass = r.verdict === "RETURNED" ? "status-returned" : "status-approved";
  const findingsLabel = r.findingsCount + " finding" + (r.findingsCount === 1 ? "" : "s");
  return (
    '<tr class="is-clickable" data-review-id="' + escapeHtml(r.id) + '">' +
    "<td>" + escapeHtml(r.partnerId) + "</td>" +
    "<td>" + escapeHtml(r.contentTitle) + "</td>" +
    '<td class="cell-muted cell-nowrap">' + escapeHtml(formatDate(r.createdAt)) + "</td>" +
    "<td><span class=\"status-pill " + pillClass + "\">" + escapeHtml(r.verdict) + "</span></td>" +
    '<td><button type="button" class="link-btn" data-review-id="' + escapeHtml(r.id) + '">' + findingsLabel + "</button></td>" +
    '<td><button type="button" class="link-btn" data-review-id="' + escapeHtml(r.id) + '" data-focus="email">View email</button></td>' +
    "</tr>"
  );
}

async function loadDashboard() {
  const tbody = $("#dashboard-tbody");
  tbody.innerHTML = '<tr><td colspan="6" class="empty-row">Loading…</td></tr>';
  try {
    const rows = await apiGet("/api/reviews");
    if (rows.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty-row">No reviews yet — submit content to see it here.</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map(renderDashboardRow).join("");
    $all("tr[data-review-id]", tbody).forEach((tr) => {
      tr.addEventListener("click", (event) => {
        if (event.target.closest("button")) return; // the finding/email link-buttons handle their own click
        openReviewDetail(tr.dataset.reviewId);
      });
    });
    $all("button[data-review-id]", tbody).forEach((btn) => {
      btn.addEventListener("click", () => openReviewDetail(btn.dataset.reviewId, { focus: btn.dataset.focus }));
    });
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-row">Failed to load: ' + escapeHtml((err && err.message) || "unknown error") + "</td></tr>";
  }
}

/* ── INTERNAL tab ─────────────────────────────────────────────────────── */

async function loadLedger() {
  const tbody = $("#ledger-tbody");
  tbody.innerHTML = '<tr><td colspan="4" class="empty-row">Loading…</td></tr>';
  try {
    const data = await apiGet("/api/internal");
    if (data.partners.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" class="empty-row">No reviews yet.</td></tr>';
      return;
    }
    tbody.innerHTML = data.partners
      .map(
        (p) =>
          "<tr><td>" + escapeHtml(p.partnerId) + "</td><td>" + p.approved + "</td><td>" + p.returned + "</td><td>" + p.total + "</td></tr>",
      )
      .join("");
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty-row">Failed to load: ' + escapeHtml((err && err.message) || "unknown error") + "</td></tr>";
  }
}

async function approveDraft(draftId, btn) {
  btn.disabled = true;
  btn.textContent = "Approving…";
  try {
    await apiPost("/api/drafts/" + encodeURIComponent(draftId) + "/approve");
    showToast("Draft approved and dispatched to the outbox.");
    await loadDrafts();
  } catch (err) {
    showToast((err && err.message) || "Approve failed", true);
    btn.disabled = false;
    btn.textContent = "Approve";
  }
}

async function loadDrafts() {
  const tbody = $("#drafts-tbody");
  tbody.innerHTML = '<tr><td colspan="4" class="empty-row">Loading…</td></tr>';
  try {
    const drafts = await apiGet("/api/drafts");
    if (drafts.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" class="empty-row">No drafts awaiting approval.</td></tr>';
      return;
    }
    tbody.innerHTML = drafts
      .map(
        (d) =>
          '<tr><td class="cell-nowrap">' + escapeHtml(d.kind) + "</td><td>" + escapeHtml(d.subject || "(no subject)") + '</td><td><span class="status-pill status-returned">' +
          escapeHtml(d.status) + '</span></td><td><button type="button" class="btn btn-secondary btn-small" data-draft-id="' + escapeHtml(d.id) + '">Approve</button></td></tr>',
      )
      .join("");
    $all("button[data-draft-id]", tbody).forEach((btn) => {
      btn.addEventListener("click", () => approveDraft(btn.dataset.draftId, btn));
    });
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty-row">Failed to load: ' + escapeHtml((err && err.message) || "unknown error") + "</td></tr>";
  }
}

function loadInternal() {
  loadLedger();
  loadDrafts();
}

/* ── wire everything up ───────────────────────────────────────────────── */

$all(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => switchTab(btn.dataset.tab));
});

$("#submit-form").addEventListener("submit", handleSubmit);
$("#btn-sample").addEventListener("click", handleLoadSample);
$("#btn-clear").addEventListener("click", handleClear);
$("#btn-refresh-dashboard").addEventListener("click", loadDashboard);
$("#btn-refresh-internal").addEventListener("click", loadInternal);

$("#modal-close").addEventListener("click", closeModal);
$("#modal-overlay").addEventListener("click", (event) => {
  if (event.target && event.target.id === "modal-overlay") closeModal();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeModal();
});

loadMode();
loadPartners();
