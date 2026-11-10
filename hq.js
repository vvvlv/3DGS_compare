/**
 * Training Explorer: in-page side panel (metrics + curves) and bottom scrubber
 * (interactive PLY checkpoints vs fixed-POV rendered images). Does not open a
 * second window — toggling the explorer never reloads the experiment.
 */

const LIVE_STALE_MS = 3 * 60 * 1000;
const LIVE_POLL_MS = 3000;

/**
 * @param {object} api
 * @param {() => Map<string, any>} api.getMethodById
 * @param {() => any[]} api.visiblePanels
 * @param {(panel: any, methodId: string, opts?: object) => Promise<void>} api.loadMethod
 * @param {(panel: any, method: any, statusText?: string, isError?: boolean) => void} [api.updateOverlay]
 * @param {(methodId: string) => void} [api.refreshMethodOptionLabel]
 * @param {() => boolean} api.isFlying
 * @param {() => string|null} [api.getActiveExperimentId]
 * @param {(job: any|null, meta?: { stale?: boolean, updatedAt?: string|null }) => void} [api.onLiveUpdate]
 */
export function initHQ(api) {
  const explorerBtn = document.getElementById("explorer-btn");
  const explorerMeta = document.getElementById("explorer-meta");
  const pipelineEl = document.getElementById("explorer-pipeline");
  const protocolEl = document.getElementById("explorer-protocol");
  const tableEl = document.getElementById("explorer-table");
  const chartsEl = document.getElementById("explorer-charts");
  const scrubIter = document.getElementById("scrub-iter");
  const scrubSlider = document.getElementById("scrub-slider");
  const scrubTicks = document.getElementById("scrub-ticks");
  const scrubPrev = document.getElementById("scrub-prev");
  const scrubNext = document.getElementById("scrub-next");
  const modeInteractive = document.getElementById("mode-interactive");
  const modeRendered = document.getElementById("mode-rendered");
  const povSelect = document.getElementById("scrub-pov");
  const povLabel = document.getElementById("pov-label");

  /** @type {any|null} */
  let activeExp = null;
  /** @type {any|null} */
  let activeReport = null;
  /** @type {number[]} */
  let captureIters = [];
  let currentIter = 0;
  /** @type {"interactive"|"rendered"} */
  let viewMode = "interactive";
  let explorerOpen = false;
  let applying = false;
  /** @type {any|null} */
  let liveJob = null;
  /** @type {string|null} */
  let liveUpdatedAt = null;
  let liveStale = false;

  explorerBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    setExplorerOpen(!explorerOpen);
  });

  modeInteractive?.addEventListener("click", () => setViewMode("interactive"));
  modeRendered?.addEventListener("click", () => setViewMode("rendered"));

  scrubSlider?.addEventListener("input", () => {
    const idx = Number(scrubSlider.value);
    const iter = captureIters[idx];
    if (iter != null) jumpToIter(iter);
  });
  scrubPrev?.addEventListener("click", () => stepIter(-1));
  scrubNext?.addEventListener("click", () => stepIter(1));
  povSelect?.addEventListener("change", () => {
    if (viewMode === "rendered") applyRenderedViews();
  });

  window.addEventListener("keydown", (e) => {
    if (api.isFlying()) return;
    const tag = (e.target && e.target.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (e.code === "BracketLeft") {
      e.preventDefault();
      stepIter(-1);
    } else if (e.code === "BracketRight") {
      e.preventDefault();
      stepIter(1);
    }
  });

  function setExplorerOpen(open) {
    explorerOpen = open;
    document.body.classList.toggle("explorer-open", open);
    if (explorerBtn) explorerBtn.textContent = open ? "Close Explorer" : "Training Explorer";
    if (open) {
      // UI only — do not reload PLYs / experiment when opening the panel.
      renderPanel();
      syncScrubberUi();
      if (viewMode === "rendered") applyRenderedViews();
    }
    // Resize the WebGL canvas after the side panel appears/disappears.
    window.dispatchEvent(new Event("resize"));
  }

  function setViewMode(mode) {
    viewMode = mode === "rendered" ? "rendered" : "interactive";
    document.body.classList.toggle("view-rendered", viewMode === "rendered");
    modeInteractive?.classList.toggle("active", viewMode === "interactive");
    modeRendered?.classList.toggle("active", viewMode === "rendered");
    if (povLabel) povLabel.style.opacity = viewMode === "rendered" ? "1" : "0.45";
    if (viewMode === "interactive" && api.updateOverlay) {
      // Restore final-eval overlay (rendered mode overwrites it with checkpoint metrics).
      for (const panel of api.visiblePanels()) {
        const method = resolveBaseMethod(panel.methodId);
        if (method) api.updateOverlay(panel, method, "");
      }
    }
    applyCurrentView();
  }

  function setCaptureIters(iters) {
    const list = (Array.isArray(iters) && iters.length ? iters : [])
      .map(Number)
      .filter((n) => Number.isFinite(n) && n > 0)
      .sort((a, b) => a - b);
    captureIters = list;
    if (!captureIters.length) {
      currentIter = 0;
    } else if (!captureIters.includes(currentIter)) {
      currentIter = captureIters[captureIters.length - 1];
    }
    syncScrubberUi();
  }

  function syncScrubberUi() {
    if (scrubSlider) {
      scrubSlider.min = "0";
      scrubSlider.max = String(Math.max(0, captureIters.length - 1));
      scrubSlider.value = String(Math.max(0, captureIters.indexOf(currentIter)));
      scrubSlider.disabled = captureIters.length < 2;
    }
    if (scrubTicks) {
      scrubTicks.innerHTML = captureIters.map((n) => `<span>${n}</span>`).join("");
    }
    if (scrubIter) scrubIter.textContent = currentIter ? String(currentIter) : "—";
    fillPovSelect();
  }

  function fillPovSelect() {
    if (!povSelect) return;
    const names = discoverPovs();
    const prev = povSelect.value;
    povSelect.innerHTML = "";
    if (!names.length) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "—";
      povSelect.appendChild(opt);
      return;
    }
    for (const name of names) {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name.replace(/\.[^.]+$/, "");
      povSelect.appendChild(opt);
    }
    povSelect.value = names.includes(prev) ? prev : names[0];
  }

  function discoverPovs() {
    const names = new Set();
    for (const m of methodRows()) {
      for (const urls of Object.values(m.preview_urls || {})) {
        for (const u of urls || []) {
          const base = u.split("/").pop();
          if (base) names.add(base);
        }
      }
    }
    // Also check manifest method entries (dummy may only put URLs there).
    for (const panel of api.visiblePanels()) {
      const method = resolveBaseMethod(panel.methodId);
      for (const urls of Object.values(method?.preview_urls || {})) {
        for (const u of urls || []) {
          const base = u.split("/").pop();
          if (base) names.add(base);
        }
      }
    }
    const preferred = (activeReport?.capture?.preview_image_ids || activeExp?.capture?.preview_image_ids || [])
      .map((id) => String(id).padStart(6, "0"));
    if (preferred.length) {
      const ordered = [];
      for (const stem of preferred) {
        for (const name of names) {
          if (name.startsWith(stem + ".") || name === stem) ordered.push(name);
        }
      }
      for (const name of [...names].sort()) {
        if (!ordered.includes(name)) ordered.push(name);
      }
      return ordered;
    }
    return [...names].sort();
  }

  function stepIter(delta) {
    if (!captureIters.length) return;
    let idx = captureIters.indexOf(currentIter);
    if (idx < 0) idx = captureIters.length - 1;
    idx = Math.max(0, Math.min(captureIters.length - 1, idx + delta));
    jumpToIter(captureIters[idx]);
  }

  async function jumpToIter(iter) {
    if (!captureIters.includes(iter) || applying) return;
    currentIter = iter;
    syncScrubberUi();
    await applyCurrentView();
  }

  async function applyCurrentView() {
    if (viewMode === "rendered") {
      applyRenderedViews();
      return;
    }
    await applyInteractivePlys();
  }

  async function applyInteractivePlys() {
    if (!currentIter || applying) return;
    applying = true;
    try {
      const methodById = api.getMethodById();
      for (const panel of api.visiblePanels()) {
        const method = resolveBaseMethod(panel.methodId);
        if (!method) continue;
        const ckptUrl =
          method.checkpoints?.[String(currentIter)] ||
          reportCheckpoint(method, currentIter);
        if (!ckptUrl) continue;
        const mid = `${stripIterSuffix(method.id)}__iter_${currentIter}`;
        if (!methodById.has(mid)) {
          methodById.set(mid, {
            ...method,
            id: mid,
            url: ckptUrl,
            label: `${method.label.replace(/ @ \d+$/, "")} @ ${currentIter}`,
            notes: `checkpoint ${currentIter}`,
            status: "ok",
          });
        }
        try {
          await api.loadMethod(panel, mid, { fitCamera: false, isReference: false });
        } catch (err) {
          console.warn(err);
        }
      }
    } finally {
      applying = false;
    }
  }

  function applyRenderedViews() {
    const pov = povSelect?.value || "";
    for (const panel of api.visiblePanels()) {
      const el = panel.stage.querySelector(".render-view");
      if (!el) continue;
      const method = resolveBaseMethod(panel.methodId);
      const urls =
        method?.preview_urls?.[String(currentIter)] ||
        reportPreviewUrls(method, currentIter) ||
        [];
      const url = pov ? urls.find((u) => u.endsWith(`/${pov}`)) : urls[0];
      const series = (method?.preview_series || reportPreviewSeries(method) || []).find(
        (p) => Number(p.iteration) === Number(currentIter),
      );
      if (url) {
        el.innerHTML = `<img src="${url}" alt="${escapeHtml(method?.label || "")} iter ${currentIter}" />`;
      } else {
        el.innerHTML = `<div class="missing">No render at iter ${currentIter || "—"}</div>`;
      }
      // Show this checkpoint's preview metrics in the overlay (not final eval).
      if (api.updateOverlay && method) {
        const overlayMethod = {
          ...method,
          label: `${String(method.label || "").replace(/ @ \d+$/, "")} @ ${currentIter}`,
          psnr: series?.psnr ?? null,
          ssim: series?.ssim ?? null,
          lpips: series?.lpips ?? null,
          notes: series
            ? `checkpoint ${currentIter} · fixed-POV preview`
            : `checkpoint ${currentIter} · no preview metrics`,
        };
        api.updateOverlay(
          panel,
          overlayMethod,
          url ? "Rendered view" : `No render at iter ${currentIter || "—"}`,
          !url,
        );
      } else if (series && panel.overlay) {
        const status = panel.overlay.querySelector(".status");
        if (status) {
          status.style.display = "block";
          status.textContent = `preview PSNR ${fmt(series.psnr)} · SSIM ${fmt(series.ssim, 3)} · LPIPS ${fmt(series.lpips, 3)}`;
          status.classList.remove("error");
        }
      }
    }
  }

  function stripIterSuffix(id) {
    const m = /^(.*)__iter_\d+$/.exec(id || "");
    return m ? m[1] : id;
  }

  function resolveBaseMethod(methodId) {
    if (!methodId) return null;
    const baseId = stripIterSuffix(methodId);
    return api.getMethodById().get(baseId) || api.getMethodById().get(methodId) || null;
  }

  function reportMethod(method) {
    if (!activeReport?.methods || !method) return null;
    const bare = stripIterSuffix(method.id || "");
    const short = bare.replace(/^[^_]+_/, ""); // experiment_method → method guess
    return (
      activeReport.methods.find((r) => `${activeExp?.id}_${r.method}` === bare) ||
      activeReport.methods.find((r) => r.method === bare) ||
      activeReport.methods.find((r) => bare.endsWith(`_${r.method}`)) ||
      activeReport.methods.find((r) => r.viewer_id === bare) ||
      activeReport.methods.find((r) => short === r.method) ||
      null
    );
  }

  function reportCheckpoint(method, iter) {
    const row = reportMethod(method);
    return row?.checkpoint_urls?.[String(iter)] || null;
  }

  function reportPreviewUrls(method, iter) {
    const row = reportMethod(method);
    return row?.preview_urls?.[String(iter)] || null;
  }

  function reportPreviewSeries(method) {
    return reportMethod(method)?.preview_series || null;
  }

  function methodRows() {
    if (activeReport?.methods?.length) return activeReport.methods;
    return [];
  }

  /**
   * Load report for the active experiment. Refreshes explorer UI only —
   * does not re-fetch PLYs unless the scrubber is already on a capture step
   * and interactive mode needs that checkpoint (caller controls experiment load).
   */
  async function loadReport(exp) {
    activeExp = exp || null;
    activeReport = null;
    const url = exp?.report || (exp?.id ? `reports/${exp.id}.json` : null);
    if (url) {
      try {
        const r = await fetch(`./${url}`, { cache: "no-store" });
        if (r.ok) activeReport = await r.json();
      } catch (_) {
        /* optional until publish */
      }
    }
    const cap = activeReport?.capture || exp?.capture || {};
    setCaptureIters(cap.iterations);
    // Enrich method entries from the report so scrubbing works even if the
    // manifest omitted checkpoint/preview maps.
    if (activeReport?.methods) {
      const methodById = api.getMethodById();
      for (const row of activeReport.methods) {
        const vid = row.viewer_id || `${exp.id}_${row.method}`;
        const existing = methodById.get(vid);
        if (!existing) continue;
        if (row.checkpoint_urls && !existing.checkpoints) {
          existing.checkpoints = row.checkpoint_urls;
        }
        if (row.preview_urls) existing.preview_urls = row.preview_urls;
        if (row.preview_series) existing.preview_series = row.preview_series;
        let touched = false;
        if (row.create_seconds != null && existing.create_seconds == null) {
          existing.create_seconds = row.create_seconds;
          touched = true;
        }
        if (row.wall_seconds != null && existing.wall_seconds == null) {
          existing.wall_seconds = row.wall_seconds;
          touched = true;
        }
        if (row.peak_vram_mib != null && existing.peak_vram_mib == null) {
          existing.peak_vram_mib = row.peak_vram_mib;
        }
        if (touched) api.refreshMethodOptionLabel?.(vid);
      }
    }
    if (explorerOpen) renderPanel();
    // Do not auto-swap PLYs on every experiment load — stay on final models
    // until the user scrubs. Only refresh rendered overlays if already in that mode.
    if (explorerOpen && viewMode === "rendered") applyRenderedViews();
  }

  function renderPanel() {
    if (explorerMeta) {
      explorerMeta.textContent = activeExp
        ? `${activeExp.label} · ${activeExp.campaign || "—"} · steps ${captureIters.join(", ") || "—"}`
        : "Open an experiment to inspect metrics, training curves, and capture steps.";
    }
    renderPipeline();
    renderProtocol();
    renderTable();
    renderCharts();
  }

  function displayJobState(job) {
    if (!job) return "idle";
    if (liveStale && job.status === "running") return "stale";
    return job.status || "idle";
  }

  function renderPipeline() {
    if (!pipelineEl) return;
    const job = liveJob;
    if (!job) {
      pipelineEl.innerHTML = `<p class="pipe-idle">No active launch. Start one with <code>python3 launch.py &lt;experiment&gt;</code>.</p>`;
      return;
    }
    const state = displayJobState(job);
    const methods = Array.isArray(job.methods) ? job.methods : [];
    const done = methods.filter((m) => m.status === "done" || m.status === "oom").length;
    const chips = methods
      .map(
        (m) =>
          `<span class="pipe-chip" data-status="${escapeHtml(m.status || "queued")}">${escapeHtml(m.id)} · ${escapeHtml(m.status || "queued")}</span>`,
      )
      .join("");
    const current = job.current_method ? `Current: ${job.current_method}` : "";
    const when = liveUpdatedAt ? `Updated ${liveUpdatedAt}` : "";
    pipelineEl.innerHTML = `
      <div class="pipe-head">
        <span class="pipe-label">${escapeHtml(job.label || job.experiment_id || "Launch")}</span>
        <span class="pipe-state" data-state="${escapeHtml(state)}">${escapeHtml(state)}</span>
        <span class="pipe-state">${done}/${methods.length || 0} methods</span>
      </div>
      <p class="pipe-meta">${escapeHtml([current, when].filter(Boolean).join(" · ") || "—")}</p>
      <div class="pipe-methods">${chips || `<span class="muted">No methods listed.</span>`}</div>
    `;
  }

  async function pollLive() {
    try {
      const res = await fetch("./live.json", { cache: "no-store" });
      if (res.status === 404) {
        setLive(null, null);
        return;
      }
      if (!res.ok) return;
      const data = await res.json();
      const job = data?.job ?? null;
      const updatedAt = data?.updated_at || null;
      let stale = false;
      if (job && job.status === "running" && updatedAt) {
        const t = Date.parse(updatedAt);
        if (!Number.isNaN(t) && Date.now() - t > LIVE_STALE_MS) stale = true;
      }
      setLive(job, updatedAt, stale);
    } catch {
      // Offline / missing file — keep last known state.
    }
  }

  function setLive(job, updatedAt, stale = false) {
    const prev = JSON.stringify({ job: liveJob, updatedAt: liveUpdatedAt, stale: liveStale });
    liveJob = job;
    liveUpdatedAt = updatedAt;
    liveStale = Boolean(stale);
    const next = JSON.stringify({ job: liveJob, updatedAt: liveUpdatedAt, stale: liveStale });
    if (prev === next) return;
    if (explorerOpen) renderPipeline();
    api.onLiveUpdate?.(liveJob, { stale: liveStale, updatedAt: liveUpdatedAt });
  }

  function renderProtocol() {
    if (!protocolEl) return;
    if (!activeExp) {
      protocolEl.innerHTML = "";
      return;
    }
    const cap = activeReport?.capture || activeExp.capture || {};
    const proto = activeReport?.protocol || {};
    const lines = [
      activeExp.description || activeReport?.description || "",
      `Campaign: ${activeExp.campaign || "—"}`,
      `Iters: ${proto.iters ?? "—"} · Holdout: ${proto.holdout ?? "every_8th"} · Scorer: ${proto.scorer ?? "unified_vgg_lpips"}`,
      `Capture: save_ply=${cap.save_ply ?? "?"} render_previews=${cap.render_previews ?? "?"} views=${
        (cap.preview_image_ids && cap.preview_image_ids.length)
          ? cap.preview_image_ids.join(",")
          : (cap.preview_views ?? "?")
      }`,
    ].filter(Boolean);
    protocolEl.innerHTML = lines.map((l) => `<p>${escapeHtml(l)}</p>`).join("");
  }

  function renderTable() {
    if (!tableEl) return;
    const rows = methodRows();
    const body = rows
      .map(
        (m) => `<tr>
        <td>${escapeHtml(shortLabel(m))}</td>
        <td>${escapeHtml(m.status || "—")}</td>
        <td>${fmt(m.psnr)}</td>
        <td>${fmt(m.ssim, 3)}</td>
        <td>${fmt(m.lpips, 3)}</td>
        <td>${fmtCount(m.num_gaussians)}</td>
        <td>${fmt(m.peak_vram_mib, 0)}</td>
        <td>${escapeHtml(fmtDuration(m.create_seconds ?? m.wall_seconds))}</td>
      </tr>`,
      )
      .join("");
    tableEl.innerHTML = `<table>
      <thead><tr>
        <th>Method</th><th>Status</th><th>PSNR</th><th>SSIM</th><th>LPIPS</th>
        <th>Gs</th><th>VRAM</th><th>Train</th>
      </tr></thead>
      <tbody>${body || `<tr><td colspan="8" class="muted">No report yet.</td></tr>`}</tbody>
    </table>`;
  }

  function renderCharts() {
    if (!chartsEl) return;
    chartsEl.innerHTML = "";
    const rows = methodRows();
    if (!rows.length) {
      chartsEl.innerHTML = `<p class="muted">Charts appear after a run publishes a report.</p>`;
      return;
    }

    // Checkpoint evaluation metrics (fixed-POV preview scores at capture steps).
    const psnrSeries = [];
    const ssimSeries = [];
    const lpipsSeries = [];
    for (const r of rows) {
      const series = Array.isArray(r.preview_series) ? r.preview_series : [];
      const pts = series
        .filter((p) => p.iteration != null)
        .map((p) => ({
          x: Number(p.iteration),
          y: p.psnr,
          ssim: p.ssim,
          lpips: p.lpips,
        }))
        .sort((a, b) => a.x - b.x);
      const psnrPts = pts.filter((p) => p.y != null).map((p) => ({ x: p.x, y: p.y }));
      const ssimPts = pts.filter((p) => p.ssim != null).map((p) => ({ x: p.x, y: p.ssim }));
      const lpipsPts = pts.filter((p) => p.lpips != null).map((p) => ({ x: p.x, y: p.lpips }));
      if (psnrPts.length >= 2) psnrSeries.push({ label: shortLabel(r), points: psnrPts });
      if (ssimPts.length >= 2) ssimSeries.push({ label: shortLabel(r), points: ssimPts });
      if (lpipsPts.length >= 2) lpipsSeries.push({ label: shortLabel(r), points: lpipsPts });
    }
    if (psnrSeries.length || ssimSeries.length || lpipsSeries.length) {
      const heading = document.createElement("h4");
      heading.textContent = "Checkpoint evaluation";
      chartsEl.appendChild(heading);
      const hint = document.createElement("p");
      hint.className = "muted";
      hint.style.margin = "0 0 8px";
      hint.textContent = "Fixed-POV preview scores at capture iterations. Click a point to scrub.";
      chartsEl.appendChild(hint);
    }
    if (psnrSeries.length) {
      chartsEl.appendChild(multiLineChart("PSNR vs iteration", psnrSeries, { onPointClick: (iter) => jumpToIter(iter) }));
    }
    if (ssimSeries.length) {
      chartsEl.appendChild(multiLineChart("SSIM vs iteration", ssimSeries, { onPointClick: (iter) => jumpToIter(iter) }));
    }
    if (lpipsSeries.length) {
      chartsEl.appendChild(multiLineChart("LPIPS vs iteration", lpipsSeries, { onPointClick: (iter) => jumpToIter(iter) }));
    }

    // Training traces (loss / VRAM).
    const lossSeries = [];
    const vramSeries = [];
    const gsSeries = [];
    for (const r of rows) {
      if (!Array.isArray(r.trace) || !r.trace.length) continue;
      const lossPts = r.trace
        .filter((t) => t.step != null && t.loss != null)
        .map((t) => ({ x: t.step, y: t.loss }));
      const vramPts = r.trace
        .filter((t) => (t.step != null || t.elapsed_seconds != null) && t.vram_mib != null)
        .map((t) => ({ x: t.step != null ? t.step : t.elapsed_seconds, y: t.vram_mib }));
      const gsPts = r.trace
        .filter((t) => t.step != null && t.num_gaussians != null)
        .map((t) => ({ x: t.step, y: t.num_gaussians }));
      if (lossPts.length >= 2) lossSeries.push({ label: shortLabel(r), points: lossPts });
      if (vramPts.length >= 2) vramSeries.push({ label: shortLabel(r), points: vramPts });
      if (gsPts.length >= 2) gsSeries.push({ label: shortLabel(r), points: gsPts });
    }
    if (lossSeries.length || vramSeries.length || gsSeries.length) {
      const heading = document.createElement("h4");
      heading.textContent = "Training";
      chartsEl.appendChild(heading);
    }
    if (lossSeries.length) chartsEl.appendChild(multiLineChart("Loss vs step", lossSeries));
    if (gsSeries.length) chartsEl.appendChild(multiLineChart("Gaussians vs step", gsSeries));
    if (vramSeries.length) chartsEl.appendChild(multiLineChart("VRAM MiB vs step", vramSeries));

    if (!chartsEl.children.length) {
      chartsEl.innerHTML = `<p class="muted">No training traces or checkpoint preview scores yet.</p>`;
    }
  }

  setViewMode("interactive");
  renderPipeline();
  pollLive();
  setInterval(pollLive, LIVE_POLL_MS);

  return {
    loadReport,
    jumpToIter,
    applyIteration: jumpToIter,
    setExplorerOpen,
    getCurrentIter: () => currentIter,
    getCaptureIters: () => captureIters,
    isOpen: () => explorerOpen,
    getLiveJob: () => liveJob,
  };
}

function shortLabel(r) {
  return String(r.label || r.method || "").replace(/^\[[^\]]+\]\s*/, "");
}

function fmt(v, digits = 2) {
  if (v == null || Number.isNaN(Number(v))) return "—";
  return Number(v).toFixed(digits);
}

function fmtCount(n) {
  if (n == null) return "—";
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}

function fmtDuration(seconds) {
  if (seconds == null || Number.isNaN(Number(seconds))) return "—";
  const total = Math.max(0, Math.round(Number(seconds)));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const SERIES_COLORS = ["#3d8bfd", "#3fb950", "#d29922", "#f85149", "#a371f7", "#39c5cf"];

function multiLineChart(title, seriesList, { onPointClick } = {}) {
  const wrap = document.createElement("div");
  wrap.className = "hq-chart";
  const h = document.createElement("h4");
  h.textContent = title;
  wrap.appendChild(h);
  const w = 360;
  const height = 180;
  const padL = 48;
  const padR = 12;
  const padT = 14;
  const padB = 36;
  const allX = seriesList.flatMap((s) => s.points.map((p) => p.x));
  const allY = seriesList.flatMap((s) => s.points.map((p) => p.y));
  const xmin = Math.min(...allX);
  const xmax = Math.max(...allX);
  let ymin = Math.min(...allY);
  let ymax = Math.max(...allY);
  if (ymin === ymax) {
    ymin -= 1;
    ymax += 1;
  }
  const xscale = (x) => padL + ((x - xmin) / (xmax - xmin || 1)) * (w - padL - padR);
  const yscale = (y) => height - padB - ((y - ymin) / (ymax - ymin || 1)) * (height - padT - padB);
  const xticks = niceTicks(xmin, xmax, 4);
  const yticks = niceTicks(ymin, ymax, 4);
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${w} ${height}`);
  svg.setAttribute("width", "100%");
  svg.setAttribute("height", String(height));
  let grid = "";
  grid += `<line x1="${padL}" y1="${height - padB}" x2="${w - padR}" y2="${height - padB}" stroke="#2a3140"/>`;
  grid += `<line x1="${padL}" y1="${padT}" x2="${padL}" y2="${height - padB}" stroke="#2a3140"/>`;
  for (const x of xticks) {
    const px = xscale(x);
    grid += `<line x1="${px}" y1="${padT}" x2="${px}" y2="${height - padB}" stroke="#2a314033"/>`;
    grid += `<text x="${px}" y="${height - 10}" font-size="10" fill="#8b949e" text-anchor="middle">${fmtTick(x)}</text>`;
  }
  for (const y of yticks) {
    const py = yscale(y);
    grid += `<line x1="${padL}" y1="${py}" x2="${w - padR}" y2="${py}" stroke="#2a314033"/>`;
    grid += `<text x="${padL - 6}" y="${py + 3}" font-size="10" fill="#8b949e" text-anchor="end">${fmtTick(y)}</text>`;
  }
  grid += `<text x="${(padL + w - padR) / 2}" y="${height - 1}" font-size="10" fill="#8b949e" text-anchor="middle">iteration / step</text>`;
  svg.innerHTML = grid;
  seriesList.forEach((s, si) => {
    const color = SERIES_COLORS[si % SERIES_COLORS.length];
    let d = "";
    s.points.forEach((p, i) => {
      d += `${i ? "L" : "M"}${xscale(p.x)},${yscale(p.y)} `;
    });
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", color);
    path.setAttribute("stroke-width", "2");
    svg.appendChild(path);
    for (const p of s.points) {
      const c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      c.setAttribute("cx", String(xscale(p.x)));
      c.setAttribute("cy", String(yscale(p.y)));
      c.setAttribute("r", "3.5");
      c.setAttribute("fill", color);
      c.setAttribute("stroke", "#0e1116");
      c.setAttribute("stroke-width", "1");
      if (onPointClick) {
        c.style.cursor = "pointer";
        c.addEventListener("click", () => onPointClick(Number(p.x)));
      }
      svg.appendChild(c);
    }
  });
  wrap.appendChild(svg);
  const legend = seriesList
    .map((s, si) => {
      const color = SERIES_COLORS[si % SERIES_COLORS.length];
      return `<span style="color:${color};margin-right:8px">${escapeHtml(s.label)}</span>`;
    })
    .join("");
  wrap.insertAdjacentHTML("beforeend", `<div class="muted" style="font-size:11px">${legend}</div>`);
  return wrap;
}

function niceTicks(min, max, count) {
  if (!Number.isFinite(min) || !Number.isFinite(max) || count < 2) return [min, max];
  const span = max - min || 1;
  const step = Math.pow(10, Math.floor(Math.log10(span / (count - 1))));
  const err = (count - 1) / (span / step);
  let niceStep = step;
  if (err <= 1.5) niceStep = step;
  else if (err <= 3) niceStep = step * 2;
  else if (err <= 7) niceStep = step * 5;
  else niceStep = step * 10;
  const start = Math.ceil(min / niceStep) * niceStep;
  const ticks = [];
  for (let v = start; v <= max + niceStep * 1e-9; v += niceStep) ticks.push(v);
  if (!ticks.length) ticks.push(min, max);
  return ticks;
}

function fmtTick(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 1000) return n.toFixed(0);
  if (Math.abs(n) >= 10) return n.toFixed(1);
  if (Math.abs(n) >= 1) return n.toFixed(2);
  return n.toFixed(3);
}
