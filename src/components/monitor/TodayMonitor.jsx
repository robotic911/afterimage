import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './TodayMonitor.css';
import { resolveSoftcopySettings } from '../../constants/softcopySettings';
import {
  DEFAULT_COUNTDOWN_SECONDS,
  MAX_COUNTDOWN_SECONDS,
  MIN_COUNTDOWN_SECONDS,
  normalizeCountdownSeconds,
} from '../../constants/countdownSettings';
import {
  generateKeychain4x6Png,
  generateKeychain4x6TestPng,
  KEYCHAIN_4X6_LAYOUT_IDS,
} from '../../lib/keychainGenerator';
import {
  DEFAULT_KEYCHAIN_COPIES,
  getKeychainPrice as getConfiguredKeychainPrice,
  isValidKeychainCopies,
} from '../../constants/keychainPricing';
import {
  getCount,
  getKeychainRevenueTotal,
  getKeychainSalesForSessions,
  getSessionKeychainPrintCount,
  getSessionKeychainRevenue,
  getSessionKeychainTransactions,
  getSessionKeychainUnitsSold,
  getSessionRevenue,
  getSessionTotalCopies,
  getStripSessionRevenue,
  getStripSessionRevenueTotal,
  getTotalRevenue,
  isRevenueEligibleSession,
} from '../../lib/salesMetrics';

const IS_DEV = import.meta.env.DEV;
const SHOW_DIAGNOSTIC_UI = false;
const RUNTIME_PLATFORM = window.printApi?.platform || 'unknown';
const SYSTEM_PRINT_QUEUE_LABEL = RUNTIME_PLATFORM === 'darwin'
  ? 'macOS Print Center'
  : RUNTIME_PLATFORM === 'win32'
    ? 'the Windows print queue'
    : 'the system print queue';

function pad(value) {
  return String(value).padStart(2, '0');
}

function toLocalYmd(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function fmtMoney(value) {
  return '₱' + (Number(value) || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtInt(value) {
  return (Number(value) || 0).toLocaleString('en-PH');
}

const KEYCHAIN_COPY_OPTIONS = [
  { copies: 2, label: '2 strip copies', price: getConfiguredKeychainPrice(2) },
  { copies: 3, label: '3 strip copies', price: getConfiguredKeychainPrice(3) },
];

function normalizeKeychainCopies(value) {
  const count = Number(value);
  return isValidKeychainCopies(count)
    ? count
    : DEFAULT_KEYCHAIN_COPIES;
}

function getKeychainPrice(copies) {
  return getConfiguredKeychainPrice(normalizeKeychainCopies(copies));
}

function fmtDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-PH', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(date);
}

function fmtTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-PH', {
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

function fmtShortTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-PH', {
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

function getPrintJobStatusLabel(job) {
  if (!job) return 'Unknown';
  const finalCopies = job.finalCopies || job.copies || 1;
  const completedCopies = job.completedCopies || 0;
  if (job.status === 'printing') {
    return job.cancelRequested ? 'Cancel requested' : `Printing copy ${job.currentCopy || 1} of ${finalCopies}`;
  }
  if (job.status === 'queued') return 'Queued';
  if (job.status === 'completed') return 'Completed';
  if (job.status === 'failed') return 'Failed';
  if (job.status === 'cancelled') return job.error || 'Cancelled';
  if (job.status === 'partial') return `Partial: ${completedCopies} of ${finalCopies} printed`;
  return job.status || 'Unknown';
}

function getSessionStatusLabel(status) {
  if (status === 'failed') return 'Failed';
  if (status === 'cancelled') return 'Cancelled';
  if (status === 'partial') return 'Partial';
  return 'Completed';
}

function getStatusBadgeClass(status) {
  if (status === 'failed') return 'bad';
  if (status === 'completed') return 'good';
  return '';
}

function sortPrintJobs(jobs = []) {
  const rank = { printing: 0, queued: 1, failed: 2, partial: 3, cancelled: 4, completed: 5 };
  return [...jobs].sort((a, b) => {
    const statusDelta = (rank[a.status] ?? 9) - (rank[b.status] ?? 9);
    if (statusDelta) return statusDelta;
    return (b.createdAt || '').localeCompare(a.createdAt || '');
  });
}

function shallowRecordEqual(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => Object.is(a[key], b[key]));
}

function reconcileRecordsById(current = [], next = []) {
  const currentById = new Map(current.map((record) => [record?.id, record]));
  let changed = current.length !== next.length;
  const reconciled = next.map((record, index) => {
    const currentRecord = currentById.get(record?.id);
    const resolved = currentRecord && shallowRecordEqual(currentRecord, record)
      ? currentRecord
      : record;
    if (resolved !== current[index]) changed = true;
    return resolved;
  });
  return changed ? reconciled : current;
}

function buildOutputs(session) {
  const outputs = [];
  if (session?.softcopyPhotoPath) outputs.push('Photo');
  if (session?.softcopyGifPath) outputs.push('GIF');
  if (session?.softcopyVideoPath) outputs.push('Video');
  return outputs;
}

function hasQrData(session) {
  return Boolean(
    session?.softcopySessionToken
      || session?.softcopyPhotoPath
      || session?.softcopyGifPath
      || session?.softcopyVideoPath
      || session?.softcopyStatus === 'ready',
  );
}

function hasPrintableSessionOutput(session) {
  return Boolean(
    session?.finalPrintPath
      || session?.printImagePath
      || session?.localPhotoPath
      || session?.photoPath
      || session?.softcopyPhotoPath,
  );
}

function hasKeychainSessionSource(session) {
  return hasPrintableSessionOutput(session);
}

function getSessionExtraPrintCount(session) {
  return getCount(session?.extraPrintCount, 0);
}

function getSessionUnitPrice(session) {
  const explicit = Number(session?.unitPrice);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const revenue = getSessionRevenue(session);
  const copies = getSessionTotalCopies(session);
  return revenue > 0 && copies > 0 ? +(revenue / copies).toFixed(2) : 0;
}

function getPrintExtraSessionCopyApi() {
  return window.todayMonitorApi?.printExtraSessionCopy
    || window.adminApi?.printExtraSessionCopy
    || window.printApi?.printExtraSessionCopy
    || null;
}

function getGenerateAndPrintKeychainApi() {
  return window.todayMonitorApi?.generateAndPrintKeychain || null;
}

function logTodayMonitorActionApiCheck(context = '') {
  console.log('[today monitor action] api check', {
    context,
    hasTodayMonitorApi: Boolean(window.todayMonitorApi),
    keys: window.todayMonitorApi ? Object.keys(window.todayMonitorApi) : [],
    hasPrintExtra: Boolean(window.todayMonitorApi?.printExtraSessionCopy),
    hasKeychain: Boolean(window.todayMonitorApi?.generateAndPrintKeychain),
  });
}

function getExtraPrintUnavailableReason({
  session,
  printEnabled,
  selectedPrinterName,
  selectedPrinter,
  visiblePrinters,
}) {
  if (!getPrintExtraSessionCopyApi()) {
    return 'Print API unavailable';
  }
  if (!session || session.status !== 'completed') {
    return 'Completed sessions only';
  }
  if (!hasPrintableSessionOutput(session)) {
    return 'No saved print image';
  }
  if (!printEnabled) {
    return 'Printing is disabled';
  }
  if (selectedPrinterName && !selectedPrinter) {
    return 'Selected printer is missing';
  }
  if (selectedPrinter && selectedPrinter.isAvailable === false) {
    return 'Selected printer is offline';
  }
  if (!selectedPrinter && !visiblePrinters.some((printer) => printer.isAvailable)) {
    return 'No Canon SELPHY printer is available';
  }
  return null;
}

function getKeychainUnavailableReason({
  session,
  printEnabled,
  selectedPrinterName,
  selectedPrinter,
  visiblePrinters,
}) {
  if (!getGenerateAndPrintKeychainApi()) {
    return 'Keychain API unavailable';
  }
  if (!session || session.status !== 'completed') {
    return 'Completed sessions only';
  }
  const hasExistingKeychain = Boolean(session.keychainPath || session.keychainGeneratedAt);
  if (!hasExistingKeychain) {
    if (!KEYCHAIN_4X6_LAYOUT_IDS.has(session.layoutId || '')) {
      return 'Keychain unavailable for this layout.';
    }
    if (!hasKeychainSessionSource(session)) {
      return 'Keychain unavailable for this session.';
    }
  }
  if (!printEnabled) {
    return 'Printing is disabled';
  }
  if (selectedPrinterName && !selectedPrinter) {
    return 'Selected printer is missing';
  }
  if (selectedPrinter && selectedPrinter.isAvailable === false) {
    return 'Selected printer is offline';
  }
  if (!selectedPrinter && !visiblePrinters.some((printer) => printer.isAvailable)) {
    return 'No Canon SELPHY printer is available';
  }
  return null;
}

export default function TodayMonitor() {
  const [settings, setSettings] = useState(null);
  const [events, setEvents] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [printJobs, setPrintJobs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [queueError, setQueueError] = useState(null);
  const [printerList, setPrinterList] = useState({
    printers: [],
    selphyPrinters: [],
    selectedPrinterName: null,
    guidance: null,
  });
  const [printerError, setPrinterError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [countdownDraft, setCountdownDraft] = useState(String(DEFAULT_COUNTDOWN_SECONDS));
  const [printCopiesUpdating, setPrintCopiesUpdating] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [showResetModal, setShowResetModal] = useState(false);
  const [showExitModal, setShowExitModal] = useState(false);
  const [extraPrintModalSession, setExtraPrintModalSession] = useState(null);
  const [extraPrintLoadingSessionId, setExtraPrintLoadingSessionId] = useState(null);
  const [extraPrintFeedback, setExtraPrintFeedback] = useState(null);
  const [keychainModalSession, setKeychainModalSession] = useState(null);
  const [keychainCopiesDraft, setKeychainCopiesDraft] = useState(DEFAULT_KEYCHAIN_COPIES);
  const [keychainLoading, setKeychainLoading] = useState(null);
  const [keychainFeedback, setKeychainFeedback] = useState(null);
  const [downloadsDiagResult, setDownloadsDiagResult] = useState(null);
  const [downloadsDiagRunning, setDownloadsDiagRunning] = useState(false);
  const [downloadsPngDiagResult, setDownloadsPngDiagResult] = useState(null);
  const [downloadsPngDiagRunning, setDownloadsPngDiagRunning] = useState(false);
  const [keychainDiagResult, setKeychainDiagResult] = useState(null);
  const [keychainDiagRunning, setKeychainDiagRunning] = useState(false);
  const [cursorHidden, setCursorHidden] = useState(() => {
    try {
      const stored = localStorage.getItem('kuku.cursorHidden');
      return stored == null ? true : stored === 'true';
    } catch {
      return true;
    }
  });
  const requestSeqRef = useRef(0);
  const activeRequestRef = useRef(false);
  const loadingRef = useRef(true);
  const sessionActionAuditRef = useRef(new Map());

  const activeEvent = settings?.activeEventId
    ? (events.find((event) => event.id === settings.activeEventId) || null)
    : null;

  const softcopySettings = useMemo(
    () => resolveSoftcopySettings(settings?.softcopySettings),
    [settings?.softcopySettings],
  );
  const testModeEnabled = settings?.testModeEnabled === true;
  const printEnabled = settings?.printEnabled !== false;
  const printCopiesEnabled = settings?.printCopiesEnabled === true;
  const qrEnabled = softcopySettings.qrEnabled !== false;
  const photoEnabled = softcopySettings.photoEnabled !== false;
  const gifEnabled = softcopySettings.gifEnabled !== false;
  const videoEnabled = softcopySettings.videoEnabled !== false;
  const countdownSeconds = normalizeCountdownSeconds(settings?.countdownSeconds ?? DEFAULT_COUNTDOWN_SECONDS);

  const summary = useMemo(() => {
    const revenueEligibleSessions = sessions.filter(isRevenueEligibleSession);
    const failed = sessions.filter((session) => session.status === 'failed');
    const stripSessionRevenueToday = getStripSessionRevenueTotal(sessions);
    const copiesToday = revenueEligibleSessions.reduce((sum, session) => sum + getSessionTotalCopies(session), 0);
    const keychainSales = getKeychainSalesForSessions(sessions);
    const keychainUnitsToday = keychainSales.reduce((sum, sale) => sum + sale.copies, 0);
    const keychainRevenueToday = getKeychainRevenueTotal(sessions);
    const totalRevenueToday = getTotalRevenue(sessions);
    const keychainTransactionsToday = keychainSales.length;
    const recentKeychainSales = [...keychainSales]
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
      .slice(0, 5);
    const qrSessionsToday = sessions.filter((session) => hasQrData(session)).length;
    const testSessionsToday = sessions.filter((session) => session.testMode === true).length;
    const latestSession = sessions[0] || null;
    return {
      sessionsToday: sessions.length,
      totalRevenueToday,
      stripSessionRevenueToday,
      copiesToday,
      keychainUnitsToday,
      keychainRevenueToday,
      keychainTransactionsToday,
      recentKeychainSales,
      qrSessionsToday,
      testSessionsToday,
      failedSessionsToday: failed.length,
      latestSessionTime: latestSession?.timestamp || null,
    };
  }, [sessions]);

  useEffect(() => {
    console.log('[KEYCHAIN TRACKER] totals', {
      unitsSold: summary.keychainUnitsToday,
      revenue: summary.keychainRevenueToday,
      sheetsPrinted: summary.keychainTransactionsToday,
      saleCount: summary.keychainTransactionsToday,
    });
  }, [
    summary.keychainUnitsToday,
    summary.keychainRevenueToday,
    summary.keychainTransactionsToday,
  ]);

  useEffect(() => {
    // Keep the editable countdown field aligned with the authoritative
    // saved setting after every refresh or cross-window update.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCountdownDraft(String(normalizeCountdownSeconds(settings?.countdownSeconds ?? DEFAULT_COUNTDOWN_SECONDS)));
  }, [settings?.countdownSeconds]);

  useEffect(() => {
    try {
      localStorage.setItem('kuku.cursorHidden', cursorHidden ? 'true' : 'false');
    } catch {
      // Ignore storage failures; the live toggle still works for this session.
    }
  }, [cursorHidden]);

  useEffect(() => {
    const onStorage = (event) => {
      if (event.key !== 'kuku.cursorHidden') return;
      setCursorHidden(event.newValue == null ? true : event.newValue === 'true');
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  useEffect(() => {
    loadingRef.current = loading;
  }, [loading]);

  useEffect(() => {
    if (!window.adminApi?.onMonitorExitRequest) return undefined;
    const unsub = window.adminApi.onMonitorExitRequest(() => {
      console.log('[monitor] exit requested');
      setShowExitModal(true);
    });
    return () => unsub?.();
  }, []);

  const commitSettingsPatch = useCallback(async (patch, logPayload = null) => {
    if (!window.adminApi?.updateSettings) {
      setError('Today Monitor requires the Electron runtime.');
      return false;
    }

    try {
      const res = await window.adminApi.updateSettings(patch);
      if (!res?.ok) {
        throw new Error(res?.error || 'failed to update settings');
      }

      if (res.settings) {
        setSettings(res.settings);
        if (Object.prototype.hasOwnProperty.call(res.settings, 'countdownSeconds')) {
          setCountdownDraft(String(normalizeCountdownSeconds(res.settings.countdownSeconds)));
        }
      } else {
        setSettings((current) => (current ? { ...current, ...patch } : current));
      }

      setError(null);
      if (logPayload) {
        console.log('[monitor] setting updated', logPayload);
      }
      for (const group of Object.keys(patch || {})) {
        console.log('[settings] saved', { group, settings: res.settings?.[group] ?? patch[group] });
      }
      return true;
    } catch (err) {
      setError(err?.message || String(err));
      return false;
    }
  }, []);

  const refresh = useCallback(async (source = 'manual') => {
    if (activeRequestRef.current) return;
    if (!window.adminApi?.getSettings || !window.adminApi?.listEvents || !window.adminApi?.listSessions) {
      setLoading(false);
      setRefreshing(false);
      setError('Today Monitor requires the Electron runtime.');
      return;
    }

    activeRequestRef.current = true;
    const requestId = ++requestSeqRef.current;
    const todayYmd = toLocalYmd(new Date());
    const shouldRefreshPrinters = ['initial', 'manual', 'shortcut'].includes(source);
    if (source === 'manual' || source === 'shortcut') {
      console.log('[monitor] refresh triggered');
    }

    if (!loadingRef.current) setRefreshing(true);
    try {
      const [settingsRes, eventsRes, sessionsRes, queueRes, printersRes] = await Promise.all([
        window.adminApi.getSettings(),
        window.adminApi.listEvents(),
        window.adminApi.listSessions({
          limit: 500,
          offset: 0,
          from: todayYmd,
          to: todayYmd,
        }),
        window.printApi?.getQueue ? window.printApi.getQueue() : Promise.resolve({ ok: true, jobs: [] }),
        shouldRefreshPrinters && window.printApi?.listPrinters
          ? window.printApi.listPrinters()
          : Promise.resolve({ ok: true, skipped: true }),
      ]);

      if (requestId !== requestSeqRef.current) return;

      if (!settingsRes?.ok) throw new Error(settingsRes?.error || 'failed to load settings');
      if (!eventsRes?.ok) throw new Error(eventsRes?.error || 'failed to load events');
      if (!sessionsRes?.ok) throw new Error(sessionsRes?.error || 'failed to load sessions');
      if (!queueRes?.ok) throw new Error(queueRes?.error || 'failed to load print queue');

      const nextSessions = Array.isArray(sessionsRes.sessions)
        ? [...sessionsRes.sessions].sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''))
        : [];
      const nextTodaySessions = nextSessions.filter((session) => session.dateLocal === todayYmd);

      setSettings(settingsRes.settings || null);
      setEvents(eventsRes.events || []);
      setSessions((current) => reconcileRecordsById(current, nextTodaySessions));
      setPrintJobs((current) => reconcileRecordsById(current, Array.isArray(queueRes.jobs) ? queueRes.jobs : []));
      if (printersRes?.ok && !printersRes.skipped) {
        setPrinterList({
          printers: Array.isArray(printersRes.printers) ? printersRes.printers : [],
          selphyPrinters: Array.isArray(printersRes.selphyPrinters) ? printersRes.selphyPrinters : [],
          selectedPrinterName: printersRes.selectedPrinterName || settingsRes.settings?.selectedPrinterName || null,
          guidance: printersRes.guidance || null,
        });
        setPrinterError(null);
      } else if (!printersRes?.skipped) {
        setPrinterError(printersRes?.error || 'failed to load printers');
      }
      setCountdownDraft(String(normalizeCountdownSeconds(settingsRes.settings?.countdownSeconds ?? DEFAULT_COUNTDOWN_SECONDS)));
      setError(null);
      setQueueError(null);
      setLastUpdated(new Date().toISOString());
      if (IS_DEV) {
        console.log('[monitor] loaded settings', settingsRes.settings);
        console.log('[monitor] loaded today sessions', { count: nextTodaySessions.length });
        console.log('[monitor] refreshed', {
          sessionsToday: nextTodaySessions.length,
          stripSessionRevenueToday: getStripSessionRevenueTotal(nextTodaySessions),
          keychainRevenueToday: getKeychainRevenueTotal(nextTodaySessions),
          totalRevenueToday: getTotalRevenue(nextTodaySessions),
          copiesToday: nextTodaySessions
            .filter(isRevenueEligibleSession)
            .reduce((sum, session) => sum + getSessionTotalCopies(session), 0),
        });
      }
    } catch (err) {
      if (requestId !== requestSeqRef.current) return;
      setError(err?.message || String(err));
      setSessions([]);
    } finally {
      if (requestId === requestSeqRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
      activeRequestRef.current = false;
    }
  }, []);

  const applySessionRecordUpdate = useCallback((record) => {
    if (!record || typeof record !== 'object' || !record.id) {
      refresh('event');
      return;
    }

    const todayYmd = toLocalYmd(new Date());
    setSessions((current) => {
      const withoutRecord = current.filter((session) => session.id !== record.id);
      const nextSessions = record.dateLocal === todayYmd
        ? [record, ...withoutRecord].sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''))
        : withoutRecord;
      return reconcileRecordsById(current, nextSessions);
    });
    setLastUpdated(new Date().toISOString());
  }, [refresh]);

  useEffect(() => {
    document.body.classList.add('window-monitor');
    document.title = 'Afterimage Today Monitor';
    return () => {
      document.body.classList.remove('window-monitor');
    };
  }, []);

  useEffect(() => {
    // Initial hydration is intentional: the monitor owns its own local
    // snapshot and immediately syncs from the shared session store.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh('initial');
  }, [refresh]);

  useEffect(() => {
    if (!window.printApi?.onQueueChanged) return undefined;
    return window.printApi.onQueueChanged((jobs) => {
      setPrintJobs((current) => reconcileRecordsById(current, Array.isArray(jobs) ? jobs : []));
      setQueueError(null);
    });
  }, []);

  useEffect(() => {
    if (
      !window.adminApi?.onSessionLogged
      && !window.adminApi?.onSessionsUpdated
      && !window.adminApi?.onSessionsCleared
      && !window.adminApi?.onTodayMonitorRecordsReset
      && !window.todayMonitorApi?.onRecordsReset
      && !window.todayMonitorApi?.onSessionsUpdated
      && !window.adminApi?.onSettingsChanged
      && !window.adminApi?.onEventsChanged
    ) return undefined;
    const onSessionChange = (record) => applySessionRecordUpdate(record);
    const refreshFromEvent = () => refresh('event');
    const onSettingsChange = (nextSettings) => {
      if (nextSettings && typeof nextSettings === 'object' && !Array.isArray(nextSettings)) {
        console.log('[settings] changed broadcast received', { group: 'appSettings', settings: nextSettings });
        setSettings(nextSettings);
        setCountdownDraft(String(normalizeCountdownSeconds(nextSettings.countdownSeconds ?? DEFAULT_COUNTDOWN_SECONDS)));
        setError(null);
      }
      refresh('event');
    };
    const unsubLogged = window.adminApi.onSessionLogged?.(onSessionChange);
    const unsubUpdated = window.adminApi.onSessionsUpdated?.(onSessionChange);
    const unsubCleared = window.adminApi.onSessionsCleared?.(() => {
      setSessions([]);
      refreshFromEvent();
    });
    const unsubTodayReset = window.adminApi.onTodayMonitorRecordsReset?.(refreshFromEvent);
    const unsubTodayRecords = window.todayMonitorApi?.onRecordsReset?.(refreshFromEvent);
    const unsubTodaySessionsUpdated = window.todayMonitorApi?.onSessionsUpdated?.(onSessionChange);
    const unsubSettings = window.adminApi.onSettingsChanged?.(onSettingsChange);
    const unsubEvents = window.adminApi.onEventsChanged?.(refreshFromEvent);
    return () => {
      unsubLogged?.();
      unsubUpdated?.();
      unsubCleared?.();
      unsubTodayReset?.();
      unsubTodayRecords?.();
      unsubTodaySessionsUpdated?.();
      unsubSettings?.();
      unsubEvents?.();
    };
  }, [applySessionRecordUpdate, refresh]);

  useEffect(() => {
    const timer = setInterval(() => refresh('poll'), 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  const currentMode = settings?.mode === 'event' ? 'Event' : 'Daily';
  const currentEventLabel = settings?.mode === 'event'
    ? (activeEvent?.name || 'No active event')
    : 'All daily sessions';
  const handlePrintToggle = () => {
    commitSettingsPatch({ printEnabled: !printEnabled }, { key: 'printEnabled', value: !printEnabled });
  };

  const handlePrintCopiesToggle = async () => {
    if (printCopiesUpdating) return;
    const nextValue = !printCopiesEnabled;
    setPrintCopiesUpdating(true);
    try {
      const saved = await commitSettingsPatch(
        { printCopiesEnabled: nextValue },
        { key: 'printCopiesEnabled', value: nextValue },
      );
      if (saved && IS_DEV) {
        console.log('[today-monitor] printCopiesEnabled changed', nextValue);
      }
    } finally {
      setPrintCopiesUpdating(false);
    }
  };

  const handleSelectedPrinterChange = async (printerName) => {
    const saved = await commitSettingsPatch(
      { selectedPrinterName: printerName || null },
      { key: 'selectedPrinterName', value: printerName || null },
    );
    if (saved) await refresh('manual');
  };

  const handleRefreshPrinters = async () => {
    if (!window.printApi?.listPrinters) {
      setPrinterError('Printer detection requires the Electron runtime.');
      return;
    }
    try {
      const res = await window.printApi.listPrinters();
      if (!res?.ok) throw new Error(res?.error || 'failed to load printers');
      setPrinterList({
        printers: Array.isArray(res.printers) ? res.printers : [],
        selphyPrinters: Array.isArray(res.selphyPrinters) ? res.selphyPrinters : [],
        selectedPrinterName: res.selectedPrinterName || settings?.selectedPrinterName || null,
        guidance: res.guidance || null,
      });
      setPrinterError(null);
    } catch (err) {
      setPrinterError(err?.message || String(err));
    }
  };

  const handleSoftcopyToggle = (key) => {
    const nextValue = !softcopySettings[key];
    const nextSoftcopySettings = {
      ...softcopySettings,
      [key]: nextValue,
    };
    if (key === 'qrEnabled') {
      console.log('[softcopy] QR toggled', { qrEnabled: nextValue });
    }
    commitSettingsPatch({ softcopySettings: nextSoftcopySettings }, { key: `softcopy.${key}`, value: nextSoftcopySettings[key] });
  };

  const handleCountdownChange = (value) => {
    setCountdownDraft(value);
    if (value === '') return;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return;
    const nextCountdown = normalizeCountdownSeconds(parsed);
    if (parsed >= MIN_COUNTDOWN_SECONDS && parsed <= MAX_COUNTDOWN_SECONDS) {
      commitSettingsPatch({ countdownSeconds: nextCountdown }, { key: 'countdownSeconds', value: nextCountdown });
    }
  };

  const handleCountdownBlur = () => {
    const nextCountdown = normalizeCountdownSeconds(countdownDraft);
    setCountdownDraft(String(nextCountdown));
    if (nextCountdown !== countdownSeconds) {
      commitSettingsPatch({ countdownSeconds: nextCountdown }, { key: 'countdownSeconds', value: nextCountdown });
    }
  };

  const handleCursorToggle = () => {
    setCursorHidden((prev) => !prev);
  };

  const handleDownloadsDiagTest = async () => {
    if (downloadsDiagRunning) return;
    console.log('[DIAG renderer] write downloads test clicked');
    console.log('[DIAG renderer] window.diagApi availability', {
      hasDiagApi: Boolean(window.diagApi),
      hasWriteDownloadsTextFile: Boolean(window.diagApi?.writeDownloadsTextFile),
    });
    setDownloadsDiagRunning(true);
    try {
      if (!window.diagApi?.writeDownloadsTextFile) {
        throw new Error('Diagnostic Downloads API is unavailable.');
      }
      const result = await window.diagApi.writeDownloadsTextFile();
      console.log('[DIAG renderer] write downloads test result', result);
      setDownloadsDiagResult(result);
    } catch (error) {
      console.error('[DIAG renderer] write downloads test error', error);
      setDownloadsDiagResult({
        ok: false,
        error: error?.message || String(error),
      });
    } finally {
      setDownloadsDiagRunning(false);
    }
  };

  const handleDownloadsPngDiagTest = async () => {
    if (downloadsPngDiagRunning) return;
    console.log('[DIAG STEP 2 renderer] write PNG test clicked');
    setDownloadsPngDiagRunning(true);
    try {
      if (!window.diagApi?.writeDownloadsPngFile) {
        throw new Error('Diagnostic PNG Downloads API is unavailable.');
      }
      const canvas = document.createElement('canvas');
      canvas.width = 1200;
      canvas.height = 1800;
      console.log('[DIAG STEP 2 renderer] creating PNG canvas', {
        width: canvas.width,
        height: canvas.height,
      });
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#000000';
      ctx.font = 'bold 72px sans-serif';
      ctx.fillText('AFTERIMAGE PNG TEST', 80, 130);
      ctx.font = '36px sans-serif';
      ctx.fillText(new Date().toISOString(), 80, 190);

      const boxWidth = 300;
      const boxHeight = 430;
      const boxes = [
        [80, 280],
        [430, 280],
        [80, 780],
        [430, 780],
        [80, 1280],
        [430, 1280],
      ];
      ctx.strokeStyle = '#d71920';
      ctx.lineWidth = 10;
      boxes.forEach(([x, y], index) => {
        ctx.strokeRect(x, y, boxWidth, boxHeight);
        ctx.fillStyle = '#d71920';
        ctx.font = 'bold 34px sans-serif';
        ctx.fillText(`slot ${index + 1}`, x + 28, y + 58);
      });

      const blob = await new Promise((resolve, reject) => {
        canvas.toBlob((nextBlob) => {
          if (nextBlob) {
            resolve(nextBlob);
          } else {
            reject(new Error('Could not create diagnostic PNG blob.'));
          }
        }, 'image/png');
      });
      console.log('[DIAG STEP 2 renderer] PNG blob created', {
        blobSize: blob.size,
        blobType: blob.type,
      });
      const arrayBuffer = await blob.arrayBuffer();
      console.log('[DIAG STEP 2 renderer] PNG arrayBuffer ready', {
        byteLength: arrayBuffer.byteLength,
      });
      const result = await window.diagApi.writeDownloadsPngFile({
        arrayBuffer,
      });
      console.log('[DIAG STEP 2 renderer] write PNG test result', result);
      setDownloadsPngDiagResult(result);
    } catch (error) {
      console.error('[DIAG STEP 2 renderer] write PNG test error', error);
      setDownloadsPngDiagResult({
        ok: false,
        error: error?.message || String(error),
      });
    } finally {
      setDownloadsPngDiagRunning(false);
    }
  };

  const handleKeychainDiagTest = async () => {
    if (keychainDiagRunning) return;
    setKeychainDiagRunning(true);
    try {
      if (!window.diagApi?.writeDownloadsPngFile) {
        throw new Error('Diagnostic PNG Downloads API is unavailable.');
      }
      const keychain = await generateKeychain4x6TestPng();
      const arrayBuffer = await keychain.blob.arrayBuffer();
      const result = await window.diagApi.writeDownloadsPngFile({
        filename: keychain.filename,
        arrayBuffer,
      });
      console.log('[STEP 3 keychain test] save result', {
        filename: result?.filename || keychain.filename,
        targetPath: result?.targetPath,
        exists: result?.exists,
        sizeBytes: result?.sizeBytes,
      });
      setKeychainDiagResult({
        ...result,
        filename: result?.filename || keychain.filename,
      });
    } catch (error) {
      console.error('[STEP 3 keychain test] failed', error);
      setKeychainDiagResult({
        ok: false,
        error: error?.message || String(error),
      });
    } finally {
      setKeychainDiagRunning(false);
    }
  };

  const handleCancelPrintJob = useCallback(async (id) => {
    if (!window.printApi?.cancelJob) {
      setQueueError('Print queue controls require the Electron runtime.');
      return;
    }
    const res = await window.printApi.cancelJob(id);
    if (!res?.ok) {
      setQueueError(res?.error || 'Cancel failed.');
      await refresh('manual');
      return;
    }
    setQueueError(null);
    await refresh('manual');
  }, [refresh]);

  const handleDeletePrintJob = useCallback(async (id) => {
    if (!window.printApi?.deleteJob) {
      setQueueError('Print queue controls require the Electron runtime.');
      return;
    }
    const res = await window.printApi.deleteJob(id);
    if (!res?.ok) {
      setQueueError(res?.error || 'Delete failed.');
      await refresh('manual');
      return;
    }
    setQueueError(null);
    await refresh('manual');
  }, [refresh]);

  const handleClearCompletedPrintJobs = useCallback(async () => {
    if (!window.printApi?.clearCompletedJobs) {
      setQueueError('Print queue controls require the Electron runtime.');
      return;
    }
    const res = await window.printApi.clearCompletedJobs();
    if (!res?.ok) {
      setQueueError(res?.error || 'Clear completed failed.');
      await refresh('manual');
      return;
    }
    setQueueError(null);
    await refresh('manual');
  }, [refresh]);

  const handleSessionReset = useCallback(async () => {
    if (resetting) return;
    if (!window.adminApi?.resetSession) {
      setError('Today Monitor requires the Electron runtime.');
      return;
    }

    setResetting(true);
    console.log('[monitor] reset session executing');
    try {
      const res = await window.adminApi.resetSession();
      if (!res?.ok) throw new Error(res?.error || 'failed to reset session');
      setError(null);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setResetting(false);
    }
  }, [resetting]);

  const handleRequestSessionReset = useCallback(() => {
    console.log('[monitor] reset-session action triggered');
    setShowResetModal(true);
  }, []);

  const handleConfirmSessionReset = useCallback(async () => {
    setShowResetModal(false);
    await handleSessionReset();
  }, [handleSessionReset]);

  const handleCancelSessionReset = useCallback(() => {
    console.log('[monitor] reset cancelled');
    setShowResetModal(false);
  }, []);

  const handleRequestExtraPrint = useCallback((session) => {
    if (!session) return;
    const printExtraSessionCopy = getPrintExtraSessionCopyApi();
    logTodayMonitorActionApiCheck('request-extra-print');
    console.log('[extra print UI] session object', session);
    console.log('[today-monitor print-extra UI] clicked', {
      sessionId: session.id,
      hasApi: Boolean(printExtraSessionCopy),
      hasTodayMonitorApi: Boolean(window.todayMonitorApi),
      todayMonitorApiKeys: window.todayMonitorApi ? Object.keys(window.todayMonitorApi) : [],
      hasAdminApi: Boolean(window.adminApi),
      adminApiKeys: window.adminApi ? Object.keys(window.adminApi) : [],
      hasPrintApi: Boolean(window.printApi),
      printApiKeys: window.printApi ? Object.keys(window.printApi) : [],
    });
    setExtraPrintFeedback(null);
    setExtraPrintModalSession({
      id: session.id,
      timestamp: session.timestamp,
      templateName: session.templateName,
      layoutName: session.layoutName,
      copies: getSessionTotalCopies(session),
      extraPrintCount: getSessionExtraPrintCount(session),
      pricePerCopy: getSessionUnitPrice(session),
    });
  }, []);

  const handleCancelExtraPrint = useCallback(() => {
    setExtraPrintModalSession(null);
  }, []);

  const handleConfirmExtraPrint = useCallback(async () => {
    const session = extraPrintModalSession;
    if (!session) return;
    if (extraPrintLoadingSessionId) return;
    const currentSelectedPrinterName = settings?.selectedPrinterName || printerList.selectedPrinterName || null;
    const printExtraSessionCopy = getPrintExtraSessionCopyApi();
    logTodayMonitorActionApiCheck('confirm-extra-print');
    console.log('[print extra copy UI] API check', {
      hasTodayMonitorApi: Boolean(window.todayMonitorApi),
      todayMonitorApiKeys: window.todayMonitorApi ? Object.keys(window.todayMonitorApi) : [],
      hasAdminApi: Boolean(window.adminApi),
      adminApiKeys: window.adminApi ? Object.keys(window.adminApi) : [],
      hasPrintApi: Boolean(window.printApi),
      printApiKeys: window.printApi ? Object.keys(window.printApi) : [],
      hasPrintExtraSessionCopy: Boolean(printExtraSessionCopy),
    });
    if (!printExtraSessionCopy) {
      const error = 'Print extra copy API is unavailable.';
      console.error('[today-monitor print-extra UI] API unavailable', {
        hasTodayMonitorApi: Boolean(window.todayMonitorApi),
        keys: window.todayMonitorApi ? Object.keys(window.todayMonitorApi) : [],
        hasAdminApi: Boolean(window.adminApi),
        hasPrintApi: Boolean(window.printApi),
      });
      setExtraPrintFeedback({ sessionId: session.id, ok: false, message: error });
      return;
    }

    setExtraPrintLoadingSessionId(session.id);
    console.log('[today-monitor print-extra UI] confirmed', {
      sessionId: session.id,
      time: session.timestamp,
      templateName: session.templateName,
      layoutName: session.layoutName,
      copies: session.copies,
      pricePerCopy: session.pricePerCopy,
      printerName: currentSelectedPrinterName,
    });
    try {
      const result = await printExtraSessionCopy({
        sessionId: session.id,
        copies: 1,
      });
      console.log('[today-monitor print-extra UI] result', result);
      if (!result?.ok) {
        throw new Error(result?.error || 'failed to print extra copy');
      }
      if (result.updatedSession) {
        setSessions((current) => current.map((record) => (
          record.id === result.updatedSession.id ? result.updatedSession : record
        )));
      }
      setExtraPrintFeedback({
        sessionId: session.id,
        ok: true,
        message: 'Extra copy printed.',
      });
      setExtraPrintModalSession(null);
    } catch (err) {
      const message = err?.message || String(err);
      console.error('[today-monitor print-extra UI] failed', err);
      setExtraPrintFeedback({
        sessionId: session.id,
        ok: false,
        message: `Failed to print extra copy: ${message}`,
      });
    } finally {
      setExtraPrintLoadingSessionId(null);
    }
  }, [extraPrintLoadingSessionId, extraPrintModalSession, printerList.selectedPrinterName, settings?.selectedPrinterName]);

  const handleRequestKeychain = useCallback((session) => {
    if (!session) return;
    const generateAndPrintKeychain = getGenerateAndPrintKeychainApi();
    logTodayMonitorActionApiCheck('request-keychain');
    console.log('[today-monitor keychain UI] clicked', {
      sessionId: session.id,
      hasApi: Boolean(generateAndPrintKeychain),
      hasTodayMonitorApi: Boolean(window.todayMonitorApi),
      todayMonitorApiKeys: window.todayMonitorApi ? Object.keys(window.todayMonitorApi) : [],
      layoutId: session.layoutId || null,
      hasFinalPrintPath: Boolean(session.finalPrintPath || session.printImagePath || session.softcopyPhotoPath),
      keychainPath: session.keychainPath || null,
      keychainPrintCount: getSessionKeychainPrintCount(session),
      keychainUnitsSold: getSessionKeychainUnitsSold(session),
      keychainRevenue: getSessionKeychainRevenue(session),
    });
    setKeychainFeedback(null);
    setKeychainCopiesDraft(DEFAULT_KEYCHAIN_COPIES);
    setKeychainModalSession({
      id: session.id,
      timestamp: session.timestamp,
      templateName: session.templateName,
      templateId: session.templateId,
      layoutName: session.layoutName,
      layoutId: session.layoutId,
      keychainPath: session.keychainPath || null,
      keychainFilename: session.keychainFilename || null,
      keychainPrintCount: getSessionKeychainPrintCount(session),
      keychainUnitsSold: getSessionKeychainUnitsSold(session),
      keychainRevenue: getSessionKeychainRevenue(session),
      keychainTransactions: getSessionKeychainTransactions(session),
      alreadyGenerated: Boolean(session.keychainPath || session.keychainGeneratedAt),
    });
  }, []);

  const handleCancelKeychain = useCallback(() => {
    setKeychainModalSession(null);
  }, []);

  const handleConfirmKeychain = useCallback(async () => {
    const session = keychainModalSession;
    if (!session) return;
    if (keychainLoading) return;
    const keychainCopies = normalizeKeychainCopies(keychainCopiesDraft);
    const keychainAmount = getKeychainPrice(keychainCopies);

    const generateAndPrintKeychain = getGenerateAndPrintKeychainApi();
    logTodayMonitorActionApiCheck('confirm-keychain');
    if (!generateAndPrintKeychain) {
      const error = 'Keychain API is unavailable.';
      console.error('[today-monitor keychain UI] API unavailable', {
        hasTodayMonitorApi: Boolean(window.todayMonitorApi),
        keys: window.todayMonitorApi ? Object.keys(window.todayMonitorApi) : [],
      });
      setKeychainFeedback({ sessionId: session.id, ok: false, message: error });
      return;
    }

    setKeychainLoading({
      sessionId: session.id,
      label: session.alreadyGenerated ? 'Printing...' : 'Generating...',
    });
    console.log('[today-monitor keychain UI] confirmed', {
      sessionId: session.id,
      time: session.timestamp,
      templateName: session.templateName,
      layoutName: session.layoutName,
      alreadyGenerated: session.alreadyGenerated,
      keychainCopies,
      keychainAmount,
    });

    try {
      let result = await generateAndPrintKeychain({
        sessionId: session.id,
        keychainCopies,
      });

      if (result?.needsGeneration) {
        const sourceDataUrl = result.sourceDataUrl || '';
        if (!sourceDataUrl.startsWith('data:image/')) {
          throw new Error('Keychain source image is unavailable for this session.');
        }
        setKeychainLoading({
          sessionId: session.id,
          label: 'Generating...',
        });

        console.log('[today-monitor keychain UI] generating renderer keychain', {
          sessionId: session.id,
          layoutId: result.layoutId || session.layoutId || null,
          filename: result.filename || null,
          sourceLength: sourceDataUrl.length,
          keychainCopies,
        });

        const keychain = await generateKeychain4x6Png({
          layout: { id: result.layoutId || session.layoutId },
          layoutId: result.layoutId || session.layoutId,
          finalArtworkDataUrl: sourceDataUrl,
          sourceStripDataUrl: sourceDataUrl,
          selectedTemplate: {
            id: result.templateId || session.templateId || '',
            name: result.templateName || session.templateName || '',
          },
          selectedTmpl: result.templateId || session.templateId || '',
          selectedFilterCss: result.selectedFilterCss || '',
          sessionId: session.id,
          keychainCopies,
        });

        if (!keychain?.blob) {
          throw new Error(`Unsupported keychain layout: ${result.layoutId || session.layoutId || 'unknown'}`);
        }

        const arrayBuffer = await keychain.blob.arrayBuffer();
        setKeychainLoading({
          sessionId: session.id,
          label: 'Printing...',
        });
        result = await generateAndPrintKeychain({
          sessionId: session.id,
          keychainCopies,
          filename: result.filename || keychain.filename,
          mimeType: 'image/png',
          arrayBuffer,
          width: keychain.width,
          height: keychain.height,
          placementCount: keychain.placements?.length || 0,
          generatedAt: new Date().toISOString(),
        });
      }

      console.log('[today-monitor keychain UI] result', result);
      if (!result?.ok) {
        throw new Error(result?.error || 'failed to generate keychain');
      }

      if (result.updatedSession) {
        setSessions((current) => current.map((record) => (
          record.id === result.updatedSession.id ? result.updatedSession : record
        )));
      }
      const printCount = getSessionKeychainPrintCount(result.updatedSession || {});
      const unitsSold = getSessionKeychainUnitsSold(result.updatedSession || {});
      const revenue = getSessionKeychainRevenue(result.updatedSession || {});
      const totalSuffix = result.updatedSession && unitsSold > 0
        ? ` Total: ${fmtInt(unitsSold)} copies • ${fmtMoney(revenue)} across ${fmtInt(printCount)} sheet${printCount === 1 ? '' : 's'}.`
        : '';
      setKeychainFeedback({
        sessionId: session.id,
        ok: true,
        message: `${result.reusedExisting ? 'Existing keychain printed.' : 'Keychain generated and printed.'} ${fmtInt(keychainCopies)} copies • ${fmtMoney(keychainAmount)}.${totalSuffix}`,
      });
      setKeychainModalSession(null);
    } catch (err) {
      const message = err?.message || String(err);
      console.error('[today-monitor keychain UI] failed', err);
      setKeychainFeedback({
        sessionId: session.id,
        ok: false,
        message: `Failed to generate keychain: ${message}`,
      });
    } finally {
      setKeychainLoading(null);
    }
  }, [keychainCopiesDraft, keychainLoading, keychainModalSession]);

  const handleConfirmExit = useCallback(async () => {
    if (!window.adminApi?.quitApp) {
      setError('Today Monitor requires the Electron runtime.');
      return;
    }
    console.log('[monitor] exit confirmed');
    try {
      await window.adminApi.quitApp();
    } catch (err) {
      setError(err?.message || String(err));
      setShowExitModal(false);
    }
  }, []);

  const handleCancelExit = useCallback(() => {
    console.log('[monitor] exit cancelled');
    setShowExitModal(false);
  }, []);

  useEffect(() => {
    const onKeyDown = (event) => {
      const key = String(event.key || '').toLowerCase();
      if (showExitModal && key === 'escape') {
        event.preventDefault();
        handleCancelExit();
        return;
      }
      if (extraPrintModalSession && key === 'escape') {
        event.preventDefault();
        handleCancelExtraPrint();
        return;
      }
      if (showResetModal && key === 'escape') {
        event.preventDefault();
        handleCancelSessionReset();
        return;
      }
      const refreshShortcut = key === 'f5' || ((event.ctrlKey || event.metaKey) && key === 'r') || ((event.ctrlKey || event.metaKey) && key === '4');
      if (!refreshShortcut) return;
      if (showExitModal || showResetModal || extraPrintModalSession) {
        event.preventDefault();
        return;
      }
      event.preventDefault();
      refresh('shortcut');
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [extraPrintModalSession, handleCancelExit, handleCancelExtraPrint, handleCancelSessionReset, refresh, showExitModal, showResetModal]);

  const sortedPrintJobs = sortPrintJobs(printJobs);
  const hasCompletedPrintJobs = printJobs.some((job) => ['completed', 'failed', 'cancelled', 'partial'].includes(job.status));
  const selectedPrinterName = settings?.selectedPrinterName || printerList.selectedPrinterName || null;
  const visiblePrinters = printerList.selphyPrinters.length > 0 ? printerList.selphyPrinters : printerList.printers;
  const selectedPrinter = printerList.printers.find((printer) => printer.name === selectedPrinterName) || null;

  useEffect(() => {
    if (!IS_DEV) return;

    sessions
      .filter((session) => session?.status === 'completed')
      .forEach((session) => {
        const extraPrintUnavailableReason = getExtraPrintUnavailableReason({
          session,
          printEnabled,
          selectedPrinterName,
          selectedPrinter,
          visiblePrinters,
        });
        const keychainUnavailableReason = getKeychainUnavailableReason({
          session,
          printEnabled,
          selectedPrinterName,
          selectedPrinter,
          visiblePrinters,
        });
        const isExtraPrintLoading = extraPrintLoadingSessionId === session.id;
        const keychainLoadingState = keychainLoading?.sessionId === session.id ? keychainLoading : null;
        const actionAudit = {
          sessionId: session.id || session.sessionId,
          status: session.status,
          hasPrintablePath: Boolean(session.finalPrintPath || session.printImagePath || session.localPhotoPath || session.photoPath || session.softcopyPhotoPath),
          finalPrintPath: session.finalPrintPath || null,
          printImagePath: session.printImagePath || null,
          localPhotoPath: session.localPhotoPath || null,
          photoPath: session.photoPath || null,
          softcopyPhotoPath: session.softcopyPhotoPath || null,
          printEnabled,
          selectedPrinterName,
          selectedPrinterFound: Boolean(selectedPrinter),
          selectedPrinterAvailable: selectedPrinter?.isAvailable ?? null,
          visiblePrinterCount: visiblePrinters.length,
          hasPrintExtraApi: Boolean(getPrintExtraSessionCopyApi()),
          hasKeychainApi: Boolean(getGenerateAndPrintKeychainApi()),
          isPrintAnotherDisabled: Boolean(extraPrintUnavailableReason) || isExtraPrintLoading,
          disabledReason: extraPrintUnavailableReason || null,
          isKeychainDisabled: Boolean(keychainUnavailableReason) || Boolean(keychainLoadingState),
          keychainDisabledReason: keychainUnavailableReason || null,
        };
        const actionAuditKey = JSON.stringify(actionAudit);
        if (sessionActionAuditRef.current.get(session.id) !== actionAuditKey) {
          sessionActionAuditRef.current.set(session.id, actionAuditKey);
          console.log('[today session action audit]', actionAudit);
        }
      });
  }, [
    extraPrintLoadingSessionId,
    keychainLoading,
    printEnabled,
    selectedPrinter,
    selectedPrinterName,
    sessions,
    visiblePrinters,
  ]);

  return (
    <div className={`monitor-shell today-monitor ${showExitModal ? 'is-exit-modal-open' : ''}`}>
      <header className="monitor-header">
        <div className="monitor-header-copy">
          <div className="monitor-title">Afterimage Today Monitor</div>
          <div className="monitor-date">{fmtDate(new Date())}</div>
        </div>
        <div className="monitor-header-actions">
          <div className="monitor-updated">
            <span>Last updated</span>
            <strong>{lastUpdated ? fmtTime(lastUpdated) : '—'}</strong>
          </div>
          <button
            type="button"
            className="monitor-refresh"
            onClick={() => refresh('manual')}
            disabled={loading || refreshing}
          >
            {loading ? 'Loading...' : refreshing ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>
        </header>

      <div className="monitor-body">
        <div className="monitor-layout">
            <section className="monitor-overview monitor-card">
              <div className="monitor-list-head monitor-section-head">
                <div>
                  <div className="monitor-list-title">Today Overview</div>
                  <div className="monitor-list-sub">Sales and output status for the current operating day.</div>
                </div>
                <div className="monitor-overview-context">
                  <span>{currentMode}</span>
                  <strong>{currentEventLabel}</strong>
                </div>
              </div>
              <div className="monitor-summary">
                <article className="monitor-stat">
                  <span>Sessions</span>
                  <strong>{fmtInt(summary.sessionsToday)}</strong>
                </article>
                <article className="monitor-stat">
                  <span>Copies</span>
                  <strong>{fmtInt(summary.copiesToday)}</strong>
                </article>
                <article className="monitor-stat">
                  <span>Strip Revenue</span>
                  <strong>{fmtMoney(summary.stripSessionRevenueToday)}</strong>
                </article>
                <article className="monitor-stat">
                  <span>Keychain Revenue</span>
                  <strong>{fmtMoney(summary.keychainRevenueToday)}</strong>
                </article>
                <article className="monitor-stat monitor-stat-total">
                  <span>Total Revenue</span>
                  <strong>{fmtMoney(summary.totalRevenueToday)}</strong>
                </article>
              </div>
              <div className="monitor-overview-meta">
                <span>QR {fmtInt(summary.qrSessionsToday)}</span>
                <span>Test {fmtInt(summary.testSessionsToday)}</span>
                <span>Failed {fmtInt(summary.failedSessionsToday)}</span>
              </div>
            </section>

            {error && (
              <div className="monitor-error">
                <span>Unable to load today&apos;s sessions.</span>
                <button type="button" onClick={() => refresh('manual')} disabled={refreshing}>Retry</button>
              </div>
            )}

            <section className="monitor-keychains monitor-card">
              <div className="monitor-list-head">
                <div>
                  <div className="monitor-list-title">Keychains</div>
                  <div className="monitor-list-sub">Separate units, sheets, and revenue.</div>
                </div>
              </div>
              <div className="monitor-keychain-stats">
                <article className="monitor-keychain-stat">
                  <span>Units Sold</span>
                  <strong>{fmtInt(summary.keychainUnitsToday)}</strong>
                </article>
                <article className="monitor-keychain-stat">
                  <span>Keychain Revenue</span>
                  <strong>{fmtMoney(summary.keychainRevenueToday)}</strong>
                </article>
                <article className="monitor-keychain-stat">
                  <span>Sheets Printed</span>
                  <strong>{fmtInt(summary.keychainTransactionsToday)}</strong>
                </article>
              </div>
              <div className="monitor-keychain-recent">
                <div className="monitor-keychain-recent-title">Recent Keychain Sales</div>
                {summary.recentKeychainSales.length === 0 ? (
                  <div className="monitor-keychain-empty">No keychain sales yet.</div>
                ) : (
                  summary.recentKeychainSales.map((sale) => (
                    <div key={sale.id || `${sale.sessionId}-${sale.createdAt}-${sale.copies}`} className="monitor-keychain-sale">
                      <strong>{fmtInt(sale.copies)} copies • {fmtMoney(sale.amount)}</strong>
                      <span>{sale.templateName} • {fmtShortTime(sale.createdAt)}</span>
                    </div>
                  ))
                )}
              </div>
            </section>

            <section className="monitor-controls monitor-card">
              <div className="monitor-controls-head">
                <div>
                  <div className="monitor-list-title">Quick Controls</div>
                  <div className="monitor-list-sub">Changes sync to the main app immediately.</div>
                </div>
                <button
                  type="button"
                  className="monitor-refresh"
                  onClick={handleRequestSessionReset}
                  disabled={loading || refreshing || resetting}
                >
                  {resetting ? 'Resetting...' : 'Reset Current Session'}
                </button>
              </div>
              <div className="monitor-operation-strip">
                <span className={`monitor-badge ${testModeEnabled ? 'bad' : ''}`}>
                  {testModeEnabled ? 'TEST MODE ACTIVE' : 'Test Mode Off'}
                </span>
              </div>
              <div className="monitor-controls-grid">
                <div className={`monitor-toggle ${printEnabled ? 'on' : 'off'}`} role="group" aria-label="Print setting">
                  <span>Print</span>
                  <button type="button" onClick={handlePrintToggle} disabled={loading || refreshing}>
                    {printEnabled ? 'Enabled' : 'Disabled'}
                  </button>
                </div>
                <div
                  className={`monitor-toggle monitor-toggle--copies ${printCopiesEnabled ? 'on' : 'off'}`}
                  role="group"
                  aria-label="Print copies setting"
                >
                  <div className="monitor-toggle-copy">
                    <span>Print Copies</span>
                    <strong>{printCopiesEnabled ? 'Multiple copies' : '1 copy only'}</strong>
                  </div>
                  <button
                    type="button"
                    onClick={handlePrintCopiesToggle}
                    disabled={loading || refreshing || printCopiesUpdating}
                    aria-pressed={printCopiesEnabled}
                  >
                    {printCopiesUpdating
                      ? 'Saving...'
                      : printCopiesEnabled
                        ? 'Enabled'
                        : '1 copy only'}
                  </button>
                </div>
                <div className={`monitor-toggle ${cursorHidden ? 'off' : 'on'}`} role="group" aria-label="Cursor setting">
                  <span>Cursor</span>
                  <button type="button" onClick={handleCursorToggle} disabled={loading || refreshing}>
                    {cursorHidden ? 'Hidden' : 'Visible'}
                  </button>
                </div>
                <div className={`monitor-toggle ${qrEnabled ? 'on' : 'off'}`} role="group" aria-label="QR setting">
                  <span>QR</span>
                  <button type="button" onClick={() => handleSoftcopyToggle('qrEnabled')} disabled={loading || refreshing}>
                    {qrEnabled ? 'Enabled' : 'Disabled'}
                  </button>
                </div>
                <div className={`monitor-toggle ${photoEnabled ? 'on' : 'off'}`} role="group" aria-label="Photo setting">
                  <span>Photo</span>
                  <button type="button" onClick={() => handleSoftcopyToggle('photoEnabled')} disabled={loading || refreshing || !qrEnabled}>
                    {photoEnabled ? 'Enabled' : 'Disabled'}
                  </button>
                </div>
                <div className={`monitor-toggle ${gifEnabled ? 'on' : 'off'}`} role="group" aria-label="GIF setting">
                  <span>GIF</span>
                  <button type="button" onClick={() => handleSoftcopyToggle('gifEnabled')} disabled={loading || refreshing || !qrEnabled}>
                    {gifEnabled ? 'Enabled' : 'Disabled'}
                  </button>
                </div>
                <div className={`monitor-toggle ${videoEnabled ? 'on' : 'off'}`} role="group" aria-label="Video setting">
                  <span>Video</span>
                  <button type="button" onClick={() => handleSoftcopyToggle('videoEnabled')} disabled={loading || refreshing || !qrEnabled}>
                    {videoEnabled ? 'Enabled' : 'Disabled'}
                  </button>
                </div>
                <label className="monitor-countdown">
                  <span>Countdown</span>
                  <input
                    type="number"
                    min={MIN_COUNTDOWN_SECONDS}
                    max={MAX_COUNTDOWN_SECONDS}
                    step={1}
                    value={countdownDraft}
                    onChange={(event) => handleCountdownChange(event.target.value)}
                    onBlur={handleCountdownBlur}
                    disabled={loading || refreshing}
                  />
                </label>
              </div>
              {SHOW_DIAGNOSTIC_UI && (
              <div className="monitor-diag-downloads">
                <button
                  type="button"
                  className="monitor-refresh"
                  onClick={handleDownloadsDiagTest}
                  disabled={downloadsDiagRunning}
                >
                  {downloadsDiagRunning ? 'Writing...' : 'STEP 1: Test Downloads Save'}
                </button>
                {downloadsDiagResult && (
                  <div className={`monitor-diag-result ${downloadsDiagResult.ok ? 'ok' : 'bad'}`}>
                    <div><strong>ok:</strong> {String(downloadsDiagResult.ok === true)}</div>
                    {downloadsDiagResult.downloadsDir && (
                      <div><strong>downloadsDir:</strong> {downloadsDiagResult.downloadsDir}</div>
                    )}
                    {downloadsDiagResult.targetPath && (
                      <div><strong>targetPath:</strong> {downloadsDiagResult.targetPath}</div>
                    )}
                    {Object.prototype.hasOwnProperty.call(downloadsDiagResult, 'exists') && (
                      <div><strong>exists:</strong> {String(downloadsDiagResult.exists)}</div>
                    )}
                    {Object.prototype.hasOwnProperty.call(downloadsDiagResult, 'sizeBytes') && (
                      <div><strong>sizeBytes:</strong> {downloadsDiagResult.sizeBytes}</div>
                    )}
                    {downloadsDiagResult.error && (
                      <div><strong>error:</strong> {downloadsDiagResult.error}</div>
                    )}
                  </div>
                )}
                <button
                  type="button"
                  className="monitor-refresh"
                  onClick={handleDownloadsPngDiagTest}
                  disabled={downloadsPngDiagRunning}
                >
                  {downloadsPngDiagRunning ? 'Writing PNG...' : 'STEP 2: Test PNG Save'}
                </button>
                {downloadsPngDiagResult && (
                  <div className={`monitor-diag-result ${downloadsPngDiagResult.ok ? 'ok' : 'bad'}`}>
                    <div><strong>ok:</strong> {String(downloadsPngDiagResult.ok === true)}</div>
                    {downloadsPngDiagResult.downloadsDir && (
                      <div><strong>downloadsDir:</strong> {downloadsPngDiagResult.downloadsDir}</div>
                    )}
                    {downloadsPngDiagResult.targetPath && (
                      <div><strong>targetPath:</strong> {downloadsPngDiagResult.targetPath}</div>
                    )}
                    {Object.prototype.hasOwnProperty.call(downloadsPngDiagResult, 'exists') && (
                      <div><strong>exists:</strong> {String(downloadsPngDiagResult.exists)}</div>
                    )}
                    {Object.prototype.hasOwnProperty.call(downloadsPngDiagResult, 'sizeBytes') && (
                      <div><strong>sizeBytes:</strong> {downloadsPngDiagResult.sizeBytes}</div>
                    )}
                    {downloadsPngDiagResult.error && (
                      <div><strong>error:</strong> {downloadsPngDiagResult.error}</div>
                    )}
                  </div>
                )}
                <button
                  type="button"
                  className="monitor-refresh"
                  onClick={handleKeychainDiagTest}
                  disabled={keychainDiagRunning}
                >
                  {keychainDiagRunning ? 'Saving keychain...' : 'STEP 3: Test Keychain Layout Save'}
                </button>
                {keychainDiagResult && (
                  <div className={`monitor-diag-result ${keychainDiagResult.ok ? 'ok' : 'bad'}`}>
                    <div><strong>ok:</strong> {String(keychainDiagResult.ok === true)}</div>
                    {keychainDiagResult.filename && (
                      <div><strong>filename:</strong> {keychainDiagResult.filename}</div>
                    )}
                    {keychainDiagResult.downloadsDir && (
                      <div><strong>downloadsDir:</strong> {keychainDiagResult.downloadsDir}</div>
                    )}
                    {keychainDiagResult.targetPath && (
                      <div><strong>targetPath:</strong> {keychainDiagResult.targetPath}</div>
                    )}
                    {Object.prototype.hasOwnProperty.call(keychainDiagResult, 'exists') && (
                      <div><strong>exists:</strong> {String(keychainDiagResult.exists)}</div>
                    )}
                    {Object.prototype.hasOwnProperty.call(keychainDiagResult, 'sizeBytes') && (
                      <div><strong>sizeBytes:</strong> {keychainDiagResult.sizeBytes}</div>
                    )}
                    {keychainDiagResult.error && (
                      <div><strong>error:</strong> {keychainDiagResult.error}</div>
                    )}
                  </div>
                )}
              </div>
              )}
            </section>

            <section className="monitor-printer-queue monitor-card">
              <div className="monitor-list-head">
                <div>
                  <div className="monitor-list-title">Printer & Queue</div>
                  <div className="monitor-list-sub">
                    {selectedPrinterName
                      ? selectedPrinterName
                      : 'No Canon SELPHY queue selected.'}
                  </div>
                </div>
                <button
                  type="button"
                  className="monitor-queue-action"
                  onClick={handleRefreshPrinters}
                  disabled={loading || refreshing}
                >
                  Refresh Printers
                </button>
              </div>
              <div className="monitor-printer-current">
                <div>
                  <span>Selected</span>
                  <strong>{selectedPrinterName || 'No printer selected'}</strong>
                </div>
                <div>
                  <span>Status</span>
                  <strong>
                    {selectedPrinter
                      ? selectedPrinter.isAvailable === false
                        ? 'Offline'
                        : (selectedPrinter.statusLabel || 'Ready')
                      : 'Unavailable'}
                  </strong>
                </div>
              </div>
              {(printerError || printerList.guidance) && (
                <div className="monitor-printer-warning">
                  {printerError || printerList.guidance}
                </div>
              )}
              {selectedPrinterName && !selectedPrinter && visiblePrinters.length > 0 && (
                <div className="monitor-printer-warning">
                  Selected printer is missing. Choose an online Canon SELPHY printer.
                </div>
              )}
              <div className="monitor-printer-list">
                {visiblePrinters.map((printer) => {
                  const isSelected = printer.name === selectedPrinterName;
                  return (
                    <article key={printer.name} className={`monitor-printer-row ${isSelected ? 'selected' : ''} ${printer.isAvailable === false ? 'offline' : ''}`}>
                      <div className="monitor-printer-main">
                        <strong>{printer.displayName || printer.name}</strong>
                        <span>{printer.name}</span>
                        <div className="monitor-printer-tags">
                          {printer.isSelphy && <span className="monitor-badge good">Canon SELPHY</span>}
                          {printer.isDefault && <span className="monitor-badge">Default</span>}
                          <span className={`monitor-badge ${printer.isAvailable === false ? 'bad' : 'good'}`}>
                            {printer.isAvailable === false ? 'Offline' : (printer.statusLabel || 'Idle')}
                          </span>
                        </div>
                      </div>
                      <button
                        type="button"
                        className="monitor-queue-action"
                        onClick={() => handleSelectedPrinterChange(printer.name)}
                        disabled={isSelected || loading || refreshing}
                      >
                        {isSelected ? 'Selected' : 'Use this printer'}
                      </button>
                    </article>
                  );
                })}
                {!printerError && !loading && visiblePrinters.length === 0 && (
                  <div className="monitor-empty">No printers detected.</div>
                )}
              </div>

              <div className="monitor-queue-head">
                <div>
                  <div className="monitor-list-title">Print Queue</div>
                  <div className="monitor-list-sub">
                    {queueError
                      ? queueError
                      : sortedPrintJobs.length === 0
                        ? 'No active print jobs.'
                        : `${fmtInt(sortedPrintJobs.length)} app-level print job${sortedPrintJobs.length === 1 ? '' : 's'}`}
                  </div>
                  <div className="monitor-list-sub">
                    App-level jobs can be cancelled here. Jobs already sent to {SYSTEM_PRINT_QUEUE_LABEL} must be managed there.
                  </div>
                </div>
                <button
                  type="button"
                  className="monitor-queue-action"
                  onClick={handleClearCompletedPrintJobs}
                  disabled={!hasCompletedPrintJobs || loading || refreshing}
                >
                  Clear Completed
                </button>
              </div>

              {sortedPrintJobs.length === 0 ? (
                <div className="monitor-empty">No active print jobs.</div>
              ) : (
                <div className="monitor-print-job-list">
                  {sortedPrintJobs.map((job) => {
                    const canCancel = job.status === 'queued' || job.status === 'printing';
                    const canDelete = ['completed', 'failed', 'cancelled', 'partial'].includes(job.status);
                    const finalCopies = job.finalCopies || job.copies || 1;
                    const completedCopies = job.completedCopies || 0;
                    const progressText = job.status === 'queued'
                      ? `${finalCopies} ${finalCopies === 1 ? 'copy' : 'copies'}`
                      : job.status === 'printing'
                        ? `Copy ${Math.min(job.currentCopy || 0, finalCopies)} of ${finalCopies}`
                        : `${completedCopies} of ${finalCopies} printed`;
                    return (
                      <article key={job.id} className={`monitor-print-job status-${job.status}`}>
                        <div className="monitor-print-job-main">
                          <div className="monitor-print-job-top">
                            <span className={`monitor-badge ${getStatusBadgeClass(job.status)}`}>
                              {job.status}
                            </span>
                            <strong>{getPrintJobStatusLabel(job)}</strong>
                          </div>
                          <div className="monitor-print-job-title">
                            {job.templateName || 'Unknown Template'}
                          </div>
                          <div className="monitor-print-job-meta">
                            <span>{job.layoutName || 'Unknown Layout'}</span>
                            {job.printerName && <span>{job.printerName}</span>}
                            <span>{progressText}</span>
                            <span>{job.startedAt ? `Started ${fmtShortTime(job.startedAt)}` : `Queued ${fmtShortTime(job.createdAt)}`}</span>
                          </div>
                          {job.status === 'printing' && (
                            <div className="monitor-print-job-note">
                              Already sent to {SYSTEM_PRINT_QUEUE_LABEL}. Canceling here only stops remaining app-level copies.
                            </div>
                          )}
                          {job.error && <div className="monitor-print-job-error">{job.error}</div>}
                        </div>
                        <div className="monitor-print-job-actions">
                          {canCancel && !job.cancelRequested && (
                            <button
                              type="button"
                              className="monitor-queue-action warning"
                              onClick={() => handleCancelPrintJob(job.id)}
                            >
                              {job.status === 'printing' ? 'Cancel Remaining' : 'Cancel'}
                            </button>
                          )}
                          {job.status === 'printing' && job.cancelRequested && (
                            <button type="button" className="monitor-queue-action" disabled>
                              Cancel requested
                            </button>
                          )}
                          {canDelete && (
                            <button
                              type="button"
                              className="monitor-queue-action"
                              onClick={() => handleDeletePrintJob(job.id)}
                            >
                              Delete
                            </button>
                          )}
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
            </section>

          <section className="monitor-list-wrap monitor-panel monitor-panel-right">
            <div className="monitor-list-head">
              <div className="monitor-list-title">Today&apos;s Sessions</div>
              <div className="monitor-list-sub">
                {loading
                  ? 'Loading today\'s sessions...'
                  : refreshing
                    ? 'Refreshing...'
                    : sessions.length === 0
                      ? 'No sessions yet today.'
                      : `${fmtInt(sessions.length)} sessions · ${fmtInt(summary.failedSessionsToday)} failed`}
              </div>
            </div>

            {loading ? (
              <div className="monitor-empty">Loading today&apos;s sessions...</div>
            ) : sessions.length === 0 ? (
              <div className="monitor-empty">No sessions yet today.</div>
            ) : (
              <div className="monitor-list">
                {sessions.map((session) => {
                  const outputs = buildOutputs(session);
                  const copyCount = getSessionTotalCopies(session);
                  const extraPrintCount = getSessionExtraPrintCount(session);
                  const keychainUnitsSold = getSessionKeychainUnitsSold(session);
                  const keychainRevenue = getSessionKeychainRevenue(session);
                  const keychainTransactions = getSessionKeychainTransactions(session);
                  const keychainGenerated = keychainUnitsSold > 0 || keychainTransactions > 0;
                  const stripSessionRevenue = getStripSessionRevenue(session);
                  const qrLabel = hasQrData(session) ? 'QR' : 'No QR';
                  const scopeLabel = session.mode === 'event'
                    ? `Event: ${session.eventName || activeEvent?.name || 'Unknown Event'}`
                    : 'Daily';
                  const showExtraPrintButton = session.status === 'completed';
                  const showKeychainButton = session.status === 'completed';
                  const extraPrintUnavailableReason = showExtraPrintButton
                    ? getExtraPrintUnavailableReason({
                      session,
                      printEnabled,
                      selectedPrinterName,
                      selectedPrinter,
                      visiblePrinters,
                    })
                    : null;
                  const keychainUnavailableReason = showKeychainButton
                    ? getKeychainUnavailableReason({
                      session,
                      printEnabled,
                      selectedPrinterName,
                      selectedPrinter,
                      visiblePrinters,
                    })
                    : null;
                  const isExtraPrintLoading = extraPrintLoadingSessionId === session.id;
                  const keychainLoadingState = keychainLoading?.sessionId === session.id ? keychainLoading : null;
                  const extraPrintFeedbackMessage = extraPrintFeedback?.sessionId === session.id
                    ? extraPrintFeedback
                    : null;
                  const keychainFeedbackMessage = keychainFeedback?.sessionId === session.id
                    ? keychainFeedback
                    : null;
                  const isPrintAnotherDisabled = Boolean(extraPrintUnavailableReason) || isExtraPrintLoading;
                  const isKeychainDisabled = Boolean(keychainUnavailableReason) || Boolean(keychainLoadingState);
                  return (
                    <article key={session.id} className={`monitor-row ${session.status === 'failed' ? 'is-failed' : ''}`}>
                      <div className="monitor-row-main">
                        <div className="monitor-row-time">{fmtShortTime(session.timestamp)}</div>
                        <div className="monitor-row-template">{session.templateName || 'Unknown Template'}</div>
                        <div className="monitor-row-sub">
                          <span>{session.layoutName || session.layoutId || 'Unknown Layout'}</span>
                          <span>{scopeLabel}</span>
                        </div>
                      </div>
                      <div className="monitor-row-metrics">
                        <strong>{fmtMoney(stripSessionRevenue)}</strong>
                        <span>Strip • {fmtInt(copyCount)} {copyCount === 1 ? 'copy' : 'copies'}</span>
                        {extraPrintCount > 0 && (
                          <em>+{fmtInt(extraPrintCount)} extra</em>
                        )}
                      </div>
                      <div className="monitor-row-badges">
                        <span className={`monitor-badge ${getStatusBadgeClass(session.status)}`}>
                          {getSessionStatusLabel(session.status)}
                        </span>
                        {session.testMode && <span className="monitor-badge bad">TEST</span>}
                        {session.softcopyStatus === 'error' && (
                          <span className="monitor-badge bad">Upload failed</span>
                        )}
                        <span className={`monitor-badge ${hasQrData(session) ? 'good' : ''}`}>
                          {qrLabel}
                        </span>
                        {outputs.length > 0 ? outputs.map((output) => (
                          <span key={output} className="monitor-badge">{output}</span>
                        )) : (
                          <span className="monitor-badge">No Outputs</span>
                        )}
                        {extraPrintCount > 0 && (
                          <span className="monitor-badge monitor-badge-extra">
                            {fmtInt(extraPrintCount)} extra print{extraPrintCount === 1 ? '' : 's'}
                          </span>
                        )}
                        {keychainGenerated && (
                          <span className="monitor-badge monitor-badge-keychain">
                            KEYCHAIN
                          </span>
                        )}
                      </div>
                      {keychainUnitsSold > 0 && (
                        <div className="monitor-row-keychain-line">
                          Keychain: {fmtInt(keychainUnitsSold)} copies • {fmtMoney(keychainRevenue)} • {fmtInt(keychainTransactions)} sheet{keychainTransactions === 1 ? '' : 's'}
                        </div>
                      )}
                      {(showExtraPrintButton || showKeychainButton) && (
                        <div className="monitor-row-actions">
                          <div className="monitor-row-action-buttons">
                            {showExtraPrintButton && (
                              <button
                                type="button"
                                className="monitor-queue-action warning"
                                onClick={() => handleRequestExtraPrint(session)}
                                disabled={isPrintAnotherDisabled}
                              >
                                {isExtraPrintLoading ? 'Printing extra copy...' : 'Print Another Copy'}
                              </button>
                            )}
                            {showKeychainButton && (
                              <button
                                type="button"
                                className="monitor-queue-action keychain"
                                onClick={() => handleRequestKeychain(session)}
                                disabled={isKeychainDisabled}
                              >
                                {keychainLoadingState?.label || 'Print Keychain'}
                              </button>
                            )}
                          </div>
                          {extraPrintUnavailableReason && (
                            <div className="monitor-row-action-note">
                              {extraPrintUnavailableReason}
                            </div>
                          )}
                          {keychainUnavailableReason && (
                            <div className="monitor-row-action-note">
                              {keychainUnavailableReason}
                            </div>
                          )}
                          {extraPrintFeedbackMessage && (
                            <div className={`monitor-row-action-note ${extraPrintFeedbackMessage.ok ? 'ok' : 'bad'}`}>
                              {extraPrintFeedbackMessage.message}
                            </div>
                          )}
                          {keychainFeedbackMessage && (
                            <div className={`monitor-row-action-note ${keychainFeedbackMessage.ok ? 'ok' : 'bad'}`}>
                              {keychainFeedbackMessage.message}
                            </div>
                          )}
                        </div>
                      )}
                    </article>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      </div>

      {showExitModal && (
        <div className="monitor-modal-backdrop" role="presentation">
          <div className="monitor-modal" role="dialog" aria-modal="true" aria-labelledby="monitor-exit-title">
            <div className="monitor-modal-title" id="monitor-exit-title">Exit System</div>
            <div className="monitor-modal-text">
              Do you want to exit the system?
              <span>This will close both the Today Monitor and the main Afterimage window.</span>
            </div>
            <div className="monitor-modal-actions">
              <button type="button" className="monitor-modal-cancel" onClick={handleCancelExit}>
                Cancel
              </button>
              <button type="button" className="monitor-modal-confirm" onClick={handleConfirmExit}>
                Exit System
              </button>
            </div>
          </div>
        </div>
      )}

      {showResetModal && (
        <div className="monitor-modal-backdrop" role="presentation">
          <div className="monitor-modal" role="dialog" aria-modal="true" aria-labelledby="monitor-reset-title">
            <div className="monitor-modal-title" id="monitor-reset-title">Reset Session</div>
            <div className="monitor-modal-text">
              Do you want to reset the current user session?
              <span>This will clear the active capture flow and return the app to the start screen.</span>
            </div>
            <div className="monitor-modal-actions">
              <button type="button" className="monitor-modal-cancel" onClick={handleCancelSessionReset}>
                Cancel
              </button>
              <button type="button" className="monitor-modal-confirm" onClick={handleConfirmSessionReset}>
                Reset Session
              </button>
            </div>
          </div>
        </div>
      )}

      {extraPrintModalSession && (
        <div className="monitor-modal-backdrop" role="presentation">
          <div className="monitor-modal monitor-modal--print-copy" role="dialog" aria-modal="true" aria-labelledby="monitor-print-copy-title">
            <div className="monitor-modal-title" id="monitor-print-copy-title">Print another copy?</div>
            <div className="monitor-modal-text">
              This will print one additional copy of this completed session and add it to today&apos;s copies and revenue.
              <span>
                Session:
                {' '}
                {fmtShortTime(extraPrintModalSession.timestamp)}
                {' • '}
                {extraPrintModalSession.templateName || 'Unknown Template'}
                {' • '}
                {extraPrintModalSession.layoutName || 'Unknown Layout'}
              </span>
              <span>
                Price:
                {' '}
                {fmtMoney(extraPrintModalSession.pricePerCopy || 0)}
              </span>
              <span>
                Current copies:
                {' '}
                {fmtInt(extraPrintModalSession.copies || 0)}
                {extraPrintModalSession.extraPrintCount > 0
                  ? ` (${fmtInt(extraPrintModalSession.extraPrintCount)} extra)`
                  : ''}
              </span>
              <span>
                Printer:
                {' '}
                {selectedPrinterName || 'Auto-select online Canon SELPHY printer'}
              </span>
            </div>
            <div className="monitor-modal-actions">
              <button type="button" className="monitor-modal-cancel" onClick={handleCancelExtraPrint} disabled={Boolean(extraPrintLoadingSessionId)}>
                Cancel
              </button>
              <button type="button" className="monitor-modal-confirm" onClick={handleConfirmExtraPrint} disabled={Boolean(extraPrintLoadingSessionId)}>
                {extraPrintLoadingSessionId ? 'Printing extra copy...' : 'Print 1 Copy'}
              </button>
            </div>
          </div>
        </div>
      )}

      {keychainModalSession && (
        <div className="monitor-modal-backdrop" role="presentation">
          <div className="monitor-modal monitor-modal--keychain" role="dialog" aria-modal="true" aria-labelledby="monitor-keychain-title">
            <div className="monitor-modal-title" id="monitor-keychain-title">Print keychain?</div>
            <div className="monitor-modal-text">
              Choose how many keychain strip copies to include on one generated 4x6 sheet.
              <span>
                Session:
                {' '}
                {fmtShortTime(keychainModalSession.timestamp)}
                {' • '}
                {keychainModalSession.templateName || 'Unknown Template'}
                {' • '}
                {keychainModalSession.layoutName || 'Unknown Layout'}
              </span>
              {keychainModalSession.keychainTransactions > 0 && (
                <span>
                  Keychain sold:
                  {' '}
                  {fmtInt(keychainModalSession.keychainUnitsSold)} copies • {fmtMoney(keychainModalSession.keychainRevenue)}
                  {' '}
                  ({fmtInt(keychainModalSession.keychainTransactions)} sheet{keychainModalSession.keychainTransactions === 1 ? '' : 's'})
                </span>
              )}
              <span>
                Printer:
                {' '}
                {selectedPrinterName || 'Auto-select online Canon SELPHY printer'}
              </span>
            </div>
            <div className="monitor-keychain-options" role="radiogroup" aria-label="Keychain strip copies">
              {KEYCHAIN_COPY_OPTIONS.map((option) => {
                const checked = keychainCopiesDraft === option.copies;
                return (
                  <label key={option.copies} className={`monitor-keychain-option ${checked ? 'is-selected' : ''}`}>
                    <input
                      type="radio"
                      name="keychainCopies"
                      value={option.copies}
                      checked={checked}
                      onChange={() => setKeychainCopiesDraft(option.copies)}
                      disabled={Boolean(keychainLoading)}
                    />
                    <span>
                      <strong>{option.label}</strong>
                      <em>{fmtMoney(option.price)}</em>
                    </span>
                  </label>
                );
              })}
            </div>
            <div className="monitor-modal-actions">
              <button type="button" className="monitor-modal-cancel" onClick={handleCancelKeychain} disabled={Boolean(keychainLoading)}>
                Cancel
              </button>
              <button type="button" className="monitor-modal-confirm" onClick={handleConfirmKeychain} disabled={Boolean(keychainLoading)}>
                {keychainLoading?.label || 'Generate & Print'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
