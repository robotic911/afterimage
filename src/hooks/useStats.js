import { useCallback, useEffect, useState } from 'react';

// Pulls aggregated analytics + the most-recent session list for the
// admin dashboard. Exposes refresh() so the dashboard can re-pull after
// destructive actions (clear history) or on a manual refresh click.
//
// In browser dev mode (no Electron), adminApi is undefined — we return
// a deterministic mock dataset so the dashboard renders populated state
// for CSS iteration. The real store only lives in Electron's userData.

const EMPTY_BUCKET = {
  sessions: 0,
  copies: 0,
  revenue: 0,
  stripRevenue: 0,
  keychainRevenue: 0,
  totalRevenue: 0,
  keychainUnits: 0,
  keychainSheets: 0,
  keychainTransactions: 0,
  failed: 0,
};
const EMPTY_KEYCHAIN_STATS = {
  unitsSold: 0,
  revenue: 0,
  sheetsPrinted: 0,
  transactions: 0,
  recentSales: [],
};
const EMPTY_STATS = {
  totals: {
    today:   { ...EMPTY_BUCKET },
    week:    { ...EMPTY_BUCKET },
    month:   { ...EMPTY_BUCKET },
    allTime: { ...EMPTY_BUCKET },
  },
  byDay: [],
  byTemplate: [],
  keychains: { ...EMPTY_KEYCHAIN_STATS },
  generatedAt: null,
};
const FALLBACK_RECENT_TOTAL = 119;

// Deterministic pseudo-random helper — same shape each page load so CSS
// work isn't hampered by numbers jumping around between refreshes.
// Uses sine of the seed to produce a stable 0..1 value.
const rand = (seed) => {
  const v = Math.sin(seed * 12.9898) * 43758.5453;
  return v - Math.floor(v);
};

const PRICE = 99;
const pad = (n) => String(n).padStart(2, '0');
const toLocalYmd = (d) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

const MOCK_TEMPLATES = [
  { templateId: 'default-dark-teal',   templateName: 'Dark Teal'   },
  { templateId: 'default-classic-black', templateName: 'Classic Black' },
  { templateId: 'default-warm-blush',  templateName: 'Warm Blush'  },
  { templateId: 'default-dark-maroon', templateName: 'Dark Maroon' },
  { templateId: 'default-soft-white',  templateName: 'Soft White'  },
  { templateId: 'default-original',    templateName: 'Original'    },
];

function filterBySessionType(record, sessionType = 'real') {
  if (sessionType === 'test') return record.testMode === true;
  if (sessionType === 'real') return record.testMode !== true;
  return true;
}

function buildFallbackStats(sessionType = 'real') {
  const now = new Date();
  const today = toLocalYmd(now);

  const byDay = [];
  const byTemplateMap = Object.fromEntries(
    MOCK_TEMPLATES.map(t => [t.templateId, {
      ...t, sessions: 0, copies: 0, revenue: 0,
    }])
  );

  const buckets = {
    today:   { ...EMPTY_BUCKET },
    week:    { ...EMPTY_BUCKET },
    month:   { ...EMPTY_BUCKET },
    allTime: { ...EMPTY_BUCKET },
  };

  // Walk 30 days oldest → newest. Recent days get weighted higher so the
  // bar chart looks realistically "growing" into today.
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now); d.setDate(d.getDate() - i);
    const date = toLocalYmd(d);

    const recencyBoost = i < 7 ? 1.3 : i < 14 ? 1.0 : 0.65;
    const base = Math.floor(rand(i + 1) * 8 * recencyBoost);
    const sessions = base + (i < 7 ? 3 : 1);
    const copies   = sessions + Math.floor(rand(i + 7) * (sessions + 2));
    const revenue  = copies * PRICE;
    const testMode = i % 6 === 0;
    if (!filterBySessionType({ testMode }, sessionType)) continue;

    byDay.push({
      date,
      sessions,
      copies,
      revenue,
      stripRevenue: revenue,
      keychainRevenue: 0,
      totalRevenue: revenue,
      keychainUnits: 0,
      keychainSheets: 0,
      keychainTransactions: 0,
    });

    buckets.allTime.sessions += sessions;
    buckets.allTime.copies   += copies;
    buckets.allTime.revenue  += revenue;
    buckets.allTime.stripRevenue += revenue;
    buckets.allTime.totalRevenue += revenue;
    buckets.month.sessions   += sessions;
    buckets.month.copies     += copies;
    buckets.month.revenue    += revenue;
    buckets.month.stripRevenue += revenue;
    buckets.month.totalRevenue += revenue;
    if (i < 7) {
      buckets.week.sessions += sessions;
      buckets.week.copies   += copies;
      buckets.week.revenue  += revenue;
      buckets.week.stripRevenue += revenue;
      buckets.week.totalRevenue += revenue;
    }
    if (date === today) {
      buckets.today.sessions = sessions;
      buckets.today.copies   = copies;
      buckets.today.revenue  = revenue;
      buckets.today.stripRevenue = revenue;
      buckets.today.totalRevenue = revenue;
    }

    // Distribute this day's sessions across templates so by-template totals
    // line up with allTime. Dark Teal leans most popular.
    const weights = [0.24, 0.15, 0.2, 0.16, 0.13, 0.12];
    let dealtS = 0, dealtC = 0;
    MOCK_TEMPLATES.forEach((t, idx) => {
      const isLast = idx === MOCK_TEMPLATES.length - 1;
      const s = isLast ? sessions - dealtS : Math.round(sessions * weights[idx]);
      const c = isLast ? copies   - dealtC : Math.round(copies   * weights[idx]);
      dealtS += s; dealtC += c;
      const bucket = byTemplateMap[t.templateId];
      bucket.sessions += s;
      bucket.copies   += c;
      bucket.revenue  += c * PRICE;
    });
  }
  buckets.allTime.failed = 2; // a couple of simulated failed prints for the badge

  return {
    totals: buckets,
    byDay,
    byTemplate: Object.values(byTemplateMap).sort((a, b) => b.revenue - a.revenue),
    keychains: { ...EMPTY_KEYCHAIN_STATS },
    generatedAt: now.toISOString(),
  };
}

function normalizeText(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function buildFallbackRecent({ limit, offset, eventFilter, sessionType = 'real', recentFilters = {} }) {
  const now = Date.now();
  const all = [];
  for (let i = 0; i < FALLBACK_RECENT_TOTAL; i++) {
    const t = MOCK_TEMPLATES[i % MOCK_TEMPLATES.length];
    // Step backwards in irregular ~20–90min increments
    const rowOffset = i * (20 + Math.floor(rand(i + 3) * 70)) * 60 * 1000;
    const ts = new Date(now - rowOffset);
    const copies = 1 + Math.floor(rand(i + 11) * 3); // 1..3
    const failed = rand(i + 19) > 0.93; // ~7% of sessions fail
    const isEventSession = i % 5 === 0;
    const record = {
      id: `mock_${ts.getTime()}_${i}`,
      timestamp:     ts.toISOString(),
      dateLocal:     toLocalYmd(ts),
      templateId:    t.templateId,
      templateName:  t.templateName,
      mode:          isEventSession ? 'event' : 'daily',
      eventId:       isEventSession ? 'mock-event' : null,
      eventName:     isEventSession ? 'Mock Event' : null,
      copies,
      unitPrice:     PRICE,
      totalAmount:   PRICE * copies,
      retriesUsed:   rand(i + 31) > 0.75 ? 1 : 0,
      durationMs:    35_000 + Math.floor(rand(i + 41) * 60_000),
      status:        failed ? 'failed' : 'completed',
      failureReason: failed ? 'printer offline (mock)' : null,
      testMode:      i % 6 === 0,
    };
    if (eventFilter === 'daily' && record.mode !== 'daily') continue;
    if (eventFilter !== 'all' && eventFilter !== 'daily' && record.eventId !== eventFilter) continue;
    if (!filterBySessionType(record, sessionType)) continue;
    if (recentFilters.templateName && normalizeText(record.templateName) !== normalizeText(recentFilters.templateName)) continue;
    if (recentFilters.status && normalizeText(record.status) !== normalizeText(recentFilters.status)) continue;
    if (recentFilters.from && record.dateLocal < recentFilters.from) continue;
    if (recentFilters.to && record.dateLocal > recentFilters.to) continue;
    if (recentFilters.search) {
      const searchable = [
        record.id,
        record.timestamp,
        record.dateLocal,
        record.templateId,
        record.templateName,
        record.status,
        record.failureReason,
        record.eventId,
        record.eventName,
      ].map(normalizeText).join(' ');
      if (!searchable.includes(normalizeText(recentFilters.search))) continue;
    }
    all.push(record);
  }
  all.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
  const safeLimit = Math.max(1, Number(limit) || 10);
  const safeOffset = Math.max(0, Number(offset) || 0);
  return {
    total: all.length,
    sessions: all.slice(safeOffset, safeOffset + safeLimit),
  };
}

export function useStats({
  recentLimit = 10,
  recentOffset = 0,
  eventFilter = 'all',
  sessionType = 'real',
  recentFilters = {},
} = {}) {
  const [stats, setStats] = useState(EMPTY_STATS);
  const [recent, setRecent] = useState([]);
  const [recentTotal, setRecentTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    if (!window.adminApi?.getStats) {
      setStats(buildFallbackStats(sessionType));
      const fallbackRecent = buildFallbackRecent({
        limit: recentLimit,
        offset: recentOffset,
        eventFilter,
        sessionType,
        recentFilters,
      });
      setRecent(fallbackRecent.sessions);
      setRecentTotal(fallbackRecent.total);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    try {
      const [statsRes, listRes] = await Promise.all([
        window.adminApi.getStats(
          eventFilter === 'daily'
            ? { mode: 'daily', sessionType }
            : eventFilter === 'all'
              ? { sessionType }
              : { eventId: eventFilter, sessionType }
        ),
        window.adminApi.listSessions({
          limit: recentLimit,
          offset: recentOffset,
          ...(eventFilter === 'daily'
            ? { mode: 'daily', sessionType }
            : eventFilter === 'all'
              ? { sessionType }
              : { eventId: eventFilter, sessionType }),
          ...(recentFilters.templateName ? { templateName: recentFilters.templateName } : {}),
          ...(recentFilters.status ? { status: recentFilters.status } : {}),
          ...(recentFilters.from ? { from: recentFilters.from } : {}),
          ...(recentFilters.to ? { to: recentFilters.to } : {}),
          ...(recentFilters.search ? { search: recentFilters.search } : {}),
        }),
      ]);
      if (statsRes?.ok) {
        setStats({
          totals: statsRes.totals || EMPTY_STATS.totals,
          byDay: statsRes.byDay || [],
          byTemplate: statsRes.byTemplate || [],
          keychains: statsRes.keychains || EMPTY_STATS.keychains,
          generatedAt: statsRes.generatedAt || null,
        });
        setError(null);
      } else {
        setStats(EMPTY_STATS);
        setError(statsRes?.error || 'unknown error');
      }
      setRecent(listRes?.ok ? (listRes.sessions || []) : []);
      setRecentTotal(listRes?.ok ? Number(listRes.total) || 0 : 0);
    } catch (err) {
      setStats(EMPTY_STATS);
      setRecent([]);
      setRecentTotal(0);
      setError(err?.message || String(err));
    } finally {
      setLoading(false);
    }
  }, [recentLimit, recentOffset, eventFilter, sessionType, recentFilters]);

  useEffect(() => {
    const id = setTimeout(() => {
      refresh();
    }, 0);
    return () => clearTimeout(id);
  }, [refresh]);

  return { stats, recent, recentTotal, loading, error, refresh };
}
