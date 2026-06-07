import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './App.css';

import LandingScreen from './components/screens/LandingScreen';
import LayoutScreen from './components/screens/LayoutScreen';
import SelectionScreen from './components/screens/SelectionScreen';
import PolicyScreen from './components/screens/PolicyScreen';
import CameraScreen from './components/screens/CameraScreen';
import ArrangeScreen from './components/screens/ArrangeScreen';
import PrintScreen from './components/screens/PrintScreen';
import EndScreen from './components/screens/EndScreen';
import AdminPinScreen from './components/screens/AdminPinScreen';
import Flash from './components/Flash';
import TweaksPanel from './components/TweaksPanel';

import { FILTERS, TWEAK_DEFAULTS } from './constants/filters';
import { findLayout } from './constants/layouts';
import { getEnabledLayouts, resolveLayoutSettings } from './constants/layoutSettings';
import { DEFAULT_COUNTDOWN_SECONDS, normalizeCountdownSeconds } from './constants/countdownSettings';
import { useAdminConfig } from './hooks/useAdminConfig';
import { useStageScale } from './hooks/useStageScale';
import { useTemplates } from './hooks/useTemplates';
import { loadShots, clearShots } from './lib/shotStorage';
import { resolveSoftcopySettings } from './constants/softcopySettings';
import { clampPrintCopies, DEFAULT_PRINT_COPIES } from './constants/printSettings';
import { isTemplateVisibleToCustomer } from './lib/templateVisibility';

const AdminScreen = lazy(() => import('./components/screens/AdminScreen'));
const IS_DEV = import.meta.env.DEV;

export default function App() {
  const stageRef = useRef(null);
  useStageScale(stageRef);

  // ── Navigation / session state ──
  // Flow: landing → layout → policy → camera → arrange → background → print → end
  // The LAYOUT picks the photo arrangement (how many shots, where they go).
  // The DESIGN (selectedTmpl) picks the decorative overlay/frame, AFTER
  // the photos have been taken — so the customer can match a look to the
  // shots they actually got.
  const [curScreen, setCurScreen] = useState('s-landing');
  const [selectedLayout, setSelectedLayout] = useState(null);
  const [selectedTmpl, setSelectedTmpl] = useState(null);
  const [selectedFilter, setSelectedFilter] = useState('none');
  const [softcopy, setSoftcopy] = useState({ status: 'idle', qrUrl: null });
  const [sessionVideo, setSessionVideo] = useState(null);
  // Rehydrate any in-progress shots from localStorage on first render
  const [shots, setShots] = useState(() => loadShots());
  const [arrangedShotIndexes, setArrangedShotIndexes] = useState([]);
  const [copies, setCopies] = useState(DEFAULT_PRINT_COPIES);
  const [retries, setRetries] = useState(1);
  const [flashOn, setFlashOn] = useState(false);
  const [cursorHidden, setCursorHidden] = useState(() => {
    try {
      const stored = localStorage.getItem('kuku.cursorHidden');
      return stored == null ? true : stored === 'true';
    } catch {
      return true;
    }
  });

  // ── Templates (dynamic from main process) ──
  const { settings, events, refresh: refreshAdminConfig } = useAdminConfig();
  const { templates, refresh: refreshTemplates } = useTemplates(settings);
  const layoutSettings = useMemo(
    () => resolveLayoutSettings(settings.layoutSettings),
    [settings.layoutSettings],
  );
  const enabledLayouts = useMemo(
    () => getEnabledLayouts(layoutSettings),
    [layoutSettings],
  );
  // Remember which screen to go back to after exiting admin
  const returnFromAdminRef = useRef('s-landing');

  // Wall-clock timestamp of when the current customer session started
  // (layout pick). Used to compute durationMs for analytics logging.
  const sessionStartRef = useRef(null);

  // Resolve the active layout object from its id. Falls back to the
  // default layout if the id is null/unknown so downstream screens
  // always have something to render against.
  const layout = useMemo(() => findLayout(selectedLayout), [selectedLayout]);
  const arrangedShots = useMemo(
    () => arrangedShotIndexes.map(index => shots[index]).filter(Boolean),
    [arrangedShotIndexes, shots],
  );
  const softcopySettings = useMemo(
    () => resolveSoftcopySettings(settings.softcopySettings),
    [settings.softcopySettings],
  );
  const arrangedSessionVideo = useMemo(() => (
    sessionVideo
      ? {
          ...sessionVideo,
          shotVideoClips: arrangedShotIndexes
            .map((sourceShotIndex, arrangedIndex) => {
              const clip = sessionVideo.shotVideoClips?.[sourceShotIndex];
              return clip ? { ...clip, shotIndex: arrangedIndex } : null;
            })
            .filter(Boolean),
        }
      : null
  ), [arrangedShotIndexes, sessionVideo]);
  const selectedFilterCss = useMemo(
    () => FILTERS.find(f => f.id === selectedFilter)?.css || '',
    [selectedFilter],
  );

  // ── Tweaks ──
  const [primaryColor, setPrimaryColor] = useState(TWEAK_DEFAULTS.primaryColor);
  const [countdown, setCountdown] = useState(DEFAULT_COUNTDOWN_SECONDS);

  // Apply primary color to the CSS variable
  useEffect(() => {
    document.documentElement.style.setProperty('--primary', primaryColor);
  }, [primaryColor]);

  useEffect(() => {
    document.body.classList.toggle('cursor-hidden', cursorHidden);
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
    const resolvedCountdown = normalizeCountdownSeconds(settings.countdownSeconds);
    queueMicrotask(() => setCountdown(resolvedCountdown));
    if (IS_DEV) console.log('[camera] countdown seconds resolved', resolvedCountdown);
  }, [settings.countdownSeconds]);

  const goTo = useCallback(id => setCurScreen(id), []);

  // If the currently-selected design gets deleted or disabled from the
  // admin screen, clear it so we don't ship a broken reference downstream.
  useEffect(() => {
    if (!selectedTmpl) return;
    const stillThere = templates.find(t =>
      t.id === selectedTmpl &&
      t.layoutId &&
      t.layoutId === layout?.id &&
      isTemplateVisibleToCustomer(t, layout, settings)
    );
    if (!stillThere) queueMicrotask(() => setSelectedTmpl(null));
  }, [templates, selectedTmpl, layout, settings]);

  useEffect(() => {
    if (!selectedLayout) return;
    const selectedIsEnabled = enabledLayouts.some((item) => item.id === selectedLayout);
    if (!selectedIsEnabled) {
      queueMicrotask(() => {
        setSelectedLayout(null);
        setSelectedTmpl(null);
        setShots([]);
        setArrangedShotIndexes([]);
        clearShots();
      });
    }
  }, [enabledLayouts, selectedLayout]);

  // Ctrl+Shift+A (or Cmd+Shift+A) anywhere → admin PIN screen
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'A' || e.key === 'a')) {
        e.preventDefault();
        if (curScreen === 's-admin-pin' || curScreen === 's-admin') return;
        returnFromAdminRef.current = curScreen;
        setCurScreen('s-admin-pin');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [curScreen]);

  // ── Handlers ──
  const handleSelectLayout = id => {
    setSelectedLayout(id);
    setSelectedFilter('none');
    setSoftcopy({ status: 'idle', qrUrl: null });
    setSessionVideo(null);
    // Picking a different layout invalidates any in-progress shots —
    // the new layout may need a different number of captures.
    setShots([]);
    setArrangedShotIndexes([]);
    clearShots();
    // Stamp session start on layout pick. Carries through retries so
    // durationMs reflects the full customer journey.
    sessionStartRef.current = Date.now();
  };

  const handleSelectTemplate = id => {
    // Template / design pick happens AFTER the camera, so we don't
    // touch shots here.
    setSelectedTmpl(id);
  };

  const handleChangeCopies = delta =>
    setCopies(c => clampPrintCopies(c + delta));

  const handlePrint = () => goTo('s-end');

  const resetCurrentSession = useCallback(() => {
    setShots([]);
    setArrangedShotIndexes([]);
    clearShots();
    setSelectedLayout(null);
    setSelectedTmpl(null);
    setSelectedFilter('none');
    setSoftcopy({ status: 'idle', qrUrl: null });
    setSessionVideo(null);
    setCopies(DEFAULT_PRINT_COPIES);
    setRetries(1);
    sessionStartRef.current = null;
    goTo('s-landing');
  }, [goTo]);

  useEffect(() => {
    if (!window.adminApi?.onSessionReset) return undefined;
    const unsub = window.adminApi.onSessionReset(() => {
      resetCurrentSession();
    });
    return () => unsub?.();
  }, [resetCurrentSession]);

  const handleRetry = () => {
    if (retries <= 0) return;
    setRetries(r => r - 1);
    setShots([]);
    setArrangedShotIndexes([]);
    clearShots();
    setSelectedFilter('none');
    setSoftcopy({ status: 'idle', qrUrl: null });
    setSessionVideo(null);
    goTo('s-camera');
  };

  const handleEndReturn = () => {
    resetCurrentSession();
  };

  const handleFlash = () => {
    setFlashOn(true);
    setTimeout(() => setFlashOn(false), 120);
  };

  const handleCameraDone = (newShots, videoResult = null) => {
    if (newShots) setShots(newShots);
    setSessionVideo(videoResult);
    setArrangedShotIndexes([]);
    goTo('s-arrange');
  };

  // Admin flow
  const handleAdminUnlock = () => goTo('s-admin');
  const handleAdminCancel = () => goTo(returnFromAdminRef.current || 's-landing');
  const handleAdminExit = async () => {
    await refreshTemplates();
    await refreshAdminConfig();
    goTo(returnFromAdminRef.current || 's-landing');
  };

  return (
    <>
      <div id="stage" ref={stageRef}>
        <LandingScreen
          active={curScreen === 's-landing'}
          settings={settings}
          events={events}
          onStart={() => goTo('s-layout')}
        />

        <LayoutScreen
          active={curScreen === 's-layout'}
          selectedLayout={selectedLayout}
          layouts={enabledLayouts}
          onSelect={handleSelectLayout}
          onBack={() => goTo('s-landing')}
          onNext={() => goTo('s-policy')}
        />

        <PolicyScreen
          active={curScreen === 's-policy'}
          countdown={countdown}
          totalShots={layout.shots}
          onBack={() => goTo('s-layout')}
          onNext={() => goTo('s-camera')}
        />

        <CameraScreen
          active={curScreen === 's-camera'}
          layout={layout}
          countdown={countdown}
          totalShots={layout.shots}
          shots={shots}
          setShots={setShots}
          recordVideo={softcopySettings.qrEnabled && softcopySettings.videoEnabled}
          onFlash={handleFlash}
          onDone={handleCameraDone}
          onBack={() => goTo('s-policy')}
        />

        <ArrangeScreen
          active={curScreen === 's-arrange'}
          layout={layout}
          shots={shots}
          arrangedShotIndexes={arrangedShotIndexes}
          retries={retries}
          onChangeArrangement={setArrangedShotIndexes}
          onRetry={handleRetry}
          onNext={() => goTo('s-design')}
        />

        <SelectionScreen
          active={curScreen === 's-design'}
          layout={layout}
          shots={arrangedShots}
          templates={templates}
          settings={settings}
          selectedFilter={selectedFilter}
          onSelectFilter={setSelectedFilter}
          selectedTmpl={selectedTmpl}
          onSelect={handleSelectTemplate}
          onBack={() => goTo('s-arrange')}
          onNext={() => goTo('s-print')}
        />

        <PrintScreen
          active={curScreen === 's-print'}
          layout={layout}
          templates={templates}
          settings={settings}
          events={events}
          selectedTmpl={selectedTmpl}
          selectedFilterCss={selectedFilterCss}
          shots={arrangedShots}
          sessionVideo={arrangedSessionVideo}
          copies={copies}
          retries={retries}
          sessionStartRef={sessionStartRef}
          softcopy={softcopy}
          onSoftcopyChange={setSoftcopy}
          onChangeCopies={handleChangeCopies}
          onPrint={handlePrint}
          onBack={() => goTo('s-design')}
        />

        <EndScreen
          active={curScreen === 's-end'}
          onReturn={handleEndReturn}
        />

        <AdminPinScreen
          active={curScreen === 's-admin-pin'}
          onUnlock={handleAdminUnlock}
          onCancel={handleAdminCancel}
        />

        {curScreen === 's-admin' && (
          <Suspense fallback={<div className="screen active" id="s-admin">Loading admin...</div>}>
            <AdminScreen
              active
              templates={templates}
              settings={settings}
              events={events}
              onRefresh={refreshTemplates}
              onRefreshConfig={refreshAdminConfig}
              onExit={handleAdminExit}
              cursorHidden={cursorHidden}
              onToggleCursorHidden={(nextValue) => {
                if (typeof nextValue === 'boolean') {
                  setCursorHidden(nextValue);
                  return;
                }
                setCursorHidden((prev) => !prev);
              }}
            />
          </Suspense>
        )}
      </div>

      <Flash on={flashOn} />

      <TweaksPanel
        primaryColor={primaryColor}
        countdown={countdown}
        onColorChange={setPrimaryColor}
        onCountdownChange={setCountdown}
      />
    </>
  );
}
