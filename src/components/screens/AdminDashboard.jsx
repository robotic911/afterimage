import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './AdminDashboard.css';
import { versionTemplateAssetSrc } from '../../lib/templateAssetUrl';
import { LAYOUTS } from '../../constants/layouts';
import { useStats } from '../../hooks/useStats';
import { getSessionKeychainSummary } from '../../lib/salesMetrics';

// Admin dashboard — revenue, copies and session counts with a 30-day
// trend chart, per-template breakdown and a recent-sessions table.
// Pulls aggregated data from the main process via adminApi.getStats().

const IS_DEV = import.meta.env.DEV;

const peso = (n) =>
  '₱' + (Number(n) || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const fmtInt = (n) => (Number(n) || 0).toLocaleString('en-PH');

const fmtDateTime = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const date = new Intl.DateTimeFormat('en-PH', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(d);
  const time = new Intl.DateTimeFormat('en-PH', {
    hour: 'numeric',
    minute: '2-digit',
  }).format(d);
  return `${date} • ${time}`;
};

const fmtLongDate = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('en-PH', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(d);
};

const fmtUpdatedAt = (iso) => {
  if (!iso) return 'No data yet';
  return `Last updated: ${fmtDateTime(iso)}`;
};

const getBucketStripRevenue = (bucket = {}) => Number(bucket.stripRevenue ?? bucket.revenue ?? 0) || 0;
const getBucketKeychainRevenue = (bucket = {}) => Number(bucket.keychainRevenue ?? 0) || 0;
const getBucketTotalRevenue = (bucket = {}) => {
  const explicit = Number(bucket.totalRevenue ?? bucket.revenue);
  if (Number.isFinite(explicit)) return explicit;
  return getBucketStripRevenue(bucket) + getBucketKeychainRevenue(bucket);
};

const fmtDuration = (ms) => {
  if (!Number.isFinite(+ms)) return '—';
  const secs = Math.round(+ms / 1000);
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}m ${s}s`;
};

const getSessionStatusLabel = (status) => {
  if (status === 'failed') return 'failed';
  if (status === 'cancelled') return 'cancelled';
  if (status === 'partial') return 'partial';
  return 'completed';
};

const getStatusPillClass = (status) => {
  if (status === 'failed') return 'bad';
  if (status === 'completed') return 'good';
  return '';
};

const normalizeTemplateName = (name) => (name || 'Untitled template').trim().replace(/\s+/g, ' ');

function clampPage(page, totalPages) {
  return Math.min(Math.max(page, 1), Math.max(totalPages, 1));
}

function getPaginationRange(page, pageSize, total) {
  const safeTotal = Math.max(0, Number(total) || 0);
  const safePageSize = Math.max(1, Number(pageSize) || 10);
  const safePage = Math.max(1, Number(page) || 1);
  const start = safeTotal === 0 ? 0 : (safePage - 1) * safePageSize + 1;
  const end = Math.min(safePage * safePageSize, safeTotal);
  return { start, end };
}

export default function AdminDashboard({
  active = true,
  events = [],
  settings = {},
  templates = [],
}) {
  const [eventFilter, setEventFilter] = useState('all');
  const [sessionTypeFilter, setSessionTypeFilter] = useState('real');
  const [recentSessionsPage, setRecentSessionsPage] = useState(1);
  const [recentSessionsPageSize, setRecentSessionsPageSize] = useState(10);
  const [showAllTemplates, setShowAllTemplates] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [confirmTodayReset, setConfirmTodayReset] = useState(false);
  const [statusMsg, setStatusMsg] = useState(null);
  const [todayResetMsg, setTodayResetMsg] = useState(null);
  const [todayResetting, setTodayResetting] = useState(false);
  const [templateSort, setTemplateSort] = useState('revenue');
  const [barTooltip, setBarTooltip] = useState(null);
  const [sessionFilters, setSessionFilters] = useState({
    from: '',
    to: '',
    template: 'all',
    status: 'all',
    search: '',
  });
  const updateSessionFilters = (patch) => {
    setSessionFilters((current) => ({ ...current, ...patch }));
    setRecentSessionsPage(1);
  };
  const recentFilterPayload = useMemo(() => ({
    from: sessionFilters.from || null,
    to: sessionFilters.to || null,
    templateName: sessionFilters.template === 'all' ? null : sessionFilters.template,
    status: sessionFilters.status === 'all' ? null : sessionFilters.status,
    search: sessionFilters.search.trim() || null,
  }), [sessionFilters]);
  const recentOffset = (recentSessionsPage - 1) * recentSessionsPageSize;
  const { stats, recent, recentTotal, loading, error, refresh } = useStats({
    recentLimit: recentSessionsPageSize,
    recentOffset,
    eventFilter,
    sessionType: sessionTypeFilter,
    recentFilters: recentFilterPayload,
  });
  // Transient "pulse" when a new session comes in over IPC — gives a
  // visual cue that the dashboard just auto-updated.
  const [justUpdated, setJustUpdated] = useState(false);
  const pulseTimerRef = useRef(null);

  // Re-pull whenever the admin screen becomes active again (e.g. attendant
  // pressed Ctrl+Shift+A a second time while we were still mounted on the
  // dashboard tab). Skips the initial mount — useStats already handles that.
  const mountedOnceRef = useRef(false);

  const handleRefresh = useCallback(async () => {
    await refresh();
  }, [refresh]);

  useEffect(() => {
    if (!active) return;
    if (!mountedOnceRef.current) { mountedOnceRef.current = true; return; }
    refresh();
  }, [active, refresh]);

  // Live updates: main broadcasts on every session log / clear.
  useEffect(() => {
    if (!window.adminApi) return;
    const onLogged = () => {
      refresh();
      setJustUpdated(true);
      clearTimeout(pulseTimerRef.current);
      pulseTimerRef.current = setTimeout(() => setJustUpdated(false), 1600);
    };
    const unsubLog   = window.adminApi.onSessionLogged?.(onLogged);
    const unsubUpdate = window.adminApi.onSessionsUpdated?.(onLogged);
    const unsubClear = window.adminApi.onSessionsCleared?.(() => {
      refresh();
    });
    const unsubTodayReset = window.adminApi.onTodayMonitorRecordsReset?.(() => {
      refresh();
    });
    return () => {
      unsubLog?.();
      unsubUpdate?.();
      unsubClear?.();
      unsubTodayReset?.();
      clearTimeout(pulseTimerRef.current);
    };
  }, [refresh]);

  const { today, week, month, allTime } = stats.totals;
  const keychainStats = stats.keychains || {
    unitsSold: 0,
    revenue: 0,
    sheetsPrinted: 0,
    transactions: 0,
    recentSales: [],
  };
  const activeEvent = events.find((event) => event.id === settings.activeEventId) || null;
  const activeEvents = useMemo(
    () => events.filter((event) => event.enabled !== false),
    [events],
  );
  const softcopySettings = settings.softcopySettings || {};
  const enabledOutputs = [
    softcopySettings.photoEnabled !== false ? 'Photo' : null,
    softcopySettings.gifEnabled ? 'GIF' : null,
    softcopySettings.videoEnabled ? 'Video' : null,
  ].filter(Boolean);
  const templateLookup = useMemo(() => {
    const byId = new Map();
    const byName = new Map();
    for (const template of templates) {
      if (template.id) byId.set(template.id, template);
      const name = normalizeTemplateName(template.name).toLowerCase();
      if (!byName.has(name)) byName.set(name, template);
    }
    return { byId, byName };
  }, [templates]);

  // Scale the sparkline bars against the biggest day in the window so
  // short-revenue days don't shrink to zero-height slivers.
  const { maxDayRevenue, peakDay, hasRevenue } = useMemo(() => {
    let maxRevenue = 0;
    let peak = null;
    for (const d of stats.byDay) {
      const dayRevenue = getBucketTotalRevenue(d);
      if (dayRevenue > maxRevenue) {
        maxRevenue = dayRevenue;
        peak = d;
      }
    }
    return { maxDayRevenue: maxRevenue || 1, peakDay: peak, hasRevenue: maxRevenue > 0 };
  }, [stats.byDay]);

  const groupedTemplates = useMemo(() => {
    const grouped = new Map();
    for (const row of stats.byTemplate) {
      const name = normalizeTemplateName(row.templateName);
      const key = name.toLowerCase();
      const existing = grouped.get(key) || {
        templateName: name,
        templateIds: [],
        sessions: 0,
        copies: 0,
        revenue: 0,
        thumbnail: null,
      };
      existing.templateIds.push(row.templateId);
      existing.sessions += Number(row.sessions) || 0;
      existing.copies += Number(row.copies) || 0;
      existing.revenue += Number(row.revenue) || 0;
      const matched = templateLookup.byId.get(row.templateId)
        || templateLookup.byName.get(key);
      if (!existing.thumbnail && matched) {
        existing.thumbnail = matched.previewSrc
          ? versionTemplateAssetSrc(matched.previewSrc, matched)
          : null;
      }
      grouped.set(key, existing);
    }
    return [...grouped.values()].sort((a, b) => {
      const delta = (b[templateSort] || 0) - (a[templateSort] || 0);
      return delta || a.templateName.localeCompare(b.templateName);
    });
  }, [stats.byTemplate, templateLookup, templateSort]);
  const recentTemplateOptions = useMemo(() => (
    stats.byTemplate
      .map((template) => normalizeTemplateName(template.templateName))
      .filter((name, index, arr) => arr.indexOf(name) === index)
      .sort((a, b) => a.localeCompare(b))
  ), [stats.byTemplate]);

  const recentPageCount = recentTotal > 0 ? Math.ceil(recentTotal / recentSessionsPageSize) : 0;
  const resolvedRecentPage = recentPageCount > 0
    ? clampPage(recentSessionsPage, recentPageCount)
    : 1;
  const recentRange = getPaginationRange(resolvedRecentPage, recentSessionsPageSize, recentTotal);
  const visibleRecent = recent;
  const visibleTemplates = showAllTemplates ? groupedTemplates : groupedTemplates.slice(0, 10);
  useEffect(() => {
    queueMicrotask(() => {
      setRecentSessionsPage((page) => clampPage(page, recentPageCount || 1));
    });
  }, [recentPageCount]);

  useEffect(() => {
    if (eventFilter === 'all' || eventFilter === 'daily') return;
    if (activeEvents.some((event) => event.id === eventFilter)) return;
    queueMicrotask(() => {
      setEventFilter('all');
      setRecentSessionsPage(1);
    });
  }, [activeEvents, eventFilter]);

  useEffect(() => {
    if (IS_DEV) console.log('[dashboard] active event filter options', activeEvents);
  }, [activeEvents]);

  useEffect(() => {
    console.log('[dashboard] session type filter', sessionTypeFilter);
  }, [sessionTypeFilter]);

  const positionBarTooltip = useCallback((day, event) => {
    if (!day || !event) return;
    const width = 240;
    const height = 104;
    const margin = 14;
    const x = Math.min(event.clientX + 16, Math.max(margin, window.innerWidth - width - margin));
    const y = Math.min(event.clientY + 16, Math.max(margin, window.innerHeight - height - margin));
    setBarTooltip({
      x: Math.max(margin, x),
      y: Math.max(margin, y),
      day,
    });
  }, []);

  const handleBarEnter = useCallback((day, event) => {
    if (IS_DEV) console.log('[dashboard] bar hover', { date: day?.date, revenue: day?.revenue });
    positionBarTooltip(day, event);
  }, [positionBarTooltip]);

  const handleBarMove = useCallback((day, event) => {
    positionBarTooltip(day, event);
  }, [positionBarTooltip]);

  const handleBarLeave = useCallback(() => {
    setBarTooltip(null);
  }, []);

  const doClear = async () => {
    setConfirmClear(false);
    if (!window.adminApi?.clearSessions) {
      setStatusMsg('Not available in this environment.');
      return;
    }
    const res = await window.adminApi.clearSessions();
    if (res?.ok) {
      await handleRefresh();
      setStatusMsg('Session history cleared.');
    } else {
      setStatusMsg('Clear failed: ' + (res?.error || 'unknown'));
    }
    setTimeout(() => setStatusMsg(null), 2600);
  };

  const doResetTodayMonitor = async () => {
    setConfirmTodayReset(false);
    if (todayResetting) return;
    const resetTodayRecords =
      window.todayMonitorApi?.resetTodayRecords
      || window.adminApi?.resetTodayMonitorRecords;

    console.log('[today-monitor reset UI] clicked', {
      hasApi: Boolean(resetTodayRecords),
    });

    if (!resetTodayRecords) {
      console.error('[Reset Today Monitor] API unavailable', {
        hasTodayMonitorApi: Boolean(window.todayMonitorApi),
        keys: window.todayMonitorApi ? Object.keys(window.todayMonitorApi) : [],
        hasAdminApi: Boolean(window.adminApi),
        adminKeys: window.adminApi ? Object.keys(window.adminApi) : [],
      });
      setTodayResetMsg('Reset API unavailable. Please restart the Electron app.');
      return;
    }

    setTodayResetting(true);
    try {
      const res = await resetTodayRecords();
      console.log('[today-monitor reset UI] result', res);
      if (!res?.ok) {
        throw new Error(res?.error || 'unknown error');
      }
      setTodayResetMsg('Today Monitor records reset.');
    } catch (err) {
      setTodayResetMsg(`Failed to reset Today Monitor records: ${err?.message || String(err)}`);
    } finally {
      setTodayResetting(false);
      setTimeout(() => setTodayResetMsg(null), 2600);
    }
  };

  return (
    <div className="dash-root">
      <div className="dash-header">
        <div className="dash-header-left">
          <div className="dash-title-row">
            <div className="dash-title">Dashboard</div>
            <span className={`dash-live ${justUpdated ? 'pulse' : ''}`}>
              <span className="dash-live-dot" />
              {justUpdated ? 'Just updated' : 'Live'}
            </span>
          </div>
          <div className="dash-deck">Live business overview for sessions, copies, and revenue.</div>
          <div className="dash-sub">{loading ? 'Loading dashboard data...' : fmtUpdatedAt(stats.generatedAt)}</div>
        </div>
        <div className="dash-header-actions">
          <select
            className="dash-filter-select"
            value={eventFilter}
            onChange={(e) => {
              setEventFilter(e.target.value);
              setRecentSessionsPage(1);
            }}
          >
            <option value="all">All Sessions</option>
            <option value="daily">Daily Mode</option>
            {activeEvents.length === 0 ? (
              <option value="none" disabled>No active events</option>
            ) : (
              activeEvents.map((event) => (
                <option key={event.id} value={event.id}>
                  Event: {event.name}
                </option>
              ))
            )}
          </select>
          <select
            className="dash-filter-select"
            value={sessionTypeFilter}
            onChange={(e) => {
              setSessionTypeFilter(e.target.value);
              setRecentSessionsPage(1);
            }}
          >
            <option value="real">Real Sessions</option>
            <option value="test">Test Sessions</option>
            <option value="all">All Sessions</option>
          </select>
          <button className="admin-btn ghost" onClick={handleRefresh}>↻ Refresh</button>
          <button className="admin-btn danger" onClick={() => setConfirmClear(true)}>
            Clear History
          </button>
        </div>
      </div>

      {error && (
        <div className="dash-error">
          <span>Unable to load dashboard data.</span>
          <button type="button" onClick={handleRefresh}>Retry</button>
        </div>
      )}

      <section className="dash-summary-strip" aria-label="Dashboard status summary">
        <SummaryItem label="Current Mode" value={settings.mode === 'event' ? 'Event' : 'Daily'} />
        {settings.mode === 'event' && (
          <SummaryItem label="Active Event" value={activeEvent?.name || 'No event selected'} />
        )}
        <SummaryItem label="QR Softcopy" value={softcopySettings.qrEnabled ? 'Enabled' : 'Disabled'} tone={softcopySettings.qrEnabled ? 'good' : ''} />
        <SummaryItem label="Outputs" value={enabledOutputs.length ? enabledOutputs.join(' / ') : 'None'} />
        <SummaryItem label="Print" value={settings.printEnabled !== false ? 'Enabled' : 'Disabled'} tone={settings.printEnabled !== false ? 'good' : ''} />
        <SummaryItem label="Test Mode" value={settings.testModeEnabled === true ? 'Active' : 'Off'} tone={settings.testModeEnabled === true ? 'warning' : ''} />
      </section>

      <section className="dash-section dash-section-reset">
        <div className="dash-section-head">
          <div>
            <div className="dash-section-title">Today Monitor Reset</div>
            <div className="dash-section-kicker">Clears today’s session records and counters only.</div>
          </div>
          <button
            className="admin-btn danger"
            onClick={() => setConfirmTodayReset(true)}
            disabled={todayResetting}
          >
            {todayResetting ? 'Resetting...' : 'Reset Today Monitor'}
          </button>
        </div>
      </section>

      {/* ── KPI cards ───────────────────────────── */}
      <div className="dash-kpi-grid">
        <KpiCard
          label="Today"
          sub="Total / sessions / copies"
          revenue={getBucketTotalRevenue(today)}
          stripRevenue={getBucketStripRevenue(today)}
          keychainRevenue={getBucketKeychainRevenue(today)}
          copies={today.copies}
          sessions={today.sessions}
          accent="primary"
        />
        <KpiCard
          label="Last 7 Days"
          sub="Rolling window"
          revenue={getBucketTotalRevenue(week)}
          stripRevenue={getBucketStripRevenue(week)}
          keychainRevenue={getBucketKeychainRevenue(week)}
          copies={week.copies}
          sessions={week.sessions}
        />
        <KpiCard
          label="Last 30 Days"
          sub="Rolling window"
          revenue={getBucketTotalRevenue(month)}
          stripRevenue={getBucketStripRevenue(month)}
          keychainRevenue={getBucketKeychainRevenue(month)}
          copies={month.copies}
          sessions={month.sessions}
        />
        <KpiCard
          label="All Time"
          sub={allTime.failed ? `${fmtInt(allTime.failed)} failed` : 'Lifetime total'}
          revenue={getBucketTotalRevenue(allTime)}
          stripRevenue={getBucketStripRevenue(allTime)}
          keychainRevenue={getBucketKeychainRevenue(allTime)}
          copies={allTime.copies}
          sessions={allTime.sessions}
        />
      </div>

      <section className="dash-section dash-section-revenue">
        <div className="dash-section-head">
          <div>
            <div className="dash-section-title">Revenue Breakdown</div>
            <div className="dash-section-kicker">All matching sessions in the current dashboard filter.</div>
          </div>
        </div>
        <div className="dash-metric-grid">
          <MetricTile label="Strip Revenue" value={peso(getBucketStripRevenue(allTime))} sub="Normal photobooth strips" />
          <MetricTile label="Keychain Revenue" value={peso(getBucketKeychainRevenue(allTime))} sub="Successful keychain prints only" tone="keychain" />
          <MetricTile label="Total Revenue" value={peso(getBucketTotalRevenue(allTime))} sub="Strip + keychain" tone="total" />
          <MetricTile label="Keychain Units" value={fmtInt(keychainStats.unitsSold)} sub="2-copy sale adds 2, 3-copy sale adds 3" tone="keychain" />
          <MetricTile label="Sheets Printed" value={fmtInt(keychainStats.sheetsPrinted)} sub="Successful 4x6 keychain sheets" />
          <MetricTile label="Transactions" value={fmtInt(keychainStats.transactions)} sub="Keychain sales recorded" />
        </div>
      </section>

      {/* ── 30-day revenue trend ───────────────── */}
      <section className="dash-section">
        <div className="dash-section-head">
          <div>
            <div className="dash-section-title">Revenue Trend</div>
            <div className="dash-section-kicker">Last 30 days</div>
          </div>
          <div className="dash-section-sub">
            {peakDay ? `Peak day: ${fmtLongDate(peakDay.date)} • ${peso(getBucketTotalRevenue(peakDay))}` : 'No peak yet'}
          </div>
        </div>

        <div className={`dash-chart ${!hasRevenue ? 'is-empty' : ''}`}>
          {stats.byDay.length === 0 || !hasRevenue
            ? <div className="dash-empty">No revenue yet.</div>
            : stats.byDay.map(day => {
                const dayRevenue = getBucketTotalRevenue(day);
                const heightPct = Math.max(4, (dayRevenue / maxDayRevenue) * 100);
                return (
                  <div
                    key={day.date}
                    className={`dash-bar-col ${peakDay?.date === day.date ? 'peak' : ''}`}
                    onMouseEnter={(event) => handleBarEnter(day, event)}
                    onMouseMove={(event) => handleBarMove(day, event)}
                    onMouseLeave={handleBarLeave}
                  >
                    <div className="dash-bar-wrap">
                      <div className="dash-bar" style={{ height: `${heightPct}%` }} />
                    </div>
                    <div className="dash-bar-label">{day.date.slice(5)}</div>
                  </div>
                );
              })}
          {barTooltip && (
            <div
              className="dash-bar-tooltip"
              style={{ left: `${barTooltip.x}px`, top: `${barTooltip.y}px` }}
            >
              <div className="dash-bar-tooltip-date">{fmtLongDate(barTooltip.day.date)}</div>
              <div className="dash-bar-tooltip-revenue">{peso(getBucketTotalRevenue(barTooltip.day))}</div>
              <div className="dash-bar-tooltip-meta">
                {fmtInt(barTooltip.day.sessions)} sessions • {fmtInt(barTooltip.day.copies)} copies
                {' • '}
                Strip {peso(getBucketStripRevenue(barTooltip.day))}
                {' • '}
                Keychain {peso(getBucketKeychainRevenue(barTooltip.day))}
              </div>
            </div>
          )}
        </div>
      </section>

      <section className="dash-section dash-section-keychains">
        <div className="dash-section-head">
          <div>
            <div className="dash-section-title">Keychains</div>
            <div className="dash-section-kicker">Separate keychain units, revenue, sheets, and transaction records.</div>
          </div>
          <div className="dash-section-sub">
            {fmtInt(keychainStats.unitsSold)} units • {peso(keychainStats.revenue)}
          </div>
        </div>
        <div className="dash-keychain-stat-row">
          <MetricTile label="Units Sold" value={fmtInt(keychainStats.unitsSold)} sub="Sold keychain strip copies" tone="keychain" />
          <MetricTile label="Revenue" value={peso(keychainStats.revenue)} sub="Stored sale amounts" tone="keychain" />
          <MetricTile label="Sheets Printed" value={fmtInt(keychainStats.sheetsPrinted)} sub="Successful printed sheets" />
          <MetricTile label="Transactions" value={fmtInt(keychainStats.transactions)} sub="Completed keychain sales" />
        </div>
        {Array.isArray(keychainStats.recentSales) && keychainStats.recentSales.length > 0 ? (
          <div className="dash-table-scroll">
            <table className="dash-table dash-keychain-table">
              <thead>
                <tr>
                  <th>Date &amp; time</th>
                  <th>Session / template</th>
                  <th>Layout</th>
                  <th className="num">Copies</th>
                  <th className="num">Amount</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {keychainStats.recentSales.map((sale) => (
                  <tr key={sale.id || `${sale.sessionId}-${sale.createdAt}-${sale.copies}`}>
                    <td>{fmtDateTime(sale.createdAt || sale.sessionTimestamp)}</td>
                    <td>
                      <div className="dash-keychain-session">
                        <strong>{sale.templateName || 'Unknown Template'}</strong>
                        <span>{sale.sessionId || 'No session ID'}</span>
                      </div>
                    </td>
                    <td>{sale.layoutName || '—'}</td>
                    <td className="num">{fmtInt(sale.copies)}</td>
                    <td className="num">{peso(sale.amount)}</td>
                    <td>
                      <span className="dash-pill good">Printed</span>
                      {(sale.keychainFilename || sale.keychainPath) && (
                        <div className="dash-keychain-file">
                          {sale.keychainFilename || sale.keychainPath}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="dash-empty">No keychain sales yet.</div>
        )}
      </section>

      <section className="dash-dual-grid">
        <section className="dash-section dash-section-template">
          <div className="dash-section-head">
            <div className="dash-section-title">By template</div>
            <div className="dash-section-sub">All-time performance</div>
          </div>

          {groupedTemplates.length === 0 ? (
            <div className="dash-empty">No template performance data yet.</div>
          ) : (
            <table className="dash-table">
              <thead>
                <tr>
                  <th className="rank">#</th>
                  <th>Template</th>
                  <th className="num"><SortButton active={templateSort === 'sessions'} onClick={() => setTemplateSort('sessions')}>Sessions</SortButton></th>
                  <th className="num"><SortButton active={templateSort === 'copies'} onClick={() => setTemplateSort('copies')}>Copies</SortButton></th>
                  <th className="num"><SortButton active={templateSort === 'revenue'} onClick={() => setTemplateSort('revenue')}>Revenue</SortButton></th>
                </tr>
              </thead>
              <tbody>
                {visibleTemplates.map((t, index) => (
                  <tr key={t.templateName}>
                    <td className="rank">{index + 1}</td>
                    <td>
                      <div className="dash-template-cell">
                        <div className="dash-template-thumb">
                          {t.thumbnail ? <img src={t.thumbnail} alt="" /> : <span>{t.templateName.charAt(0)}</span>}
                        </div>
                        <span>{t.templateName}</span>
                      </div>
                    </td>
                    <td className="num">{fmtInt(t.sessions)}</td>
                    <td className="num">{fmtInt(t.copies)}</td>
                    <td className="num">{peso(t.revenue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {groupedTemplates.length > 10 && (
            <div className="dash-table-actions">
              <button
                type="button"
                className="dash-compact-btn"
                onClick={() => setShowAllTemplates((current) => !current)}
              >
                {showAllTemplates ? 'Show less' : 'Show all templates'}
              </button>
            </div>
          )}
        </section>

        <section className="dash-section dash-section-recent">
          <div className="dash-section-head">
            <div className="dash-section-title">Recent sessions</div>
            <div className="dash-section-sub">
              {recentTotal > 0
                ? `Showing ${fmtInt(recentRange.start)}–${fmtInt(recentRange.end)} of ${fmtInt(recentTotal)} sessions`
                : 'No recent sessions yet.'}
            </div>
          </div>

          <div className="dash-session-filters">
            <label>
              <span>From</span>
              <input type="date" value={sessionFilters.from} onChange={(e) => updateSessionFilters({ from: e.target.value })} />
            </label>
            <label>
              <span>To</span>
              <input type="date" value={sessionFilters.to} onChange={(e) => updateSessionFilters({ to: e.target.value })} />
            </label>
            <label>
              <span>Template</span>
              <select value={sessionFilters.template} onChange={(e) => updateSessionFilters({ template: e.target.value })}>
                <option value="all">All templates</option>
                {recentTemplateOptions.map((name) => <option key={name} value={name}>{name}</option>)}
              </select>
            </label>
            <label>
              <span>Status</span>
              <select value={sessionFilters.status} onChange={(e) => updateSessionFilters({ status: e.target.value })}>
                <option value="all">All statuses</option>
                <option value="completed">Completed</option>
                <option value="failed">Failed</option>
                <option value="cancelled">Cancelled</option>
                <option value="partial">Partial</option>
              </select>
            </label>
            <label className="dash-search-filter">
              <span>Search</span>
              <input type="search" placeholder="Template, status, ID" value={sessionFilters.search} onChange={(e) => updateSessionFilters({ search: e.target.value })} />
            </label>
            <label>
              <span>Rows</span>
              <select
                value={recentSessionsPageSize}
                onChange={(e) => {
                  setRecentSessionsPageSize(Number(e.target.value) || 10);
                  setRecentSessionsPage(1);
                }}
              >
                <option value="10">10</option>
                <option value="20">20</option>
                <option value="50">50</option>
              </select>
            </label>
          </div>

          {recentTotal === 0 ? (
            <div className="dash-empty">No recent sessions yet.</div>
          ) : (
            <div className="dash-table-scroll">
              <table className="dash-table">
                <thead>
                  <tr>
                    <th>Date &amp; time</th>
                    <th>Template</th>
                    <th className="num">Copies</th>
                    <th className="num">Unit</th>
                    <th className="num">Total</th>
                    <th>Keychain</th>
                    <th className="num">Duration</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRecent.map((s) => {
                    const keychainSummary = getSessionKeychainSummary(s);
                    return (
                      <tr key={s.id} className={s.status === 'failed' ? 'row-failed' : ''}>
                        <td>{fmtDateTime(s.timestamp)}</td>
                        <td>{s.templateName || '—'}</td>
                        <td className="num">{fmtInt(s.copies)}</td>
                        <td className="num">{peso(s.unitPrice)}</td>
                        <td className="num">{peso(s.totalAmount)}</td>
                        <td>
                          {keychainSummary.transactions > 0 ? (
                            <div className="dash-session-keychain">
                              <span className="dash-pill keychain">KEYCHAIN</span>
                              <strong>{fmtInt(keychainSummary.unitsSold)} copies • {peso(keychainSummary.revenue)}</strong>
                              <small>{fmtInt(keychainSummary.sheetsPrinted)} sheet{keychainSummary.sheetsPrinted === 1 ? '' : 's'}</small>
                            </div>
                          ) : '—'}
                        </td>
                        <td className="num">{fmtDuration(s.durationMs)}</td>
                        <td>
                          <span className={`dash-pill ${getStatusPillClass(s.status)}`}>
                            {getSessionStatusLabel(s.status)}
                          </span>
                          {s.testMode && <span className="dash-pill test">TEST</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {recentTotal > 0 && (
            <div className="dash-pagination">
              <div className="dash-pagination-meta">
                <span>Page {resolvedRecentPage} of {Math.max(recentPageCount, 1)}</span>
                <strong>
                  Showing {fmtInt(recentRange.start)}–{fmtInt(recentRange.end)} of {fmtInt(recentTotal)} sessions
                </strong>
              </div>
              <div className="dash-pagination-controls">
                <button
                  type="button"
                  className="dash-compact-btn"
                  onClick={() => setRecentSessionsPage((page) => clampPage(page - 1, recentPageCount))}
                  disabled={resolvedRecentPage <= 1}
                >
                  Previous
                </button>
                <button
                  type="button"
                  className="dash-compact-btn"
                  onClick={() => setRecentSessionsPage((page) => clampPage(page + 1, recentPageCount))}
                  disabled={resolvedRecentPage >= recentPageCount}
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </section>
      </section>

      {statusMsg && <div className="admin-toast">{statusMsg}</div>}
      {todayResetMsg && <div className="admin-toast">{todayResetMsg}</div>}

      {confirmClear && (
        <div className="admin-modal-backdrop" onClick={() => setConfirmClear(false)}>
          <div className="admin-modal" onClick={e => e.stopPropagation()}>
            <div className="admin-modal-title">Clear all session history?</div>
            <div className="admin-modal-body">
              Every recorded print session will be permanently deleted. Revenue, copy counts and
              template performance will all reset to zero. This can't be undone.
            </div>
            <div className="admin-modal-actions">
              <button className="admin-btn ghost" onClick={() => setConfirmClear(false)}>Cancel</button>
              <button className="admin-btn danger" onClick={doClear}>Clear History</button>
            </div>
          </div>
        </div>
      )}

      {confirmTodayReset && (
        <div className="admin-modal-backdrop" onClick={() => setConfirmTodayReset(false)}>
          <div className="admin-modal" onClick={(e) => e.stopPropagation()}>
            <div className="admin-modal-title">Reset Today Monitor?</div>
            <div className="admin-modal-body">
              This will clear today&apos;s session records and Today Monitor counters. This will not
              delete templates, settings, QR files, or saved media.
            </div>
            <div className="admin-modal-actions">
              <button className="admin-btn ghost" onClick={() => setConfirmTodayReset(false)}>Cancel</button>
              <button className="admin-btn danger" onClick={doResetTodayMonitor} disabled={todayResetting}>
                {todayResetting ? 'Resetting...' : 'Reset Today Monitor'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function KpiCard({ label, sub, revenue, stripRevenue = 0, keychainRevenue = 0, copies, sessions, accent }) {
  return (
    <div className={`dash-kpi ${accent === 'primary' ? 'primary' : ''}`}>
      <div className="dash-kpi-label">{label}</div>
      <div className="dash-kpi-metric-label">Total Revenue</div>
      <div className="dash-kpi-revenue">{peso(revenue)}</div>
      <div className="dash-kpi-breakdown">
        <span>Strip {peso(stripRevenue)}</span>
        <span>Keychain {peso(keychainRevenue)}</span>
      </div>
      <div className="dash-kpi-split">
        <div>
          <div className="dash-kpi-num">{fmtInt(sessions)}</div>
          <div className="dash-kpi-cap">Sessions</div>
        </div>
        <div>
          <div className="dash-kpi-num">{fmtInt(copies)}</div>
          <div className="dash-kpi-cap">Copies</div>
        </div>
      </div>
      <div className="dash-kpi-sub">{sub}</div>
    </div>
  );
}

function MetricTile({ label, value, sub, tone = '' }) {
  return (
    <article className={`dash-metric-tile ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      {sub && <small>{sub}</small>}
    </article>
  );
}

function SummaryItem({ label, value, tone = '' }) {
  return (
    <div className={`dash-summary-item ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function SortButton({ active, onClick, children }) {
  return (
    <button type="button" className={`dash-sort-btn ${active ? 'active' : ''}`} onClick={onClick}>
      {children}
    </button>
  );
}
