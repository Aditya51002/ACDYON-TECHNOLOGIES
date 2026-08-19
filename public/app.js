// State Management
const state = {
  activeTab: 'pipeline',
  sources: [],
  metrics: {},
  health: {},
  jobs: [],
  pagination: { page: 1, limit: 12, total: 0, totalPages: 1 },
  filters: {
    search: '',
    tier: '',
    remote: '',
    sort: 'posted_at'
  },
  runs: [],
  isIngesting: false
};

// DOM Elements
const el = {
  statTotalJobs: document.getElementById('stat-total-jobs'),
  statDedupRate: document.getElementById('stat-dedup-rate'),
  statTotalRuns: document.getElementById('stat-total-runs'),
  healthBadge: document.getElementById('system-health-badge'),
  healthText: document.getElementById('health-status-text'),
  jobsBadge: document.getElementById('jobs-count-badge'),
  navTabs: document.querySelectorAll('.nav-tab'),
  tabPanes: document.querySelectorAll('.tab-pane'),
  btnTriggerAll: document.getElementById('btn-trigger-all'),
  btnSimulateOutage: document.getElementById('btn-simulate-outage'),
  btnSimulateDrift: document.getElementById('btn-simulate-drift'),
  selectSingleSource: document.getElementById('select-single-source'),
  btnTriggerSingle: document.getElementById('btn-trigger-single'),
  tier1List: document.getElementById('tier-1-sources-list'),
  tier2List: document.getElementById('tier-2-sources-list'),
  tier3List: document.getElementById('tier-3-sources-list'),
  liveLogs: document.getElementById('pipeline-live-logs'),
  btnClearLogs: document.getElementById('btn-clear-logs'),
  filterSearch: document.getElementById('filter-search'),
  filterTier: document.getElementById('filter-tier'),
  filterRemote: document.getElementById('filter-remote'),
  filterSort: document.getElementById('filter-sort'),
  btnResetFilters: document.getElementById('btn-reset-filters'),
  jobsCount: document.getElementById('jobs-results-count'),
  jobsGrid: document.getElementById('jobs-grid-container'),
  paginationControls: document.getElementById('pagination-controls'),
  telemetryDedupRate: document.getElementById('telemetry-dedup-rate'),
  tierDistBars: document.getElementById('tier-dist-bars'),
  telemetrySuccess: document.getElementById('telemetry-runs-success'),
  telemetryCache: document.getElementById('telemetry-runs-cache'),
  telemetryDrift: document.getElementById('telemetry-runs-drift'),
  runsTableBody: document.getElementById('runs-table-body'),
  modal: document.getElementById('job-detail-modal'),
  modalTitle: document.getElementById('modal-job-title'),
  modalContent: document.getElementById('modal-job-content'),
  modalCloseBtn: document.getElementById('modal-close-btn')
};

// Initialize Application
document.addEventListener('DOMContentLoaded', async () => {
  setupTabs();
  setupFilters();
  setupTriggers();
  setupModal();

  await refreshAll();

  // Poll health and metrics periodically
  setInterval(refreshHealthAndMetrics, 15000);
});

// Tab Switching
function setupTabs() {
  el.navTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.tab;
      el.navTabs.forEach(t => t.classList.remove('active'));
      el.tabPanes.forEach(p => p.classList.remove('active'));

      tab.classList.add('active');
      const pane = document.getElementById(`tab-${target}`);
      if (pane) pane.classList.add('active');
      state.activeTab = target;

      if (target === 'jobs') fetchJobs();
      if (target === 'telemetry') fetchRuns();
    });
  });
}

// Log Terminal Stream
function appendLog(message, type = 'info') {
  const line = document.createElement('div');
  line.className = `log-line log-${type}`;
  const timestamp = new Date().toLocaleTimeString();
  line.textContent = `[${timestamp}] ${message}`;
  el.liveLogs.appendChild(line);
  el.liveLogs.scrollTop = el.liveLogs.scrollHeight;
}

if (el.btnClearLogs) {
  el.btnClearLogs.addEventListener('click', () => {
    el.liveLogs.innerHTML = '';
    appendLog('Live event log cleared.', 'info');
  });
}

// Setup Event Triggers
function setupTriggers() {
  el.btnTriggerAll.addEventListener('click', async () => {
    if (state.isIngesting) return;
    setIngesting(true);
    appendLog('🚀 Triggering full pipeline ingestion across all enabled sources...', 'cyan');

    try {
      const res = await fetch('/api/pipeline/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      const data = await res.json();
      if (data.success && data.results) {
        data.results.forEach(r => logRunResult(r));
      }
    } catch (err) {
      appendLog(`❌ Ingestion failed: ${err.message}`, 'error');
    } finally {
      setIngesting(false);
      await refreshAll();
    }
  });

  el.btnSimulateOutage.addEventListener('click', async () => {
    if (state.isIngesting) return;
    setIngesting(true);
    appendLog('⚠️ Simulating upstream network outage (HTTP 500)...', 'warn');

    try {
      const targetSource = el.selectSingleSource.value || 'greenhouse_figma';
      const res = await fetch('/api/pipeline/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceId: targetSource, simulateFailure: true })
      });
      const data = await res.json();
      if (data.success && data.run) {
        logRunResult(data.run);
      }
    } catch (err) {
      appendLog(`❌ Ingestion failed: ${err.message}`, 'error');
    } finally {
      setIngesting(false);
      await refreshAll();
    }
  });

  el.btnSimulateDrift.addEventListener('click', async () => {
    if (state.isIngesting) return;
    setIngesting(true);
    appendLog('🛑 Simulating corrupted upstream schema payload (Schema Drift test)...', 'error');

    try {
      const targetSource = el.selectSingleSource.value || 'remoteok';
      const res = await fetch('/api/pipeline/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceId: targetSource, simulateDrift: true })
      });
      const data = await res.json();
      if (data.success && data.run) {
        logRunResult(data.run);
      }
    } catch (err) {
      appendLog(`❌ Ingestion failed: ${err.message}`, 'error');
    } finally {
      setIngesting(false);
      await refreshAll();
    }
  });

  el.btnTriggerSingle.addEventListener('click', async () => {
    const sourceId = el.selectSingleSource.value;
    if (!sourceId) {
      alert('Please select a source first');
      return;
    }
    if (state.isIngesting) return;
    setIngesting(true);
    appendLog(`⚡ Triggering ingestion for single source: ${sourceId}...`, 'cyan');

    try {
      const res = await fetch('/api/pipeline/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceId })
      });
      const data = await res.json();
      if (data.success && data.run) {
        logRunResult(data.run);
      }
    } catch (err) {
      appendLog(`❌ Ingestion failed: ${err.message}`, 'error');
    } finally {
      setIngesting(false);
      await refreshAll();
    }
  });
}

function logRunResult(run) {
  if (run.status === 'success') {
    appendLog(
      `✔ [${run.sourceName}] Ingested ${run.itemsInserted} new jobs, deduped ${run.itemsDeduped} via content hashes in ${run.durationMs}ms`,
      'success'
    );
  } else if (run.status === 'degraded_cache') {
    appendLog(
      `⚠️ [${run.sourceName}] UPSTREAM DOWN: Recovered ${run.itemsParsed} jobs from last-known-good cache in ${run.durationMs}ms`,
      'warn'
    );
  } else if (run.status === 'drift_error') {
    appendLog(
      `🚨 [${run.sourceName}] SCHEMA DRIFT LOUD ESCALATION: ${run.errorMessage}`,
      'error'
    );
  } else {
    appendLog(`❌ [${run.sourceName}] Error: ${run.errorMessage}`, 'error');
  }
}

function setIngesting(loading) {
  state.isIngesting = loading;
  el.btnTriggerAll.disabled = loading;
  el.btnSimulateOutage.disabled = loading;
  el.btnSimulateDrift.disabled = loading;
  el.btnTriggerSingle.disabled = loading;

  if (loading) {
    el.btnTriggerAll.innerHTML = '<span class="status-indicator-dot"></span> Ingesting...';
  } else {
    el.btnTriggerAll.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg> Run All Enabled Sources';
  }
}

// Refresh Data Hub
async function refreshAll() {
  await Promise.all([
    fetchHealth(),
    fetchMetrics(),
    fetchSources(),
    fetchJobs(),
    fetchRuns()
  ]);
}

async function refreshHealthAndMetrics() {
  await Promise.all([fetchHealth(), fetchMetrics()]);
}

// Fetch Health Status
async function fetchHealth() {
  try {
    const res = await fetch('/health');
    const data = await res.json();
    state.health = data;

    if (data.status === 'healthy') {
      el.healthBadge.className = 'status-indicator-badge healthy';
      el.healthText.textContent = 'System Healthy';
    } else {
      el.healthBadge.className = 'status-indicator-badge degraded';
      el.healthText.textContent = 'Degraded';
    }
  } catch {
    el.healthBadge.className = 'status-indicator-badge drift';
    el.healthText.textContent = 'Offline';
  }
}

// Fetch Summary Metrics
async function fetchMetrics() {
  try {
    const res = await fetch('/api/metrics');
    const json = await res.json();
    if (json.success && json.data) {
      state.metrics = json.data;
      updateHeaderStats(json.data);
      updateTelemetryView(json.data);
    }
  } catch (err) {
    console.error('Failed to fetch metrics:', err);
  }
}

function updateHeaderStats(m) {
  el.statTotalJobs.textContent = m.totalJobs || 0;
  el.statDedupRate.textContent = `${m.deduplicationRatePercent || 0}%`;
  el.statTotalRuns.textContent = m.totalRuns || 0;
  el.jobsBadge.textContent = m.totalJobs || 0;
}

function updateTelemetryView(m) {
  el.telemetryDedupRate.textContent = `${m.deduplicationRatePercent || 0}%`;
  el.telemetrySuccess.textContent = m.statusDistribution?.success || 0;
  el.telemetryCache.textContent = m.statusDistribution?.degraded_cache || 0;
  el.telemetryDrift.textContent = m.statusDistribution?.drift_error || 0;

  // Render Tier volume distribution bars
  const total = m.totalJobs || 1;
  const t1 = m.tierDistribution?.tier_1 || 0;
  const t2 = m.tierDistribution?.tier_2 || 0;
  const t3 = m.tierDistribution?.tier_3 || 0;

  el.tierDistBars.innerHTML = `
    <div class="dist-bar-row">
      <span class="dist-bar-label">Tier 1 (ATS)</span>
      <div class="dist-bar-track">
        <div class="dist-bar-fill tier-1" style="width: ${(t1 / total) * 100}%"></div>
      </div>
      <span class="dist-bar-count">${t1}</span>
    </div>
    <div class="dist-bar-row">
      <span class="dist-bar-label">Tier 2 (Open)</span>
      <div class="dist-bar-track">
        <div class="dist-bar-fill tier-2" style="width: ${(t2 / total) * 100}%"></div>
      </div>
      <span class="dist-bar-count">${t2}</span>
    </div>
    <div class="dist-bar-row">
      <span class="dist-bar-label">Tier 3 (Agg)</span>
      <div class="dist-bar-track">
        <div class="dist-bar-fill tier-3" style="width: ${(t3 / total) * 100}%"></div>
      </div>
      <span class="dist-bar-count">${t3}</span>
    </div>
  `;
}

// Fetch Sources & Render Router
async function fetchSources() {
  try {
    const res = await fetch('/api/sources');
    const json = await res.json();
    if (json.success && json.data) {
      state.sources = json.data;
      renderSourceSelector(json.data);
      renderSourceRouterCards(json.data);
    }
  } catch (err) {
    console.error('Failed to fetch sources:', err);
  }
}

function renderSourceSelector(sources) {
  const currentVal = el.selectSingleSource.value;
  el.selectSingleSource.innerHTML = '<option value="">-- Choose specific source --</option>';
  sources.forEach(s => {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = `[Tier ${s.tier}] ${s.name}`;
    el.selectSingleSource.appendChild(opt);
  });
  if (currentVal) el.selectSingleSource.value = currentVal;
}

function renderSourceRouterCards(sources) {
  const t1 = sources.filter(s => s.tier === 1);
  const t2 = sources.filter(s => s.tier === 2);
  const t3 = sources.filter(s => s.tier === 3);

  const renderList = (items, container) => {
    container.innerHTML = items.map(s => {
      let statusClass = 'idle';
      let statusText = s.last_status || 'READY';
      if (s.last_status === 'success') statusClass = 'success';
      if (s.last_status === 'degraded_cache') statusClass = 'degraded';
      if (s.last_status === 'drift_error') statusClass = 'drift';

      return `
        <div class="source-item">
          <div class="source-item-left">
            <span class="source-title">${escapeHtml(s.name)}</span>
            <span class="source-endpoint" title="${escapeHtml(s.endpoint)}">${escapeHtml(s.endpoint)}</span>
          </div>
          <span class="source-status-tag ${statusClass}">${statusText.toUpperCase()}</span>
        </div>
      `;
    }).join('');
  };

  renderList(t1, el.tier1List);
  renderList(t2, el.tier2List);
  renderList(t3, el.tier3List);
}

// Jobs Explorer Filters & Querying
function setupFilters() {
  let debounceTimeout = null;

  el.filterSearch.addEventListener('input', (e) => {
    clearTimeout(debounceTimeout);
    debounceTimeout = setTimeout(() => {
      state.filters.search = e.target.value;
      state.pagination.page = 1;
      fetchJobs();
    }, 300);
  });

  el.filterTier.addEventListener('change', (e) => {
    state.filters.tier = e.target.value;
    state.pagination.page = 1;
    fetchJobs();
  });

  el.filterRemote.addEventListener('change', (e) => {
    state.filters.remote = e.target.value;
    state.pagination.page = 1;
    fetchJobs();
  });

  el.filterSort.addEventListener('change', (e) => {
    state.filters.sort = e.target.value;
    state.pagination.page = 1;
    fetchJobs();
  });

  el.btnResetFilters.addEventListener('click', () => {
    el.filterSearch.value = '';
    el.filterTier.value = '';
    el.filterRemote.value = '';
    el.filterSort.value = 'posted_at';
    state.filters = { search: '', tier: '', remote: '', sort: 'posted_at' };
    state.pagination.page = 1;
    fetchJobs();
  });
}

// Fetch Jobs
async function fetchJobs() {
  try {
    const params = new URLSearchParams({
      page: state.pagination.page,
      limit: state.pagination.limit,
      search: state.filters.search,
      tier: state.filters.tier,
      isRemote: state.filters.remote,
      sortBy: state.filters.sort
    });

    const res = await fetch(`/jobs?${params.toString()}`);
    const json = await res.json();

    if (json.success) {
      state.jobs = json.data;
      state.pagination = json.pagination;
      renderJobsGrid(json.data);
      renderPagination(json.pagination);
    }
  } catch (err) {
    console.error('Failed to fetch jobs:', err);
    el.jobsGrid.innerHTML = `<div class="log-error">Failed to load jobs: ${err.message}</div>`;
  }
}

function renderJobsGrid(jobs) {
  el.jobsCount.textContent = `Showing ${jobs.length} of ${state.pagination.total} listings`;

  if (jobs.length === 0) {
    el.jobsGrid.innerHTML = `
      <div class="glass-panel" style="grid-column: 1 / -1; padding: 3rem; text-align: center;">
        <h4 style="color: var(--text-secondary); margin-bottom: 0.5rem;">No job listings found</h4>
        <p style="color: var(--text-muted); font-size: 0.88rem; margin-bottom: 1.5rem;">Try running ingestion from the Pipeline tab or clearing search filters.</p>
        <button class="btn btn-primary" onclick="document.querySelector('[data-tab=pipeline]').click()">Go to Pipeline Dispatcher</button>
      </div>
    `;
    return;
  }

  el.jobsGrid.innerHTML = jobs.map(job => {
    const tierBadgeClass = `tier-${job.source_tier}`;
    const tierLabel = job.source_tier === 1 ? 'Tier 1 • ATS' : (job.source_tier === 2 ? 'Tier 2 • Public' : 'Tier 3 • Aggregator');
    const salaryText = job.salary_raw || (job.salary_min && job.salary_max ? `$${job.salary_min.toLocaleString()} - $${job.salary_max.toLocaleString()}` : null);
    const shortHash = job.content_hash ? job.content_hash.slice(0, 10) + '...' : 'hash_n/a';
    const postedDate = job.posted_at ? new Date(job.posted_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : 'Recent';

    return `
      <div class="job-card">
        <div>
          <div class="job-card-top">
            <span class="job-company">${escapeHtml(job.company)}</span>
            <span class="tier-badge-pill ${tierBadgeClass}">${tierLabel}</span>
          </div>

          <h3 class="job-title">${escapeHtml(job.title)}</h3>

          <div class="job-meta-row">
            <span class="meta-pill">
              <svg style="width:14px;height:14px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
              ${escapeHtml(job.location || 'Remote')}
            </span>
            ${job.is_remote ? '<span class="meta-pill highlight-emerald">Remote</span>' : ''}
            <span class="meta-pill">${escapeHtml(job.job_type || 'Full-time')}</span>
            ${salaryText ? `<span class="meta-pill salary">${escapeHtml(salaryText)}</span>` : ''}
          </div>

          <div class="job-tags">
            ${(job.tags || []).slice(0, 5).map(t => `<span class="tag-pill">${escapeHtml(t)}</span>`).join('')}
          </div>
        </div>

        <div class="job-card-bottom">
          <button class="hash-btn" onclick="viewJobModal('${job.id}')" title="Inspect SHA-256 Deduplication Hash & Canonical Schema">
            <svg style="width:13px;height:13px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
            ${shortHash}
          </button>
          
          <div style="display: flex; gap: 0.85rem; align-items: center;">
            <span style="color: var(--text-muted); font-size: 0.75rem;">${postedDate}</span>
            <a href="${escapeHtml(job.url)}" target="_blank" rel="noopener noreferrer" class="apply-link">
              Apply
              <svg style="width:13px;height:13px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
            </a>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

function renderPagination(p) {
  if (p.totalPages <= 1) {
    el.paginationControls.innerHTML = '';
    return;
  }

  el.paginationControls.innerHTML = `
    <button class="pagination-btn" ${p.page <= 1 ? 'disabled' : ''} onclick="changePage(${p.page - 1})">&laquo; Prev</button>
    <span style="font-size: 0.8rem; color: var(--text-muted);">Page ${p.page} of ${p.totalPages}</span>
    <button class="pagination-btn" ${p.page >= p.totalPages ? 'disabled' : ''} onclick="changePage(${p.page + 1})">Next &raquo;</button>
  `;
}

window.changePage = (newPage) => {
  state.pagination.page = newPage;
  fetchJobs();
  window.scrollTo({ top: 0, behavior: 'smooth' });
};

// Fetch Runs History
async function fetchRuns() {
  try {
    const res = await fetch('/runs?limit=30');
    const json = await res.json();
    if (json.success && json.data) {
      state.runs = json.data;
      renderRunsTable(json.data);
    }
  } catch (err) {
    console.error('Failed to fetch runs:', err);
  }
}

function renderRunsTable(runs) {
  if (runs.length === 0) {
    el.runsTableBody.innerHTML = `<tr><td colspan="11" style="text-align: center; color: var(--text-muted); padding: 2rem;">No ingestion runs recorded yet.</td></tr>`;
    return;
  }

  el.runsTableBody.innerHTML = runs.map(r => {
    const dateStr = new Date(r.started_at).toLocaleTimeString();
    const statusClass = `status-badge ${r.status}`;
    const tierBadge = `<span class="tier-badge-pill tier-${r.source_tier}">T${r.source_tier}</span>`;
    const diagText = r.error_message || (r.drift_details ? 'Drift logged' : 'Clean');

    return `
      <tr>
        <td style="font-family: var(--font-mono); font-size: 0.78rem;">${dateStr}</td>
        <td style="font-weight: 500; color: var(--text-primary);">${escapeHtml(r.source_name)}</td>
        <td>${tierBadge}</td>
        <td><span class="${statusClass}">${r.status}</span></td>
        <td style="font-family: var(--font-mono);">${r.items_fetched}</td>
        <td style="font-family: var(--font-mono);">${r.items_parsed}</td>
        <td style="font-family: var(--font-mono); color: var(--accent-cyan);">${r.items_inserted}</td>
        <td style="font-family: var(--font-mono); color: var(--accent-emerald);">${r.items_deduped}</td>
        <td style="font-family: var(--font-mono); color: var(--accent-crimson);">${r.items_skipped}</td>
        <td style="font-family: var(--font-mono);">${r.duration_ms}ms</td>
        <td style="font-size: 0.75rem; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${escapeHtml(diagText)}">
          ${escapeHtml(diagText)}
        </td>
      </tr>
    `;
  }).join('');
}

// Modal Setup & Inspection
function setupModal() {
  el.modalCloseBtn.addEventListener('click', () => {
    el.modal.classList.remove('open');
  });

  el.modal.addEventListener('click', (e) => {
    if (e.target === el.modal) {
      el.modal.classList.remove('open');
    }
  });
}

window.viewJobModal = async (jobId) => {
  try {
    const res = await fetch(`/jobs/${jobId}`);
    const json = await res.json();
    if (json.success && json.data) {
      const j = json.data;
      el.modalTitle.textContent = `${j.company} — ${j.title}`;
      el.modalContent.innerHTML = `
        <div style="margin-bottom: 1rem;">
          <div style="font-size: 0.78rem; text-transform: uppercase; color: var(--text-muted); margin-bottom: 0.35rem;">Deterministic Deduplication Fingerprint (SHA-256)</div>
          <div style="background: #050810; padding: 0.6rem 0.85rem; border-radius: 4px; font-family: var(--font-mono); font-size: 0.8rem; color: var(--accent-cyan); border: 1px solid var(--border-color); word-break: break-all;">
            ${j.content_hash}
          </div>
        </div>

        <div style="margin-bottom: 1rem;">
          <div style="font-size: 0.78rem; text-transform: uppercase; color: var(--text-muted); margin-bottom: 0.35rem;">Canonical Normalized Job Schema</div>
          <pre class="json-viewer">${escapeHtml(JSON.stringify(j, null, 2))}</pre>
        </div>

        <div style="display: flex; justify-content: flex-end; gap: 0.75rem;">
          <a href="${escapeHtml(j.url)}" target="_blank" class="btn btn-primary">Open Application URL</a>
        </div>
      `;
      el.modal.classList.add('open');
    }
  } catch (err) {
    alert(`Failed to load job details: ${err.message}`);
  }
};

// HTML Escaping utility
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
