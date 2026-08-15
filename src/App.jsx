import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './App.css';

import LandingScreen from './components/screens/LandingScreen';
import LayoutScreen from './components/screens/LayoutScreen';
import SelectionScreen from './components/screens/SelectionScreen';
import PolicyScreen from './components/screens/PolicyScreen';
import CameraScreen from './components/screens/CameraScreen';
import ReviewPhotosScreen from './components/screens/ReviewPhotosScreen';
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
import {
  DEFAULT_CAMERA_ORIENTATION,
  normalizeCameraOrientation,
} from './constants/cameraSettings';
import { useAdminConfig } from './hooks/useAdminConfig';
import { useStageScale } from './hooks/useStageScale';
import { useTemplates } from './hooks/useTemplates';
import {
  clearCameraOrientationState,
  clearShots,
  loadCameraOrientationState,
  loadShots,
  saveCameraOrientationState,
} from './lib/shotStorage';
import { resolveSoftcopySettings } from './constants/softcopySettings';
import { clampPrintCopies, DEFAULT_PRINT_COPIES } from './constants/printSettings';
import { isTemplateVisibleToCustomer } from './lib/templateVisibility';
import { describeShotForAudit, getShotImageSource, inspectDataUrl } from './lib/shotImageSource';
import { clearSessionImageCache } from './lib/imageCache';
import {
  getBeautificationFilterCss,
  normalizeBeautificationSettings,
} from './constants/beautificationSettings';

const AdminScreen = lazy(() => import('./components/screens/AdminScreen'));
const IS_DEV = import.meta.env.DEV;

export default function App() {
  const stageRef = useRef(null);
  useStageScale(stageRef);

  // ── Navigation / session state ──
  // Flow: landing → layout → policy → camera → review → arrange → background → print → end
  // The LAYOUT picks the photo arrangement (how many shots, where they go).
  // The DESIGN (selectedTmpl) picks the decorative overlay/frame, AFTER
  // the photos have been taken — so the customer can match a look to the
  // shots they actually got.
  const [curScreen, setCurScreen] = useState('s-landing');
  const [selectedLayout, setSelectedLayout] = useState(null);
  const [selectedTmpl, setSelectedTmpl] = useState(null);
  const [selectedFilter, setSelectedFilter] = useState('none');
  const [cameraOrientationState, setCameraOrientationState] = useState(() => loadCameraOrientationState());
  const [softcopy, setSoftcopy] = useState({ status: 'idle', qrUrl: null });
  const [sessionVideo, setSessionVideo] = useState(null);
  // Rehydrate any in-progress shots from localStorage on first render
  const [shots, setShots] = useState(() => loadShots());
  const [arrangedShotIndexes, setArrangedShotIndexes] = useState([]);
  const [retakeQueue, setRetakeQueue] = useState([]);
  const [hasUsedRetakeChance, setHasUsedRetakeChance] = useState(false);
  const [reviewNoticeKey, setReviewNoticeKey] = useState(0);
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
  const arrangedShots = useMemo(() => {
    if (IS_DEV) {
      console.log('[PHOTO AUDIT App] shots before arrange mapping', {
        shotsLength: shots?.length,
        arrangedShotIndexes,
        shots: shots?.map((shot, index) => describeShotForAudit(shot, index)),
      });
      console.log('[DATA URL AUDIT App first shot]', inspectDataUrl(shots?.[0]));
    }
    const nextArrangedShots = arrangedShotIndexes
      .map((index) => {
        if (!shots[index]) {
          console.warn('[PHOTO AUDIT App] invalid arranged shot index', {
            index,
            shotsLength: shots.length,
          });
        }
        return shots[index];
      })
      .filter(Boolean);
    if (IS_DEV) {
      console.log('[PHOTO AUDIT App] arrangedShots', {
        arrangedShotsLength: nextArrangedShots?.length,
        arrangedShots: nextArrangedShots?.map((shot, index) => describeShotForAudit(shot, index)),
      });
      console.log('[APP KEYCHAIN/F Final arranged shots audit]', {
        shotsLength: shots?.length || 0,
        arrangedShotIndexes,
        arrangedShotsLength: nextArrangedShots?.length || 0,
        arrangedShots: nextArrangedShots?.map((shot, index) => {
          const src = getShotImageSource(shot);
          return {
            index,
            rawType: typeof shot,
            rawPrefix: typeof shot === 'string' ? shot.slice(0, 120) : null,
            rawKeys: shot && typeof shot === 'object' ? Object.keys(shot) : null,
            hasSource: Boolean(src),
            prefix: src ? src.slice(0, 120) : null,
            isDataUrl: src?.startsWith('data:image/'),
            length: src?.length,
          };
        }),
      });
      console.log('[DATA URL AUDIT App first arranged]', inspectDataUrl(nextArrangedShots?.[0]));
    }
    return nextArrangedShots;
  }, [arrangedShotIndexes, shots]);
  const cameraOrientation = normalizeCameraOrientation(cameraOrientationState.cameraOrientation);
  const cameraOrientationLocked = cameraOrientationState.cameraOrientationLocked === true;
  const softcopySettings = useMemo(
    () => resolveSoftcopySettings(settings.softcopySettings),
    [settings.softcopySettings],
  );
  const arrangedSessionVideo = useMemo(() => (
    sessionVideo
      ? {
          ...sessionVideo,
          cameraOrientation: normalizeCameraOrientation(sessionVideo.cameraOrientation || cameraOrientation),
          shotVideoClips: arrangedShotIndexes
            .map((sourceShotIndex, arrangedIndex) => {
              const clip = sessionVideo.shotVideoClips?.[sourceShotIndex];
              return clip ? { ...clip, shotIndex: arrangedIndex } : null;
            })
            .filter(Boolean),
        }
      : null
  ), [arrangedShotIndexes, cameraOrientation, sessionVideo]);
  const selectedFilterCss = useMemo(
    () => FILTERS.find(f => f.id === selectedFilter)?.css || '',
    [selectedFilter],
  );
  const beautificationSettings = useMemo(
    () => normalizeBeautificationSettings(settings.beautificationSettings),
    [settings.beautificationSettings],
  );
  const beautificationPreviewCss = useMemo(
    () => getBeautificationFilterCss(beautificationSettings),
    [beautificationSettings],
  );
  const handleSelectFilter = useCallback((filterId) => {
    const nextFilter = FILTERS.some(filter => filter.id === filterId) ? filterId : 'none';
    setSelectedFilter(nextFilter);
    if (IS_DEV) console.log('[filter] selected on camera screen', nextFilter);
  }, []);
  const resetCameraOrientation = useCallback(() => {
    clearCameraOrientationState();
    setCameraOrientationState({
      cameraOrientation: DEFAULT_CAMERA_ORIENTATION,
      cameraOrientationLocked: false,
    });
  }, []);
  const handleCameraOrientationChange = useCallback((nextOrientation) => {
    setCameraOrientationState((current) => {
      if (current.cameraOrientationLocked) return current;
      const normalizedOrientation = normalizeCameraOrientation(nextOrientation);
      return current.cameraOrientation === normalizedOrientation
        ? current
        : { ...current, cameraOrientation: normalizedOrientation };
    });
  }, []);
  const handleCameraOrientationLock = useCallback(() => {
    setCameraOrientationState((current) => (
      current.cameraOrientationLocked
        ? current
        : {
            cameraOrientation: normalizeCameraOrientation(current.cameraOrientation),
            cameraOrientationLocked: true,
          }
    ));
  }, []);

  useEffect(() => {
    saveCameraOrientationState({
      cameraOrientation,
      cameraOrientationLocked,
    });
  }, [cameraOrientation, cameraOrientationLocked]);

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

  useEffect(() => {
    if (settings.printCopiesEnabled === true) return;
    queueMicrotask(() => setCopies(DEFAULT_PRINT_COPIES));
  }, [settings.printCopiesEnabled]);

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
        setRetakeQueue([]);
        setHasUsedRetakeChance(false);
        setReviewNoticeKey(0);
        resetCameraOrientation();
        clearShots();
        clearSessionImageCache();
      });
    }
  }, [enabledLayouts, resetCameraOrientation, selectedLayout]);

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
    setRetakeQueue([]);
    setHasUsedRetakeChance(false);
    setReviewNoticeKey(0);
    resetCameraOrientation();
    // Picking a different layout invalidates any in-progress shots —
    // the new layout may need a different number of captures.
    setShots([]);
    setArrangedShotIndexes([]);
    clearShots();
    clearSessionImageCache();
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
    clearSessionImageCache();
    setSelectedLayout(null);
    setSelectedTmpl(null);
    setSelectedFilter('none');
    setSoftcopy({ status: 'idle', qrUrl: null });
    setSessionVideo(null);
    setRetakeQueue([]);
    setHasUsedRetakeChance(false);
    setReviewNoticeKey(0);
    setCopies(DEFAULT_PRINT_COPIES);
    setRetries(1);
    resetCameraOrientation();
    sessionStartRef.current = null;
    goTo('s-landing');
  }, [goTo, resetCameraOrientation]);

  useEffect(() => {
    if (!window.adminApi?.onSessionReset) return undefined;
    const unsub = window.adminApi.onSessionReset(() => {
      resetCurrentSession();
    });
    return () => unsub?.();
  }, [resetCurrentSession]);

  const handleEndReturn = () => {
    resetCurrentSession();
  };

  const handleFlash = () => {
    setFlashOn(true);
    setTimeout(() => setFlashOn(false), 120);
  };

  const handleCameraDone = (newShots, videoResult = null) => {
    if (retakeQueue.length > 0) {
      if (newShots) {
        for (const replacementIndex of retakeQueue) {
          console.log('[retake] replacement complete', {
            photoIndex: replacementIndex,
            totalPhotos: newShots.length,
          });
        }
      }
      if (newShots) setShots(newShots);

      if (videoResult?.shotVideoClips?.length) {
        setSessionVideo((current) => {
          const nextClips = [...(current?.shotVideoClips || [])];
          for (const clip of videoResult.shotVideoClips) {
            if (retakeQueue.includes(clip?.shotIndex)) {
              nextClips[clip.shotIndex] = clip;
            }
          }
          return {
            ...(current || {}),
            cameraOrientation: normalizeCameraOrientation(current?.cameraOrientation || videoResult?.cameraOrientation || cameraOrientation),
            shotVideoClips: nextClips,
          };
        });
      }

      if (IS_DEV) console.log('[retake-flow] sequence complete; returning to review');
      setRetakeQueue([]);
      setReviewNoticeKey((key) => key + 1);
      goTo('s-review');
      return;
    }

    if (newShots) setShots(newShots);
    setSessionVideo(videoResult
      ? {
          ...videoResult,
          cameraOrientation: normalizeCameraOrientation(videoResult.cameraOrientation || cameraOrientation),
        }
      : null);
    setArrangedShotIndexes([]);
    setReviewNoticeKey(0);
    goTo('s-review');
  };

  const handleRetakeShots = (shotIndexes = []) => {
    if (hasUsedRetakeChance) {
      console.warn('[retake] blocked because retake chance already used');
      return;
    }
    const nextQueue = Array.from(new Set(shotIndexes))
      .filter((shotIndex) => Number.isInteger(shotIndex) && shotIndex >= 0 && shotIndex < shots.length && shots[shotIndex])
      .sort((a, b) => a - b);
    if (nextQueue.length === 0) return;
    if (IS_DEV) console.log('[retake-flow] sequence started', {
      retakeQueue: nextQueue,
      layoutId: layout?.id || null,
    });
    setHasUsedRetakeChance(true);
    setRetakeQueue(nextQueue);
    setReviewNoticeKey(0);
    setSoftcopy({ status: 'idle', qrUrl: null });
    goTo('s-camera');
  };

  const handleCameraBack = () => {
    if (retakeQueue.length > 0) {
      setRetakeQueue([]);
      goTo('s-review');
      return;
    }
    goTo('s-policy');
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
          selectedFilter={selectedFilter}
          selectedFilterCss={selectedFilterCss}
          onSelectFilter={handleSelectFilter}
          beautificationSettings={beautificationSettings}
          beautificationPreviewCss={beautificationPreviewCss}
          cameraOrientation={cameraOrientation}
          cameraOrientationLocked={cameraOrientationLocked}
          onCameraOrientationChange={handleCameraOrientationChange}
          onCameraOrientationLock={handleCameraOrientationLock}
          recordVideo={softcopySettings.videoEnabled}
          retakeQueue={retakeQueue}
          onFlash={handleFlash}
          onDone={handleCameraDone}
          onBack={handleCameraBack}
        />

        <ReviewPhotosScreen
          active={curScreen === 's-review'}
          layout={layout}
          shots={shots}
          selectedFilterCss={selectedFilterCss}
          retakeCompletedKey={reviewNoticeKey}
          hasUsedRetakeChance={hasUsedRetakeChance}
          onRetakeShots={handleRetakeShots}
          onContinue={() => {
            setReviewNoticeKey(0);
            goTo('s-arrange');
          }}
        />

        <ArrangeScreen
          active={curScreen === 's-arrange'}
          layout={layout}
          shots={shots}
          arrangedShotIndexes={arrangedShotIndexes}
          selectedFilterCss={selectedFilterCss}
          hasUsedRetakeChance={hasUsedRetakeChance}
          onChangeArrangement={setArrangedShotIndexes}
          onNext={() => goTo('s-design')}
        />

        <SelectionScreen
          active={curScreen === 's-design'}
          layout={layout}
          shots={arrangedShots}
          templates={templates}
          settings={settings}
          selectedFilterCss={selectedFilterCss}
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
          selectedFilter={selectedFilter}
          selectedFilterCss={selectedFilterCss}
          shots={arrangedShots}
          arrangedShotIndexes={arrangedShotIndexes}
          cameraOrientation={cameraOrientation}
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
