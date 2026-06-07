import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './TodayMonitor.css';
import { resolveSoftcopySettings } from '../../constants/softcopySettings';
import {
  DEFAULT_COUNTDOWN_SECONDS,
  MAX_COUNTDOWN_SECONDS,
  MIN_COUNTDOWN_SECONDS,
  normalizeCountdownSeconds,
} from '../../constants/countdownSettings';

const IS_DEV = import.meta.env.DEV;
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
  if (job.status === 'printing') {
    return job.cancelRequested ? 'Cancel requested' : `Printing copy ${job.currentCopy || 1} of ${job.copies || 1}`;
  }
  if (job.status === 'queued') return 'Queued';
  if (job.status === 'completed') return 'Completed';
  if (job.status === 'failed') return 'Failed';
  if (job.status === 'cancelled') return job.error || 'Cancelled';
  if (job.status === 'partial') return job.error || `Partial: ${job.currentCopy || 0} of ${job.copies || 1}`;
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

export default function TodayMonitor() {
  const [settings, setSettings] = useState(null);
  const [events, setEvents] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [printJobs, setPrintJobs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [queueError, setQueueError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [countdownDraft, setCountdownDraft] = useState(String(DEFAULT_COUNTDOWN_SECONDS));
  const [resetting, setResetting] = useState(false);
  const [showResetModal, setShowResetModal] = useState(false);
  const [showExitModal, setShowExitModal] = useState(false);
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

  const activeEvent = settings?.activeEventId
    ? (events.find((event) => event.id === settings.activeEventId) || null)
    : null;

  const softcopySettings = useMemo(
    () => resolveSoftcopySettings(settings?.softcopySettings),
    [settings?.softcopySettings],
  );
  const testModeEnabled = settings?.testModeEnabled === true;
  const printEnabled = settings?.printEnabled !== false;
  const qrEnabled = softcopySettings.qrEnabled !== false;
  const photoEnabled = softcopySettings.photoEnabled !== false;
  const gifEnabled = softcopySettings.gifEnabled !== false;
  const videoEnabled = softcopySettings.videoEnabled !== false;
  const countdownSeconds = normalizeCountdownSeconds(settings?.countdownSeconds ?? DEFAULT_COUNTDOWN_SECONDS);

  const summary = useMemo(() => {
    const completed = sessions.filter((session) => session.status !== 'failed');
    const failed = sessions.filter((session) => session.status === 'failed');
    const revenueToday = completed.reduce((sum, session) => sum + (Number(session.totalAmount) || 0), 0);
    const copiesToday = completed.reduce((sum, session) => sum + (Number(session.copies) || 0), 0);
    const qrSessionsToday = sessions.filter((session) => hasQrData(session)).length;
    const testSessionsToday = sessions.filter((session) => session.testMode === true).length;
    const latestSession = sessions[0] || null;
    return {
      sessionsToday: sessions.length,
      revenueToday,
      copiesToday,
      qrSessionsToday,
      testSessionsToday,
      failedSessionsToday: failed.length,
      latestSessionTime: latestSession?.timestamp || null,
    };
  }, [sessions]);

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
    if (source === 'manual' || source === 'shortcut') {
      console.log('[monitor] refresh triggered');
    }

    if (!loadingRef.current) setRefreshing(true);
    try {
      const [settingsRes, eventsRes, sessionsRes, queueRes] = await Promise.all([
        window.adminApi.getSettings(),
        window.adminApi.listEvents(),
        window.adminApi.listSessions({
          limit: 500,
          offset: 0,
          from: todayYmd,
          to: todayYmd,
        }),
        window.printApi?.getQueue ? window.printApi.getQueue() : Promise.resolve({ ok: true, jobs: [] }),
      ]);

      if (requestId !== requestSeqRef.current) return;

      if (!settingsRes?.ok) throw new Error(settingsRes?.error || 'failed to load settings');
      if (!eventsRes?.ok) throw new Error(eventsRes?.error || 'failed to load events');
      if (!sessionsRes?.ok) throw new Error(sessionsRes?.error || 'failed to load sessions');
      if (!queueRes?.ok) throw new Error(queueRes?.error || 'failed to load print queue');

      const nextSessions = Array.isArray(sessionsRes.sessions)
        ? [...sessionsRes.sessions].sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''))
        : [];

      setSettings(settingsRes.settings || null);
      setEvents(eventsRes.events || []);
      setSessions(nextSessions.filter((session) => session.dateLocal === todayYmd));
      setPrintJobs(Array.isArray(queueRes.jobs) ? queueRes.jobs : []);
      setCountdownDraft(String(normalizeCountdownSeconds(settingsRes.settings?.countdownSeconds ?? DEFAULT_COUNTDOWN_SECONDS)));
      setError(null);
      setQueueError(null);
      setLastUpdated(new Date().toISOString());
      if (IS_DEV) {
        console.log('[monitor] loaded settings', settingsRes.settings);
        console.log('[monitor] loaded today sessions', { count: nextSessions.length });
        console.log('[monitor] refreshed', {
          sessionsToday: nextSessions.length,
          revenueToday: nextSessions
            .filter((session) => session.status !== 'failed')
            .reduce((sum, session) => sum + (Number(session.totalAmount) || 0), 0),
          copiesToday: nextSessions
            .filter((session) => session.status !== 'failed')
            .reduce((sum, session) => sum + (Number(session.copies) || 0), 0),
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
      setPrintJobs(Array.isArray(jobs) ? jobs : []);
      setQueueError(null);
    });
  }, []);

  useEffect(() => {
    if (
      !window.adminApi?.onSessionLogged
      && !window.adminApi?.onSessionsCleared
      && !window.adminApi?.onSettingsChanged
      && !window.adminApi?.onEventsChanged
    ) return undefined;
    const onSessionChange = () => refresh('event');
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
    const unsubCleared = window.adminApi.onSessionsCleared?.(onSessionChange);
    const unsubSettings = window.adminApi.onSettingsChanged?.(onSettingsChange);
    const unsubEvents = window.adminApi.onEventsChanged?.(onSessionChange);
    return () => {
      unsubLogged?.();
      unsubCleared?.();
      unsubSettings?.();
      unsubEvents?.();
    };
  }, [refresh]);

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
      if (showResetModal && key === 'escape') {
        event.preventDefault();
        handleCancelSessionReset();
        return;
      }
      const refreshShortcut = key === 'f5' || ((event.ctrlKey || event.metaKey) && key === 'r') || ((event.ctrlKey || event.metaKey) && key === '4');
      if (!refreshShortcut) return;
      if (showExitModal || showResetModal) {
        event.preventDefault();
        return;
      }
      event.preventDefault();
      refresh('shortcut');
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleCancelExit, handleCancelSessionReset, refresh, showExitModal, showResetModal]);

  const sortedPrintJobs = sortPrintJobs(printJobs);
  const hasCompletedPrintJobs = printJobs.some((job) => ['completed', 'failed', 'cancelled', 'partial'].includes(job.status));

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
          <div className="monitor-panel monitor-panel-left">
            <section className="monitor-mode">
              <div className="monitor-mode-item">
                <span>Mode</span>
                <strong>{currentMode}</strong>
              </div>
              <div className="monitor-mode-item">
                <span>Active Event</span>
                <strong>{currentEventLabel}</strong>
              </div>
            </section>

            {error && (
              <div className="monitor-error">
                <span>Unable to load today&apos;s sessions.</span>
                <button type="button" onClick={() => refresh('manual')} disabled={refreshing}>Retry</button>
              </div>
            )}

            <section className="monitor-summary">
              <article className="monitor-stat">
                <span>Sessions</span>
                <strong>{fmtInt(summary.sessionsToday)}</strong>
              </article>
              <article className="monitor-stat">
                <span>Revenue</span>
                <strong>{fmtMoney(summary.revenueToday)}</strong>
              </article>
              <article className="monitor-stat">
                <span>Copies</span>
                <strong>{fmtInt(summary.copiesToday)}</strong>
              </article>
              <article className="monitor-stat">
                <span>QR</span>
                <strong>{fmtInt(summary.qrSessionsToday)}</strong>
              </article>
              <article className="monitor-stat">
                <span>Test</span>
                <strong>{fmtInt(summary.testSessionsToday)}</strong>
              </article>
            </section>

            <section className="monitor-controls">
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
            </section>

            <section className="monitor-print-queue">
              <div className="monitor-list-head">
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
                    const progressText = job.status === 'queued'
                      ? `${job.copies || 1} ${(job.copies || 1) === 1 ? 'copy' : 'copies'}`
                      : `Copy ${Math.min(job.currentCopy || 0, job.copies || 1)} of ${job.copies || 1}`;
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

          </div>

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
                  const copyCount = Number(session.copies || 0);
                  const qrLabel = hasQrData(session) ? 'QR' : 'No QR';
                  const scopeLabel = session.mode === 'event'
                    ? `Event: ${session.eventName || activeEvent?.name || 'Unknown Event'}`
                    : 'Daily';
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
                        <strong>{fmtMoney(session.status === 'failed' ? 0 : session.totalAmount)}</strong>
                        <span>{fmtInt(copyCount)} {copyCount === 1 ? 'copy' : 'copies'}</span>
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
                      </div>
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
    </div>
  );
}
