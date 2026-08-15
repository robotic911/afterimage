import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { QRCodeCanvas } from 'qrcode.react';
import './PrintScreen.css';
import logoBlack from '../../assets/ai-logo-black.png';
import typoBlack from '../../assets/ai-typo-black.png';
import { buildFinalPrintCanvas, PRINT_JPEG_QUALITY } from '../../lib/printImage';
import { generateKeychain4x6Png } from '../../lib/keychainGenerator';
import {
  describeShotForAudit,
  getShotImageSource,
  inspectDataUrl,
  testImageLoad,
} from '../../lib/shotImageSource';
import { versionTemplateAssetSrc } from '../../lib/templateAssetUrl';
import { resolveTemplateRenderAssets } from '../../lib/templateRenderAssets';
import { DEFAULT_PRINTER_PROFILE_ID, DEFAULT_SAFE_MARGIN_OVERRIDE } from '../../constants/printers';
import {
  createSoftcopySessionToken,
  uploadSoftcopyAssets,
} from '../../lib/softcopyUpload';
import { DEFAULT_SOFTCOPY_SETTINGS, resolveSoftcopySettings } from '../../constants/softcopySettings';
import {
  clampPrintCopies,
  DEFAULT_PRINT_COPIES,
  MAX_PRINT_COPIES,
  MIN_PRINT_COPIES,
} from '../../constants/printSettings';
import {
  DEFAULT_CAMERA_ORIENTATION,
  normalizeCameraOrientation,
} from '../../constants/cameraSettings';
import {
  MOTION_MEDIA_TASK_YIELD_MS,
  MOTION_PREVIEW_DELAY_MS,
} from '../../constants/performanceSettings';

const PRICE_PER_COPY = 99; // PHP
const FINAL_PRINT_STATUSES = new Set(['completed', 'failed', 'cancelled', 'partial']);
const IS_DEV = import.meta.env.DEV;
const RUNTIME_PLATFORM = window.printApi?.platform || 'unknown';
const CAN_OPEN_PRINT_CENTER = window.printApi?.canOpenPrintCenter === true;
const SHOW_DIAGNOSTIC_UI = false;
const SHOW_KEYCHAIN_DEBUG_UI = false;
const ENABLE_KEYCHAIN_AUTO_SAVE = false;
const KEYCHAIN_AUTO_SAVE_IN_FLIGHT_KEYS = new Set();
const KEYCHAIN_AUTO_SAVE_SAVED_KEYS = new Set();
const KEYCHAIN_AUTO_SAVE_ATTEMPTED_KEYS = new Set();
const LOCAL_SOFTCOPY_SAVE_IN_FLIGHT_KEYS = new Map();
const LOCAL_SOFTCOPY_SAVE_SAVED_KEYS = new Map();

function normalizePrintApiResult(result, fallbackCopies) {
  const copiesRequested = clampPrintCopies(result?.copiesRequested ?? result?.requestedCopies ?? fallbackCopies);
  const status = FINAL_PRINT_STATUSES.has(result?.status)
    ? result.status
    : (result?.success || result?.ok ? 'completed' : 'failed');
  const fallbackPrinted = status === 'completed' ? copiesRequested : 0;
  const copiesPrinted = Math.max(
    0,
    Math.min(copiesRequested, Math.floor(Number(result?.copiesPrinted ?? result?.completedCopies ?? fallbackPrinted) || 0)),
  );
  return {
    ok: status === 'completed',
    status,
    copiesRequested,
    copiesPrinted,
    error: result?.error || result?.failureReason || null,
    jobId: result?.jobId || null,
  };
}

function getPrintStatusMessage(status, copiesPrinted, copiesRequested, error = null) {
  if (status === 'cancelled') return 'No copies were sent. You can retry printing or end this session.';
  if (status === 'partial') return `${copiesPrinted} of ${copiesRequested} ${copiesRequested === 1 ? 'copy was' : 'copies were'} printed. You can retry printing or end this session.`;
  if (status === 'failed') return error || 'Print failed. Please check the printer and try again.';
  return null;
}

function getSoftcopyErrorMessage(error = '') {
  const message = String(error || '').trim();
  if (/no softcopy media enabled/i.test(message)) {
    return 'Softcopy upload failed because no enabled media was available.';
  }
  if (/cannot be retried/i.test(message)) {
    return 'Upload cannot be retried for this session. Please end session.';
  }
  if (message) {
    return 'We could not prepare the QR code. Check the connection or ask the attendant, then try again.';
  }
  return 'We could not prepare the QR code. Check the connection or ask the attendant, then try again.';
}

function createEmptySoftcopyPayload() {
  return {
    sessionToken: null,
    cameraOrientation: DEFAULT_CAMERA_ORIENTATION,
    photoDataUrl: null,
    gifBlob: null,
    videoBlob: null,
    videoMimeType: '',
    videoExtension: '',
    enabled: {
      photo: false,
      gif: false,
      video: false,
    },
    warnings: [],
    canUpload: false,
    localPhotoDataUrl: null,
    localSave: null,
    keychain4x6: null,
    keychain4x6Generated: false,
    keychain4x6Error: null,
  };
}

function timeStart(label) {
  if (IS_DEV) console.time(label);
}

function timeEnd(label) {
  if (IS_DEV) console.timeEnd(label);
}

function makeSoftcopyCacheKey({ layout, template, shots, selectedFilterCss, softcopySettings, sessionVideo, cameraOrientation }) {
  return JSON.stringify({
    layoutId: layout?.id || null,
    templateId: template?.id || null,
    templateUpdatedAt: template?.updatedAt || template?.createdAt || null,
    selectedFilterCss,
    cameraOrientation: normalizeCameraOrientation(cameraOrientation),
    shots: (shots || []).map((shot) => {
      const source = getShotImageSource(shot);
      return source ? `${source.length}:${source.slice(0, 96)}` : null;
    }),
    videoClips: (sessionVideo?.shotVideoClips || []).map((clip) => ({
      shotIndex: clip?.shotIndex ?? null,
      size: clip?.blob?.size || 0,
      type: clip?.mimeType || clip?.blob?.type || '',
      durationMs: clip?.durationMs || 0,
    })),
    enabled: {
      qr: softcopySettings.qrEnabled !== false,
      photo: softcopySettings.photoEnabled !== false,
      gif: softcopySettings.gifEnabled !== false,
      video: softcopySettings.videoEnabled !== false,
    },
  });
}

function makeFinalPrintCacheKey({ layout, template, shots, selectedFilterCss, settings, cameraOrientation }) {
  return JSON.stringify({
    layoutId: layout?.id || null,
    templateId: template?.id || null,
    templateUpdatedAt: template?.updatedAt || template?.createdAt || null,
    selectedFilterCss,
    cameraOrientation: normalizeCameraOrientation(cameraOrientation),
    printerProfileId: settings?.printerProfileId || null,
    safeMarginOverride: settings?.safeMarginOverride || null,
    shots: (shots || []).map((shot) => {
      const source = getShotImageSource(shot);
      return source ? `${source.length}:${source.slice(0, 96)}` : null;
    }),
  });
}

function makeKeychainTimestamp(date = new Date()) {
  const pad = number => String(number).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '-',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('');
}

function sanitizeKeychainSessionSegment(sessionId = '') {
  return String(sessionId || 'session')
    .replace(/[^A-Za-z0-9_-]+/g, '')
    .slice(0, 48) || 'session';
}

function formatAutoKeychainSessionSegment(sessionId = '') {
  const cleanSessionId = sanitizeKeychainSessionSegment(sessionId || 'unknown');
  return cleanSessionId.startsWith('session-')
    ? cleanSessionId
    : `session-${cleanSessionId}`;
}

function makeStep4KeychainFilename(sessionId = '') {
  const stamp = makeKeychainTimestamp();
  const cleanSessionId = sanitizeKeychainSessionSegment(sessionId);

  return `Afterimage-TEST-keychain-4x6-${stamp}-${cleanSessionId}.png`;
}

function makeAutoKeychainFilename(sessionId = '', localFilePrefix = '') {
  const localPrefixMatch = String(localFilePrefix || '').match(/^Afterimage-(\d{8}-\d{6}-[A-Za-z0-9_-]{1,16}(?:-\d+)?)$/);
  if (localPrefixMatch) {
    return `Afterimage-keychain-4x6-${localPrefixMatch[1]}.png`;
  }

  const stamp = makeKeychainTimestamp();
  const sessionSegment = formatAutoKeychainSessionSegment(sessionId);

  return `Afterimage-keychain-4x6-${stamp}-${sessionSegment}.png`;
}

function normalizeDownloadsPngSaveResult(result, filename) {
  const targetPath = result?.targetPath || result?.path || null;
  return {
    ...result,
    filename: result?.filename || filename,
    targetPath,
    path: targetPath,
  };
}

function createAutoKeychainSessionId(sessionStartValue, fallbackSessionId = '') {
  if (sessionStartValue) {
    return formatAutoKeychainSessionSegment(`session-${sessionStartValue}`);
  }
  return formatAutoKeychainSessionSegment(fallbackSessionId);
}

function hashKeychainSessionInput(value = '') {
  const input = String(value || '');
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function createKeychainSaveKey({ sessionStartValue = null, sessionToken = '', cacheKey = '' } = {}) {
  if (sessionStartValue) {
    return createAutoKeychainSessionId(sessionStartValue);
  }
  if (cacheKey) {
    return `keychain-cache-${hashKeychainSessionInput(cacheKey)}`;
  }
  return createAutoKeychainSessionId(null, sessionToken);
}

function createLocalSoftcopySaveKey({ sessionStartValue = null, sessionToken = '', cacheKey = '' } = {}) {
  if (sessionStartValue) {
    return `local-softcopy-${sessionStartValue}`;
  }
  if (sessionToken) {
    return `local-softcopy-${sessionToken}`;
  }
  if (cacheKey) {
    return `local-softcopy-cache-${hashKeychainSessionInput(cacheKey)}`;
  }
  return `local-softcopy-${Date.now()}`;
}

function isKeychainSaveSuccessful(result) {
  return result?.ok === true
    && result?.exists === true
    && Number(result?.sizeBytes || 0) > 0;
}

function testImageDecode(src, label) {
  return new Promise((resolve) => {
    if (!src || typeof src !== 'string') {
      console.error(`[${label}] missing src`);
      resolve(false);
      return;
    }

    const img = new Image();

    img.onload = () => {
      console.log(`[${label}] decode OK`, {
        width: img.naturalWidth || img.width,
        height: img.naturalHeight || img.height,
        length: src.length,
        prefix: src.slice(0, 80),
      });
      resolve(true);
    };

    img.onerror = () => {
      console.error(`[${label}] decode FAILED`, {
        length: src.length,
        prefix: src.slice(0, 120),
        end: src.slice(-120),
      });
      resolve(false);
    };

    img.src = src;
  });
}

function canvasToBlobAsync(canvas, mimeType, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error(`Could not encode ${mimeType || 'image'} blob.`));
    }, mimeType, quality);
  });
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result);
        return;
      }
      reject(new Error('Blob could not be converted to a data URL.'));
    };
    reader.onerror = () => reject(new Error('Blob data URL conversion failed.'));
    reader.readAsDataURL(blob);
  });
}

function delay(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function scheduleIdleWork(callback, timeout = 1500) {
  if (typeof window.requestIdleCallback === 'function') {
    const handle = window.requestIdleCallback(callback, { timeout });
    return () => window.cancelIdleCallback?.(handle);
  }
  const handle = window.setTimeout(callback, 0);
  return () => window.clearTimeout(handle);
}

export default function PrintScreen({
  active,
  layout,
  templates = [],
  settings = {
    mode: 'daily',
    activeEventId: null,
    printEnabled: true,
    printCopiesEnabled: false,
    testModeEnabled: false,
    printerProfileId: DEFAULT_PRINTER_PROFILE_ID,
    safeMarginOverride: DEFAULT_SAFE_MARGIN_OVERRIDE,
    softcopySettings: DEFAULT_SOFTCOPY_SETTINGS,
  },
  events = [],
  selectedTmpl,
  selectedFilter = 'none',
  selectedFilterCss = '',
  shots,
  arrangedShotIndexes = [],
  cameraOrientation = DEFAULT_CAMERA_ORIENTATION,
  sessionVideo = null,
  copies = DEFAULT_PRINT_COPIES,
  retries,
  sessionStartRef,
  softcopy = { status: 'idle', qrUrl: null },
  onSoftcopyChange,
  onChangeCopies,
  onPrint,
  onBack,
}) {
  const template = useMemo(() => (
    selectedTmpl
      ? templates.find(t => t.id === selectedTmpl) || null
      : null
  ), [selectedTmpl, templates]);
  const templateAssets = useMemo(
    () => resolveTemplateRenderAssets(template),
    [template],
  );
  const templatePreviewBackgroundSrc = templateAssets.backgroundSrc
    ? versionTemplateAssetSrc(templateAssets.backgroundSrc, template)
    : null;
  const templateOverlaySrc = templateAssets.overlaySrc
    ? versionTemplateAssetSrc(templateAssets.overlaySrc, template)
    : null;
  const activeEvent = useMemo(
    () => events.find((event) => event.id === settings.activeEventId) || null,
    [events, settings.activeEventId],
  );
  const printEnabled = settings.printEnabled !== false;
  const printCopiesEnabled = settings.printCopiesEnabled === true;
  const testModeEnabled = settings.testModeEnabled === true;
  const softcopySettings = useMemo(
    () => resolveSoftcopySettings(settings.softcopySettings),
    [settings.softcopySettings],
  );
  const normalizedCameraOrientation = normalizeCameraOrientation(cameraOrientation);
  const finalPrintCacheKey = useMemo(() => makeFinalPrintCacheKey({
    layout,
    template,
    shots,
    selectedFilterCss,
    settings,
    cameraOrientation: normalizedCameraOrientation,
  }), [layout, normalizedCameraOrientation, selectedFilterCss, settings, shots, template]);
  const requestedCopies = clampPrintCopies(copies);
  const selectedCopies = printCopiesEnabled ? requestedCopies : DEFAULT_PRINT_COPIES;
  const normalizedShotSources = useMemo(
    () => (shots || []).map(getShotImageSource),
    [shots],
  );
  const photoDebug = useMemo(() => {
    const normalizedSources = normalizedShotSources.filter(Boolean);
    const firstSource = normalizedSources[0] || null;
    const firstSourceAudit = inspectDataUrl(firstSource);
    return {
      shotsLength: shots?.length || 0,
      normalizedSourceCount: normalizedSources.length,
      firstSourcePrefix: firstSource ? firstSource.slice(0, 100) : null,
      firstSourceIsDataUrl: Boolean(firstSource?.startsWith('data:image/')),
      firstSourceAudit,
      firstSource,
      layoutId: layout?.id || null,
      arrangedShotIndexes,
      missingSourceCount: (shots || []).length - normalizedSources.length,
    };
  }, [arrangedShotIndexes, layout?.id, normalizedShotSources, shots]);
  const [printing, setPrinting] = useState(false);
  const [sessionLocked, setSessionLocked] = useState(false);
  const [printCompleted, setPrintCompleted] = useState(false);
  const [finishReady, setFinishReady] = useState(false);
  const [printProgress, setPrintProgress] = useState(null);
  const [printError, setPrintError] = useState(null);
  const [printTerminalStatus, setPrintTerminalStatus] = useState(null);
  const [softcopyWarnings, setSoftcopyWarnings] = useState([]);
  const [uploadRetrying, setUploadRetrying] = useState(false);
  const [softcopyPreviewAssets, setSoftcopyPreviewAssets] = useState({
    cacheKey: null,
    status: 'idle',
    gifBlob: null,
    videoBlob: null,
    gifError: null,
    videoError: null,
    warnings: [],
  });
  const [gifPreviewUrl, setGifPreviewUrl] = useState(null);
  const [videoPreviewUrl, setVideoPreviewUrl] = useState(null);
  const [gifPreviewSourceType, setGifPreviewSourceType] = useState('none');
  const [videoPreviewSourceType, setVideoPreviewSourceType] = useState('none');
  const [finalPreviewPngUrl, setFinalPreviewPngUrl] = useState(null);
  const [finalPreviewPngStatus, setFinalPreviewPngStatus] = useState('idle');
  const [step4KeychainSaving, setStep4KeychainSaving] = useState(false);
  const [step4KeychainResult, setStep4KeychainResult] = useState(null);
  const finishReadyTimerRef = useRef(null);
  const sessionLockedRef = useRef(false);
  const printInFlightRef = useRef(false);
  const uploadInFlightRef = useRef(false);
  const printArtifactRef = useRef(null);
  const finalPrintArtifactRef = useRef(null);
  const finalPrintArtifactPromiseRef = useRef(null);
  const softcopyArtifactRef = useRef(null);
  const softcopyLogRef = useRef(null);
  const softcopyMotionCacheRef = useRef(null);
  const softcopyMotionPromiseRef = useRef(null);
  const softcopyMotionGenerationRef = useRef(0);
  const keychainSaveInFlightRef = useRef(KEYCHAIN_AUTO_SAVE_IN_FLIGHT_KEYS);
  const keychainSavedRef = useRef(KEYCHAIN_AUTO_SAVE_SAVED_KEYS);
  const keychainAttemptedRef = useRef(KEYCHAIN_AUTO_SAVE_ATTEMPTED_KEYS);
  const localSoftcopySaveInFlightRef = useRef(LOCAL_SOFTCOPY_SAVE_IN_FLIGHT_KEYS);
  const localSoftcopySavedRef = useRef(LOCAL_SOFTCOPY_SAVE_SAVED_KEYS);
  const activeRef = useRef(active);

  useEffect(() => {
    sessionLockedRef.current = sessionLocked;
  }, [sessionLocked]);

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  const setSoftcopyState = useCallback((nextState) => {
    if (!activeRef.current) return;
    onSoftcopyChange?.(nextState);
  }, [onSoftcopyChange]);

  const releaseFinalPrintArtifact = useCallback((artifact = finalPrintArtifactRef.current) => {
    if (!artifact) return;
    if (artifact.previewUrl) URL.revokeObjectURL(artifact.previewUrl);
    if (artifact.canvas) {
      artifact.canvas.width = 0;
      artifact.canvas.height = 0;
    }
    if (finalPrintArtifactRef.current === artifact) {
      finalPrintArtifactRef.current = null;
    }
  }, []);

  const getFinalPrintArtifact = useCallback(async () => {
    const cached = finalPrintArtifactRef.current;
    if (cached?.cacheKey === finalPrintCacheKey) {
      return cached;
    }
    if (finalPrintArtifactPromiseRef.current?.cacheKey === finalPrintCacheKey) {
      return finalPrintArtifactPromiseRef.current.promise;
    }

    const promise = (async () => {
      releaseFinalPrintArtifact();
      const canvas = await buildFinalPrintCanvas(
        layout,
        template,
        shots,
        selectedFilterCss,
        settings,
        { cameraOrientation: normalizedCameraOrientation },
      );
      const pngBlob = await canvasToBlobAsync(canvas, 'image/png', 1);
      const previewUrl = URL.createObjectURL(pngBlob);
      const artifact = {
        cacheKey: finalPrintCacheKey,
        canvas,
        pngBlob,
        previewUrl,
        pngDataUrl: null,
        jpegDataUrl: null,
      };
      finalPrintArtifactRef.current = artifact;
      return artifact;
    })();

    finalPrintArtifactPromiseRef.current = {
      cacheKey: finalPrintCacheKey,
      promise,
    };
    try {
      return await promise;
    } finally {
      if (finalPrintArtifactPromiseRef.current?.promise === promise) {
        finalPrintArtifactPromiseRef.current = null;
      }
    }
  }, [
    finalPrintCacheKey,
    layout,
    normalizedCameraOrientation,
    releaseFinalPrintArtifact,
    selectedFilterCss,
    settings,
    shots,
    template,
  ]);

  useEffect(() => {
    if (!active) {
      if (sessionLockedRef.current) {
        console.log('[print] session ended, reset lock');
      }
      // The print screen owns its transient state; when the screen is
      // no longer active we intentionally reset it for the next session.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPrintCompleted(false);
      setPrinting(false);
      setSessionLocked(false);
      setFinishReady(false);
      setPrintProgress(null);
      setPrintError(null);
      setPrintTerminalStatus(null);
      printInFlightRef.current = false;
      uploadInFlightRef.current = false;
      printArtifactRef.current = null;
      finalPrintArtifactPromiseRef.current = null;
      releaseFinalPrintArtifact();
      softcopyArtifactRef.current = null;
      softcopyLogRef.current = null;
      softcopyMotionGenerationRef.current += 1;
      softcopyMotionCacheRef.current = null;
      softcopyMotionPromiseRef.current = null;
      setSoftcopyWarnings([]);
      setUploadRetrying(false);
      setStep4KeychainSaving(false);
      setStep4KeychainResult(null);
      if (finishReadyTimerRef.current) {
        clearTimeout(finishReadyTimerRef.current);
        finishReadyTimerRef.current = null;
      }
    }
  }, [active, releaseFinalPrintArtifact]);

  useEffect(() => {
    return () => {
      if (finishReadyTimerRef.current) {
        clearTimeout(finishReadyTimerRef.current);
      }
      releaseFinalPrintArtifact();
    };
  }, [releaseFinalPrintArtifact]);

  useEffect(() => {
    if (!active || !window.printApi?.onPrintProgress) return undefined;
    return window.printApi.onPrintProgress((progress) => {
      const current = clampPrintCopies(progress?.current);
      const total = clampPrintCopies(progress?.total);
      setPrintProgress({ current, total });
    });
  }, [active]);

  useEffect(() => {
    if (!active || !IS_DEV) return undefined;
    let ended = false;
    console.time('[receipt] render preview');
    const frame = requestAnimationFrame(() => {
      ended = true;
      console.timeEnd('[receipt] render preview');
    });
    return () => {
      cancelAnimationFrame(frame);
      if (!ended) console.timeEnd('[receipt] render preview');
    };
  }, [active, layout, template, shots, selectedFilterCss]);

  useEffect(() => {
    if (!active || !IS_DEV) return;
    console.log('[PHOTO AUDIT PrintScreen] received shots', {
      shotsLength: shots?.length,
      shots: shots?.map((shot, index) => describeShotForAudit(shot, index)),
    });
    console.log('[DATA URL AUDIT PrintScreen first]', inspectDataUrl(getShotImageSource(shots?.[0])));
  }, [active, shots]);

  useEffect(() => {
    if (!active || !photoDebug.firstSource) return;
    console.log('[DATA URL AUDIT PrintScreen first normalized]', inspectDataUrl(photoDebug.firstSource));
    testImageLoad(photoDebug.firstSource, 'FINAL PREVIEW FIRST SOURCE');
  }, [active, photoDebug.firstSource]);

  useEffect(() => {
    if (!active) {
      const timer = window.setTimeout(() => {
        setFinalPreviewPngUrl(null);
        setFinalPreviewPngStatus('idle');
      }, 0);
      return () => window.clearTimeout(timer);
    }

    let cancelled = false;
    const run = async () => {
      if (!layout || !template || !shots?.length) {
        setFinalPreviewPngUrl(null);
        setFinalPreviewPngStatus('idle');
        return;
      }

      setFinalPreviewPngStatus('generating');
      try {
        const artifact = await getFinalPrintArtifact();
        if (cancelled) return;
        if (!artifact?.pngBlob || !artifact.previewUrl) {
          throw new Error('Final preview PNG blob could not be created.');
        }
        setFinalPreviewPngUrl(artifact.previewUrl);
        setFinalPreviewPngStatus('ready');
        console.log('[FINAL PNG PREVIEW GENERATED]', {
          layoutId: layout?.id || null,
          templateId: template?.id || null,
          shotCount: shots?.length || 0,
          blobSize: artifact.pngBlob.size,
          objectUrlLength: artifact.previewUrl.length,
        });
      } catch (error) {
        if (cancelled) return;
        console.error('[FINAL PNG PREVIEW FAILED]', {
          layoutId: layout?.id || null,
          templateId: template?.id || null,
          error: error?.message || String(error),
        });
        setFinalPreviewPngUrl(null);
        setFinalPreviewPngStatus('error');
      }
    };

    run();

    return () => {
      cancelled = true;
    };
  }, [
    active,
    getFinalPrintArtifact,
    layout,
    selectedFilterCss,
    settings,
    shots,
    template,
  ]);

  useEffect(() => {
    if (!active || !IS_DEV) return undefined;
    const timer = window.setTimeout(() => {
      const frame = document.querySelector('#print-frame-box .final-media-content--photo .layout-preview-frame');
      const content = document.querySelector('#print-frame-box .final-media-content--photo');
      if (!frame || !content) return;
      console.log('[PNG PREVIEW DIMENSIONS]', {
        wrapperWidth: content.clientWidth,
        wrapperHeight: content.clientHeight,
        frameWidth: frame.clientWidth,
        frameHeight: frame.clientHeight,
        frameAspect: frame.clientWidth && frame.clientHeight ? frame.clientWidth / frame.clientHeight : null,
      });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [active, photoDebug.firstSource, layout?.id]);

  const handleChangeBackground = () => {
    if (sessionLocked || printing || printCompleted) {
      console.warn('[print] blocked background change after print started');
      return;
    }
    onBack?.();
  };

  const softcopyCacheKey = useMemo(() => makeSoftcopyCacheKey({
    layout,
    template,
    shots,
    selectedFilterCss,
    softcopySettings,
    sessionVideo,
    cameraOrientation: normalizedCameraOrientation,
  }), [layout, normalizedCameraOrientation, template, shots, selectedFilterCss, softcopySettings, sessionVideo]);

  const generateSoftcopyMotionMedia = useCallback(async ({ cacheKey = softcopyCacheKey } = {}) => {
    const cached = softcopyMotionCacheRef.current;
    if (cached?.cacheKey === cacheKey) {
      return cached;
    }
    if (softcopyMotionPromiseRef.current?.cacheKey === cacheKey) {
      return softcopyMotionPromiseRef.current.promise;
    }

    const generationId = softcopyMotionGenerationRef.current + 1;
    softcopyMotionGenerationRef.current = generationId;
    const promise = (async () => {
      const enabled = {
        gif: softcopySettings.gifEnabled !== false,
        video: softcopySettings.videoEnabled !== false,
      };
      const warnings = [];
      let gifBlob = null;
      let videoBlob = null;
      let videoMimeType = '';
      let videoExtension = '';

      if (!enabled.gif && !enabled.video) {
        return {
          cacheKey,
          status: 'disabled',
          cameraOrientation: normalizedCameraOrientation,
          gifBlob,
          videoBlob,
          videoMimeType,
          videoExtension,
          enabled,
          warnings,
        };
      }

      if (IS_DEV) {
        console.log('[softcopy preview] settings', {
          qrEnabled: softcopySettings.qrEnabled !== false,
          gifEnabled: enabled.gif,
          videoEnabled: enabled.video,
          cameraOrientation: normalizedCameraOrientation,
        });
      }

      if (enabled.gif) {
        try {
          const { generateSessionGif } = await import('../../lib/gifGenerator');
          const gif = await generateSessionGif(shots, {
            layoutId: layout?.id,
            width: layout?.camera?.width,
            height: layout?.camera?.height,
            photoFilter: selectedFilterCss,
            selectedFilter,
            cameraOrientation: normalizedCameraOrientation,
          });
          gifBlob = gif?.blob || null;
        } catch (error) {
          console.warn('[gif] generation failed', error);
          warnings.push('GIF could not be generated.');
        }
      }

      if (enabled.video) {
        if (enabled.gif) await delay(MOTION_MEDIA_TASK_YIELD_MS);
        try {
          const { composeSimultaneousSlotVideo } = await import('../../lib/sessionVideoRecorder');
          const finalVideo = await composeSimultaneousSlotVideo({
            layout,
            shotVideoClips: sessionVideo?.shotVideoClips || [],
            backgroundSrc: templatePreviewBackgroundSrc,
            templateSrc: templateOverlaySrc,
            photoFilter: selectedFilterCss,
            selectedFilter,
            cameraOrientation: normalizedCameraOrientation,
          });
          if (finalVideo?.blob) {
            videoBlob = finalVideo.blob;
            videoMimeType = finalVideo.mimeType || '';
            videoExtension = finalVideo.extension || '';
          } else {
            warnings.push('Video could not be generated.');
          }
        } catch (error) {
          console.warn('[video] generation failed', error);
          warnings.push('Video could not be generated.');
        }
      }

      if (IS_DEV) {
        console.log('[softcopy preview] media ready', {
          hasGifPreviewUrl: Boolean(gifBlob),
          hasVideoPreviewUrl: Boolean(videoBlob),
          gifSourceType: gifBlob ? 'blob' : 'none',
          videoSourceType: videoBlob ? 'blob' : 'none',
        });
        console.log('[mirror] gif/video/keychain', {
          cameraOrientation: normalizedCameraOrientation,
          sourceFramesAlreadyOriented: true,
          gifMirrorApplied: false,
          videoMirrorApplied: false,
          keychainMirrorApplied: false,
        });
      }

      const result = {
        cacheKey,
        status: 'ready',
        cameraOrientation: normalizedCameraOrientation,
        gifBlob,
        videoBlob,
        videoMimeType,
        videoExtension,
        enabled,
        warnings,
      };
      if (activeRef.current && softcopyMotionGenerationRef.current === generationId) {
        softcopyMotionCacheRef.current = result;
      }
      return result;
    })();

    softcopyMotionPromiseRef.current = { cacheKey, promise };
    try {
      return await promise;
    } finally {
      if (softcopyMotionPromiseRef.current?.promise === promise) {
        softcopyMotionPromiseRef.current = null;
      }
    }
  }, [
    layout,
    normalizedCameraOrientation,
    selectedFilter,
    selectedFilterCss,
    sessionVideo,
    shots,
    softcopyCacheKey,
    softcopySettings.gifEnabled,
    softcopySettings.qrEnabled,
    softcopySettings.videoEnabled,
    templateOverlaySrc,
    templatePreviewBackgroundSrc,
  ]);

  useEffect(() => {
    if (!active || (softcopySettings.gifEnabled === false && softcopySettings.videoEnabled === false)) {
      const timer = window.setTimeout(() => {
        setSoftcopyPreviewAssets({
          cacheKey: null,
          status: 'idle',
          gifBlob: null,
          videoBlob: null,
          gifError: null,
          videoError: null,
          warnings: [],
        });
      }, 0);
      return () => window.clearTimeout(timer);
    }
    if (!['ready', 'error'].includes(finalPreviewPngStatus)) {
      return undefined;
    }

    let cancelled = false;
    let cancelIdle = null;
    const primeTimer = window.setTimeout(() => {
      setSoftcopyPreviewAssets((current) => (
        current.cacheKey === softcopyCacheKey && current.status === 'ready'
          ? current
          : {
              cacheKey: softcopyCacheKey,
              status: 'generating',
              gifBlob: null,
              videoBlob: null,
              gifError: null,
              videoError: null,
              warnings: [],
            }
      ));
      cancelIdle = scheduleIdleWork(() => {
        generateSoftcopyMotionMedia({ cacheKey: softcopyCacheKey })
          .then((motionMedia) => {
            if (cancelled) return;
            setSoftcopyPreviewAssets({
              cacheKey: motionMedia.cacheKey || softcopyCacheKey,
              status: motionMedia.status || 'ready',
              gifBlob: motionMedia.gifBlob || null,
              videoBlob: motionMedia.videoBlob || null,
              gifError: motionMedia.gifBlob ? null : (softcopySettings.gifEnabled !== false ? 'GIF preview unavailable' : null),
              videoError: motionMedia.videoBlob ? null : (softcopySettings.videoEnabled !== false ? 'Video preview unavailable' : null),
              warnings: motionMedia.warnings || [],
            });
          })
          .catch((error) => {
            if (cancelled) return;
            console.error('[softcopy preview] failed', {
              type: 'media',
              error: error?.message || String(error),
            });
            setSoftcopyPreviewAssets({
              cacheKey: softcopyCacheKey,
              status: 'error',
              gifBlob: null,
              videoBlob: null,
              gifError: softcopySettings.gifEnabled !== false ? 'GIF preview unavailable' : null,
              videoError: softcopySettings.videoEnabled !== false ? 'Video preview unavailable' : null,
              warnings: [],
            });
          });
      });
    }, MOTION_PREVIEW_DELAY_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(primeTimer);
      cancelIdle?.();
    };
  }, [
    active,
    finalPreviewPngStatus,
    generateSoftcopyMotionMedia,
    softcopyCacheKey,
    softcopySettings.gifEnabled,
    softcopySettings.videoEnabled,
  ]);

  useEffect(() => {
    let gifUrl = null;
    let videoUrl = null;
    const gifBlob = softcopyPreviewAssets.gifBlob;
    const videoBlob = softcopyPreviewAssets.videoBlob;

    if (gifBlob) {
      gifUrl = URL.createObjectURL(gifBlob);
    }
    if (videoBlob) {
      videoUrl = URL.createObjectURL(videoBlob);
    }

    const timer = window.setTimeout(() => {
      setGifPreviewUrl(gifUrl);
      setVideoPreviewUrl(videoUrl);
      setGifPreviewSourceType(gifBlob ? 'object-url' : 'none');
      setVideoPreviewSourceType(videoBlob ? 'object-url' : 'none');
    }, 0);

    return () => {
      window.clearTimeout(timer);
      if (gifUrl) URL.revokeObjectURL(gifUrl);
      if (videoUrl) URL.revokeObjectURL(videoUrl);
    };
  }, [softcopyPreviewAssets]);

  const buildSoftcopyPayload = async (pngUrl, jpegUrl, cacheKey = softcopyCacheKey, pngBlob = null) => {
    const cachedPayload = softcopyArtifactRef.current;
    if (
      cachedPayload?.cacheKey === cacheKey
      && (cachedPayload.canUpload || cachedPayload.localSave?.ok || cachedPayload.keychain4x6Generated || cachedPayload.keychain4x6Error)
    ) {
      if (IS_DEV) console.log('[softcopy] generated media cache reused', { sessionToken: cachedPayload.sessionToken });
      return cachedPayload;
    }

    const enabled = {
      photo: softcopySettings.photoEnabled !== false,
      gif: softcopySettings.gifEnabled !== false,
      video: softcopySettings.videoEnabled !== false,
    };
    const warnings = [];
    const sessionToken = cachedPayload?.cacheKey === cacheKey && cachedPayload.sessionToken
      ? cachedPayload.sessionToken
      : createSoftcopySessionToken();
    if (IS_DEV) {
      console.log('[softcopy] media generation plan', {
        sessionId: sessionToken,
        qrEnabled: softcopySettings.qrEnabled !== false,
        photoEnabled: enabled.photo,
        gifEnabled: enabled.gif,
        videoEnabled: enabled.video,
        cameraOrientation: normalizedCameraOrientation,
      });
    }
    const photoDataUrl = enabled.photo ? jpegUrl : null;
    const localPhotoDataUrl = enabled.photo ? pngUrl : null;
    const localPhotoBlob = enabled.photo ? pngBlob : null;
    let gifBlob = null;
    let videoBlob = null;
    let videoMimeType = '';
    let videoExtension = '';
    const uploadedPaths = cachedPayload?.cacheKey === cacheKey
      ? {
          photoPath: cachedPayload.photoPath || cachedPayload.uploadedPaths?.photoPath || null,
          gifPath: cachedPayload.gifPath || cachedPayload.uploadedPaths?.gifPath || null,
          videoPath: cachedPayload.videoPath || cachedPayload.uploadedPaths?.videoPath || null,
        }
      : {};

    if (!Object.values(enabled).some(Boolean)) {
      return {
        sessionToken,
        cameraOrientation: normalizedCameraOrientation,
        photoDataUrl,
        localPhotoDataUrl,
        localPhotoBlob,
        gifBlob: null,
        videoBlob: null,
        videoMimeType: '',
        videoExtension: '',
        enabled,
        warnings,
        canUpload: false,
        cacheKey,
        uploadedPaths,
      };
    }

    timeStart('[softcopy] generate media');
    try {
      const motionMedia = await generateSoftcopyMotionMedia({ cacheKey });
      gifBlob = motionMedia.gifBlob || null;
      videoBlob = motionMedia.videoBlob || null;
      videoMimeType = motionMedia.videoMimeType || '';
      videoExtension = motionMedia.videoExtension || '';
      warnings.push(...(motionMedia.warnings || []));
    } finally {
      timeEnd('[softcopy] generate media');
    }

    return {
      sessionToken,
      cameraOrientation: normalizedCameraOrientation,
      photoDataUrl,
      localPhotoDataUrl,
      localPhotoBlob,
      gifBlob,
      videoBlob,
      videoMimeType,
      videoExtension,
      enabled,
      warnings,
      canUpload: Boolean(photoDataUrl || gifBlob || videoBlob),
      cacheKey,
      uploadedPaths,
    };
  };

  const getSavedFileNames = (savedFiles = []) => savedFiles
    .map(file => typeof file === 'string' ? file : file?.name)
    .filter(Boolean);

  const getSavedPhotoFile = (savedFiles = []) => savedFiles
    .find(file => {
      const name = typeof file === 'string' ? file : file?.name;
      const kind = typeof file === 'string' ? '' : file?.kind;
      return kind === 'photo' || String(name || '').endsWith('-photo.png');
    });

  const getSavedKeychainFile = (savedFiles = []) => savedFiles
    .find(file => {
      const name = typeof file === 'string' ? file : file?.name;
      const kind = typeof file === 'string' ? '' : file?.kind;
      return kind === 'keychain4x6' || String(name || '').includes('keychain-4x6');
    });

  const buildLocalMetadata = (payload, upload = {}) => {
    const savedPhotoFile = getSavedPhotoFile(payload.localSave?.savedFiles);
    const savedKeychainFile = getSavedKeychainFile(payload.localSave?.savedFiles);
    const photoFilename = savedPhotoFile?.name
      || payload.localSave?.savedFiles?.find?.((file) => String(file?.name || '').endsWith('-photo.png'))?.name
      || null;
    const finalPrintPath = savedPhotoFile?.path || null;
    const keychain4x6Filename = savedKeychainFile?.name
      || payload.keychain4x6Save?.filename
      || payload.keychain4x6?.filename
      || null;
    const keychain4x6SavedPath = savedKeychainFile?.path || payload.keychain4x6Save?.path || null;
    const localFiles = Array.from(new Set([
      ...getSavedFileNames(payload.localSave?.savedFiles),
      ...(keychain4x6Filename ? [keychain4x6Filename] : []),
    ]));
    const qrEnabled = softcopySettings.qrEnabled !== false;
    const qrUploadAttempted = qrEnabled && ['ready', 'error'].includes(upload.status);
    return {
      sessionId: payload.sessionToken,
      token: payload.sessionToken,
      createdAt: payload.createdAt,
      layoutId: layout?.id || null,
      templateId: template?.id || null,
      backgroundId: template?.id || null,
      selectedFilter: selectedFilter || 'none',
      cameraOrientation: normalizeCameraOrientation(payload.cameraOrientation || normalizedCameraOrientation),
      qrEnabled,
      qrUploadAttempted,
      qrUploadSucceeded: qrUploadAttempted ? upload.status === 'ready' : null,
      photoEnabled: payload.enabled?.photo === true,
      gifEnabled: payload.enabled?.gif === true,
      videoEnabled: payload.enabled?.video === true,
      finalPrintPath,
      finalPrintFilename: photoFilename,
      photoSaved: localFiles.some(name => name.endsWith('-photo.png')),
      gifSaved: localFiles.some(name => name.endsWith('-animation.gif')),
      videoSaved: localFiles.some(name => /-video\.(mp4|webm|mov)$/.test(name)),
      keychain4x6Generated: payload.keychain4x6Generated === true,
      keychain4x6Saved: payload.keychain4x6Save?.ok === true,
      keychain4x6Filename,
      keychain4x6SavedPath,
      keychain4x6Exists: payload.keychain4x6Save?.exists === true,
      keychain4x6SizeBytes: Number.isFinite(Number(payload.keychain4x6Save?.sizeBytes))
        ? Number(payload.keychain4x6Save.sizeBytes)
        : null,
      keychain4x6CanvasWidth: payload.keychain4x6?.width || null,
      keychain4x6CanvasHeight: payload.keychain4x6?.height || null,
      keychain4x6PlacementCount: payload.keychain4x6?.placements?.length || 0,
      keychain4x6LocalOnly: true,
      keychain4x6Uploaded: false,
      keychain4x6Error: payload.keychain4x6Error || null,
      localFiles,
      localFileErrors: payload.localSave?.fileErrors || [],
      qrUrl: upload.qrUrl || null,
      supabaseBucket: upload.bucket || null,
      supabaseCreatedAt: upload.createdAt || null,
      supabaseUploadedAt: upload.uploadedAt || null,
      supabaseExpiresAt: upload.expiresAt || null,
      uploadError: upload.status === 'error' ? (upload.error || 'Softcopy upload failed.') : null,
    };
  };

  const saveLocalSoftcopy = async (payload) => {
    if (payload.localSave?.ok) return payload.localSave;
    if (!window.softcopyApi?.saveSessionMedia) {
      return {
        ok: false,
        unavailable: true,
        error: 'Local softcopy saving is unavailable.',
      };
    }

    const sessionKey = createLocalSoftcopySaveKey({
      sessionStartValue: sessionStartRef?.current,
      sessionToken: payload.sessionToken,
      cacheKey: payload.cacheKey || softcopyCacheKey,
    });
    if (localSoftcopySavedRef.current.has(sessionKey)) {
      const savedResult = localSoftcopySavedRef.current.get(sessionKey);
      console.log('[LOCAL SAVE AUDIT] skipped duplicate local softcopy save', {
        sessionKey,
        reason: 'already-saved',
        savedFiles: savedResult?.savedFiles?.map(file => file.name) || [],
      });
      return savedResult;
    }
    if (localSoftcopySaveInFlightRef.current.has(sessionKey)) {
      console.log('[LOCAL SAVE AUDIT] skipped duplicate local softcopy save', {
        sessionKey,
        reason: 'already-in-flight',
      });
      return localSoftcopySaveInFlightRef.current.get(sessionKey);
    }

    const savePromise = (async () => {
      let result;
      try {
        const localMediaFiles = [];
        if (payload.localPhotoDataUrl) {
          const photoBuffer = payload.localPhotoBlob
            ? await payload.localPhotoBlob.arrayBuffer()
            : await fetch(payload.localPhotoDataUrl).then((response) => response.arrayBuffer());
          localMediaFiles.push({
            kind: 'photo',
            name: 'photo.png',
            mimeType: 'image/png',
            data: photoBuffer,
          });
        }
        if (payload.gifBlob) {
          localMediaFiles.push({
            kind: 'gif',
            name: 'animation.gif',
            mimeType: 'image/gif',
            data: await payload.gifBlob.arrayBuffer(),
          });
        }
        if (payload.videoBlob) {
          const extension = ['mp4', 'webm', 'mov'].includes(payload.videoExtension)
            ? payload.videoExtension
            : (payload.videoMimeType?.includes('mp4') ? 'mp4' : 'webm');
          localMediaFiles.push({
            kind: 'video',
            name: `video.${extension}`,
            mimeType: payload.videoMimeType || payload.videoBlob.type || 'video/webm',
            data: await payload.videoBlob.arrayBuffer(),
          });
        }
        const uploadMediaFiles = [
          payload.photoDataUrl ? { kind: 'photo', name: 'photo.jpg' } : null,
          payload.gifBlob ? { kind: 'gif', name: 'animation.gif' } : null,
          payload.videoBlob ? { kind: 'video', name: `video.${payload.videoExtension || 'webm'}` } : null,
        ].filter(Boolean);

        console.log('[keychain-save] upload exclusion check', {
          keychainInUpload: uploadMediaFiles.some(f => f.kind === 'keychain4x6'),
          uploadFileNames: uploadMediaFiles.map(f => f.name),
        });

        console.log('[DIAG local-save 3] localMediaFiles before invoke', {
          count: localMediaFiles.length,
          files: localMediaFiles.map(f => ({
            kind: f.kind,
            name: f.name,
            mimeType: f.mimeType,
            sizeBytes: f.sizeBytes || f.data?.byteLength || f.arrayBuffer?.byteLength || null,
            hasData: Boolean(f.data || f.arrayBuffer || f.dataUrl),
          })),
        });

        console.log('[DIAG local-save 4] uploadMediaFiles before upload', {
          count: uploadMediaFiles.length,
          files: uploadMediaFiles.map(f => ({
            kind: f.kind,
            name: f.name,
          })),
          keychainInUpload: uploadMediaFiles.some(f => f.kind === 'keychain4x6'),
        });

        console.log('[keychain] FINAL LOCAL/UPLOAD CHECK', {
          generated: Boolean(payload.keychain4x6?.blob),
          filename: payload.keychain4x6?.filename,
          dedicatedSaveOk: payload.keychain4x6Save?.ok === true,
          dedicatedSavePath: payload.keychain4x6Save?.path || null,
          includedInLocalSave: localMediaFiles.some(file => file.kind === 'keychain4x6'),
          includedInUpload: uploadMediaFiles.some(file => file.kind === 'keychain4x6'),
          keychainInLocal: localMediaFiles.some(file => file.kind === 'keychain4x6'),
          keychainInUpload: uploadMediaFiles.some(file => file.kind === 'keychain4x6'),
          localFileNames: localMediaFiles.map(file => ({ kind: file.kind, name: file.name })),
          uploadFileNames: uploadMediaFiles.map(file => ({ kind: file.kind, name: file.name })),
        });

        if (IS_DEV) {
          console.log('[softcopy-local] saving enabled media regardless of QR', {
            sessionId: payload.sessionToken,
            qrEnabled: softcopySettings.qrEnabled !== false,
            cameraOrientation: payload.cameraOrientation || normalizedCameraOrientation,
            files: localMediaFiles.map(file => ({ kind: file.kind, name: file.name })),
          });
        }

        result = await window.softcopyApi.saveSessionMedia({
          sessionId: payload.sessionToken,
          date: payload.createdAt.slice(0, 10),
          files: localMediaFiles,
        metadata: buildLocalMetadata(payload),
      });
      } catch (error) {
        console.error('[DIAG local-save ERROR]', error);
        result = { ok: false, error: error?.message || String(error) };
      }
      if (IS_DEV) {
        if (result?.ok) {
          console.log('[softcopy-local] saved', {
            sessionId: payload.sessionToken,
            cameraOrientation: payload.cameraOrientation || normalizedCameraOrientation,
            folderPath: result.folderPath,
            savedFiles: result.savedFiles,
          });
        } else {
          console.log('[softcopy-local] save failed', {
            sessionId: payload.sessionToken,
            cameraOrientation: payload.cameraOrientation || normalizedCameraOrientation,
            error: result?.error || 'unknown',
          });
        }
      }
      if (result?.ok) {
        localSoftcopySavedRef.current.set(sessionKey, result);
      }
      return result;
    })();

    localSoftcopySaveInFlightRef.current.set(sessionKey, savePromise);
    try {
      return await savePromise;
    } finally {
      localSoftcopySaveInFlightRef.current.delete(sessionKey);
    }
  };

  const attachKeychain4x6 = async (payload, finalArtworkDataUrl) => {
    const sessionId = createAutoKeychainSessionId(sessionStartRef?.current, payload.sessionToken);
    const sessionKey = createKeychainSaveKey({
      sessionStartValue: sessionStartRef?.current,
      sessionToken: payload.sessionToken,
      cacheKey: payload.cacheKey || softcopyCacheKey,
    });
    const alreadySaved = keychainSavedRef.current.has(sessionKey);
    const alreadyInFlight = keychainSaveInFlightRef.current.has(sessionKey);
    const alreadyAttempted = keychainAttemptedRef.current.has(sessionKey);

    console.log('[keychain auto-save] attempt', {
      sessionKey,
      alreadySaved,
      alreadyInFlight,
    });

    if (alreadySaved) {
      console.log('[keychain auto-save] skip duplicate', {
        sessionKey,
        reason: 'already-saved',
      });
      return payload;
    }

    if (alreadyInFlight) {
      console.log('[keychain auto-save] skip duplicate', {
        sessionKey,
        reason: 'already-in-flight',
      });
      return payload;
    }

    if (alreadyAttempted) {
      console.log('[keychain auto-save] skip duplicate', {
        sessionKey,
        reason: 'already-attempted',
      });
      return payload;
    }

    keychainAttemptedRef.current.add(sessionKey);
    keychainSaveInFlightRef.current.add(sessionKey);
    console.log('[keychain auto-save] start', {
      sessionKey,
    });
    console.log('[keychain auto-save] starting', {
      sessionId,
      sessionKey,
      layoutId: layout?.id,
      selectedTmpl,
      shotCount: shots?.length || 0,
      hasFinalArtwork: Boolean(finalArtworkDataUrl),
      finalArtworkLength: finalArtworkDataUrl?.length || 0,
      finalArtworkPrefix: finalArtworkDataUrl ? finalArtworkDataUrl.slice(0, 80) : null,
    });

    try {
      const keychain4x6 = await generateKeychain4x6Png({
        layout,
        layoutId: layout?.id,
        shots,
        sourceStripDataUrl: finalArtworkDataUrl,
        finalArtworkDataUrl,
        selectedTemplate: template,
        selectedTmpl,
        selectedFilterCss,
        sessionId,
        templateAssets,
      });
      if (!keychain4x6) {
        payload.keychain4x6 = null;
        payload.keychain4x6Generated = false;
        payload.keychain4x6Error = null;
        console.warn('[keychain] skipped unsupported layout', {
          layoutId: layout?.id || '',
        });
        console.log('[DIAG local-save 2] keychain result', {
          hasKeychain: false,
          kind: null,
          name: null,
          mimeType: null,
          sizeBytes: null,
          hasData: false,
        });
        return payload;
      }

      const filename = makeAutoKeychainFilename(sessionId, payload.localSave?.filePrefix);
      payload.keychain4x6 = {
        ...keychain4x6,
        filename,
      };
      payload.keychain4x6Generated = true;
      payload.keychain4x6Save = null;
      payload.keychain4x6Error = null;
      console.log('[DIAG local-save 2] keychain result', {
        hasKeychain: true,
        kind: 'keychain4x6',
        name: filename,
        mimeType: keychain4x6.mimeType,
        sizeBytes: keychain4x6.blob?.size || null,
        hasData: Boolean(keychain4x6.blob || keychain4x6.data || keychain4x6.arrayBuffer || keychain4x6.dataUrl),
      });
      if (!window.diagApi?.writeDownloadsPngFile) {
        throw new Error('Downloads PNG save API is unavailable.');
      }
      const keychainBuffer = await keychain4x6.blob.arrayBuffer();
      const rawSaveResult = await window.diagApi.writeDownloadsPngFile({
        filename,
        arrayBuffer: keychainBuffer,
      });
      const saveResult = normalizeDownloadsPngSaveResult(rawSaveResult, filename);
      payload.keychain4x6Save = saveResult;
      if (!isKeychainSaveSuccessful(saveResult)) {
        throw new Error(saveResult?.error || 'Keychain Downloads save failed.');
      }
      keychainSavedRef.current.add(sessionKey);
      console.log('[keychain auto-save] success', {
        sessionKey,
        filename: saveResult.filename,
        targetPath: saveResult.targetPath,
      });
      console.log('[keychain auto-save] saved', {
        filename: saveResult.filename,
        targetPath: saveResult.targetPath,
        exists: saveResult.exists,
        sizeBytes: saveResult.sizeBytes,
      });
      console.log('[LOCAL SAVE ORDER] 5 keychain saved', {
        filename: saveResult.filename,
        targetPath: saveResult.targetPath,
      });
      console.log('[keychain-save] result', {
        filename: saveResult.filename,
        targetPath: saveResult.targetPath,
        exists: saveResult.exists,
        sizeBytes: saveResult.sizeBytes,
      });
      console.log('[keychain] SAVE RESULT', {
        filename: saveResult.filename,
        savedPath: saveResult.targetPath,
        exists: saveResult.exists,
        sizeBytes: saveResult.sizeBytes,
      });
      payload.finalPrintPath = getSavedPhotoFile(payload.localSave?.savedFiles)?.path || null;
    } catch (error) {
      const message = error?.message || String(error);
      if (!payload.keychain4x6) {
        payload.keychain4x6Generated = false;
      }
      payload.keychain4x6Save = payload.keychain4x6Save || {
        ok: false,
        error: message,
      };
      payload.keychain4x6Error = message;
      console.error('[DIAG local-save ERROR]', error);
      console.error('[keychain-save ERROR]', error);
      console.error('[keychain auto-save] failed', error);
      console.log('[keychain auto-save] failed', {
        sessionKey,
        error: message,
      });
      console.error('[keychain] generation failed', {
        sessionId,
        sessionKey,
        layoutId: layout?.id || '',
        error: message,
      });
    } finally {
      keychainSaveInFlightRef.current.delete(sessionKey);
    }
    return payload;
  };

  const updateLocalSoftcopyMetadata = async (payload, uploadResult) => {
    if (!payload.localSave?.ok || !window.softcopyApi?.saveSessionMedia) return;
    const result = await window.softcopyApi.saveSessionMedia({
      sessionId: payload.sessionToken,
      date: payload.createdAt.slice(0, 10),
      filePrefix: payload.localSave.filePrefix,
      files: [],
      metadataOnly: true,
      metadata: buildLocalMetadata(payload, uploadResult),
    });
    if (!result?.ok) {
      console.warn('[softcopy-local] metadata update failed', result?.error || 'unknown');
    }
  };

  const performSoftcopyUpload = async (payload, { isRetry = false } = {}) => {
    if (!payload?.canUpload || !softcopySettings.qrEnabled) {
      softcopyArtifactRef.current = payload || null;
      softcopyLogRef.current = { status: 'disabled' };
      setSoftcopyWarnings(payload?.warnings || []);
      setSoftcopyState({ status: 'idle', qrUrl: null });
      return { status: 'disabled' };
    }

    if (isRetry) {
      console.log('[recovery] retry upload started');
    }

    if (uploadInFlightRef.current) {
      if (IS_DEV) console.log('[softcopy] duplicate upload start ignored');
      return softcopyLogRef.current || { status: 'uploading', sessionToken: payload.sessionToken || null };
    }

    uploadInFlightRef.current = true;
    setSoftcopyState({ status: 'uploading', qrUrl: null });
    setSoftcopyWarnings(payload.warnings || []);
    try {
      const uploaded = await uploadSoftcopyAssets({
        photoDataUrl: payload.photoDataUrl,
        gifBlob: payload.gifBlob,
        videoBlob: payload.videoBlob,
        videoMimeType: payload.videoMimeType || '',
        videoExtension: payload.videoExtension || '',
        photoContentType: 'image/jpeg',
        enabled: payload.enabled,
        sessionToken: payload.sessionToken,
        existingPaths: payload.uploadedPaths || {},
      });
      if (IS_DEV) {
        console.log('[keychain] excluded from QR upload', {
          sessionId: payload.sessionToken,
          uploadFileNames: [
            payload.photoDataUrl ? 'photo.jpg' : null,
            payload.gifBlob ? 'animation.gif' : null,
            payload.videoBlob ? `video.${payload.videoExtension || 'webm'}` : null,
          ].filter(Boolean),
        });
      }
      const nextLog = {
        status: 'ready',
        cameraOrientation: payload.cameraOrientation || normalizedCameraOrientation,
        ...uploaded,
      };
      softcopyArtifactRef.current = {
        ...payload,
        ...uploaded,
        uploadedPaths: {
          photoPath: uploaded.photoPath || payload.uploadedPaths?.photoPath || null,
          gifPath: uploaded.gifPath || payload.uploadedPaths?.gifPath || null,
          videoPath: uploaded.videoPath || payload.uploadedPaths?.videoPath || null,
        },
      };
      softcopyLogRef.current = nextLog;
      setSoftcopyState({
        status: 'ready',
        ...uploaded,
      });
      await updateLocalSoftcopyMetadata(payload, nextLog);
      if (IS_DEV) {
        console.log('[softcopy-upload] upload result', {
          sessionId: payload.sessionToken,
          cameraOrientation: payload.cameraOrientation || normalizedCameraOrientation,
          uploadSucceeded: true,
          localSaveSucceeded: payload.localSave?.ok === true,
        });
      }
      return nextLog;
    } catch (softcopyErr) {
      const message = softcopyErr?.message || String(softcopyErr);
      const successfulOutputs = softcopyErr?.successfulOutputs || {};
      const diagnostics = softcopyErr?.softcopyDiagnostics || [];
      const diagnosticSummary = diagnostics.map((diagnostic) => ({
        step: diagnostic.step || null,
        code: diagnostic.code || diagnostic.error?.code || null,
        httpStatus: diagnostic.httpStatus || diagnostic.error?.httpStatus || null,
      }));
      console.warn('[softcopy] upload failed', {
        reason: message,
        step: 'upload_softcopy_assets',
        enabledOutputs: payload?.enabled || {},
        hasPhoto: Boolean(payload?.photoDataUrl),
        hasGif: Boolean(payload?.gifBlob),
        hasVideo: Boolean(payload?.videoBlob),
        hasSessionToken: Boolean(payload?.sessionToken),
        diagnostics: diagnosticSummary,
        hasStack: Boolean(softcopyErr?.stack),
      });
      softcopyArtifactRef.current = {
        ...payload,
        uploadedPaths: {
          ...(payload.uploadedPaths || {}),
          photoPath: successfulOutputs.photoPath || payload.uploadedPaths?.photoPath || null,
          gifPath: successfulOutputs.gifPath || payload.uploadedPaths?.gifPath || null,
          videoPath: successfulOutputs.videoPath || payload.uploadedPaths?.videoPath || null,
        },
      };
      softcopyLogRef.current = {
        status: 'error',
        error: message,
        sessionToken: payload.sessionToken || null,
      };
      setSoftcopyState({
        status: 'error',
        qrUrl: null,
        error: message,
      });
      const failedResult = {
        status: 'error',
        error: message,
        cameraOrientation: payload.cameraOrientation || normalizedCameraOrientation,
      };
      await updateLocalSoftcopyMetadata(payload, failedResult);
      if (IS_DEV) {
        console.log('[softcopy-upload] upload result', {
          sessionId: payload.sessionToken,
          cameraOrientation: payload.cameraOrientation || normalizedCameraOrientation,
          uploadSucceeded: false,
          localSaveSucceeded: payload.localSave?.ok === true,
        });
      }
      return failedResult;
    } finally {
      uploadInFlightRef.current = false;
    }
  };

  const prepareSoftcopyMedia = async (pngUrl, jpegUrl, pngBlob = null) => {
    if (IS_DEV) console.log('[softcopy] active settings before upload', softcopySettings);
    if (softcopyLogRef.current?.status === 'ready') {
      console.log('[softcopy] existing QR reused for print retry');
      return softcopyLogRef.current;
    }

    timeStart('[softcopy] generate/upload');
    try {
      const payload = await buildSoftcopyPayload(pngUrl, jpegUrl, softcopyCacheKey, pngBlob);
      payload.createdAt = payload.createdAt || new Date().toISOString();
      payload.cameraOrientation = normalizeCameraOrientation(payload.cameraOrientation || normalizedCameraOrientation);
      setSoftcopyPreviewAssets({
        cacheKey: payload.cacheKey || softcopyCacheKey,
        status: payload.gifBlob || payload.videoBlob ? 'ready' : 'idle',
        gifBlob: payload.gifBlob || null,
        videoBlob: payload.videoBlob || null,
        gifError: payload.enabled?.gif !== false && !payload.gifBlob ? 'GIF preview unavailable' : null,
        videoError: payload.enabled?.video !== false && !payload.videoBlob ? 'Video preview unavailable' : null,
        warnings: payload.warnings || [],
      });
      payload.localSave = await saveLocalSoftcopy(payload);
      softcopyArtifactRef.current = payload;
      setSoftcopyWarnings(softcopySettings.qrEnabled ? (payload.warnings || []) : []);
      const completeLocalSaveOrder = async (result) => {
        if (ENABLE_KEYCHAIN_AUTO_SAVE) {
          await attachKeychain4x6(payload, pngUrl);
          const currentPayload = softcopyArtifactRef.current || {};
          softcopyArtifactRef.current = {
            ...currentPayload,
            keychain4x6: payload.keychain4x6 || currentPayload.keychain4x6 || null,
            keychain4x6Generated: payload.keychain4x6Generated === true,
            keychain4x6Save: payload.keychain4x6Save || currentPayload.keychain4x6Save || null,
            keychain4x6Error: payload.keychain4x6Error || currentPayload.keychain4x6Error || null,
          };
        }
        console.log('[LOCAL SAVE ORDER] complete', {
          sessionId: payload.sessionToken,
        });
        return result;
      };

      if (!payload.canUpload) {
        if (IS_DEV) console.log('[softcopy] skipped disabled media', payload.enabled);
        const disabledResult = {
          status: 'disabled',
          cameraOrientation: payload.cameraOrientation || normalizedCameraOrientation,
        };
        softcopyLogRef.current = disabledResult;
        setSoftcopyState({ status: 'idle', qrUrl: null });
        return completeLocalSaveOrder(disabledResult);
      }

      if (!softcopySettings.qrEnabled) {
        if (IS_DEV) {
          console.log('[softcopy-upload] skipped because QR disabled', {
            sessionId: payload.sessionToken,
          });
        }
        const disabledResult = {
          status: 'disabled',
          cameraOrientation: payload.cameraOrientation || normalizedCameraOrientation,
          sessionToken: payload.sessionToken,
          localSave: payload.localSave,
        };
        softcopyLogRef.current = disabledResult;
        setSoftcopyState({ status: 'idle', qrUrl: null });
        await updateLocalSoftcopyMetadata(payload, disabledResult);
        return completeLocalSaveOrder(disabledResult);
      }

      const uploaded = await performSoftcopyUpload(payload);
      if (uploaded.status === 'ready') {
        if (uploaded.partial) {
          console.warn('[softcopy] partial upload completed', {
            sessionToken: uploaded.sessionToken || payload.sessionToken || null,
            warnings: uploaded.warnings || [],
          });
        }
        return completeLocalSaveOrder(softcopyLogRef.current);
      }
      return completeLocalSaveOrder({
        status: 'error',
        error: uploaded.error || 'Softcopy upload failed.',
        sessionToken: payload.sessionToken || null,
        cameraOrientation: payload.cameraOrientation || normalizedCameraOrientation,
      });
    } catch (softcopyErr) {
      const message = softcopyErr?.message || String(softcopyErr);
      const diagnostics = softcopyErr?.softcopyDiagnostics || [];
      const diagnosticSummary = diagnostics.map((diagnostic) => ({
        step: diagnostic.step || null,
        code: diagnostic.code || diagnostic.error?.code || null,
        httpStatus: diagnostic.httpStatus || diagnostic.error?.httpStatus || null,
      }));
      console.warn('[softcopy] failure summary', {
        step: 'printscreen_softcopy_upload',
        qrEnabled: softcopySettings.qrEnabled,
        photoEnabled: softcopySettings.photoEnabled !== false,
        gifEnabled: softcopySettings.gifEnabled !== false,
        videoEnabled: softcopySettings.videoEnabled !== false,
        hasFinalImageBlob: Boolean(jpegUrl),
        hasGifBlob: Boolean(softcopyArtifactRef.current?.gifBlob),
        hasVideoBlob: Boolean(softcopyArtifactRef.current?.videoBlob),
        errorMessage: message,
        diagnostics: diagnosticSummary,
        hasStack: Boolean(softcopyErr?.stack),
      });
      const nextLog = {
        status: 'error',
        error: message,
        sessionToken: softcopyArtifactRef.current?.sessionToken || null,
        cameraOrientation: normalizedCameraOrientation,
      };
      softcopyLogRef.current = nextLog;
      softcopyArtifactRef.current = softcopyArtifactRef.current || createEmptySoftcopyPayload();
      setSoftcopyState({
        status: 'error',
        qrUrl: null,
        error: message,
      });
      return nextLog;
    } finally {
      timeEnd('[softcopy] generate/upload');
    }
  };

  const handleRetryUpload = async () => {
    if (uploadRetrying) return;
    const payload = softcopyArtifactRef.current;
    if (!payload?.canUpload) {
      const message = 'Upload cannot be retried for this session. Please end session.';
      console.warn('[softcopy] retry unavailable', message);
      setSoftcopyState({ status: 'error', qrUrl: null, error: message });
      return;
    }

    setUploadRetrying(true);
    try {
      await performSoftcopyUpload(payload, { isRetry: true });
    } finally {
      setUploadRetrying(false);
    }
  };

  const handleEndSession = () => {
    onPrint?.();
  };

  const handleStep4KeychainSave = async () => {
    if (step4KeychainSaving) return;
    setStep4KeychainSaving(true);
    let finalShots = [];
    try {
      if (!window.diagApi?.writeDownloadsPngFile) {
        throw new Error('Diagnostic PNG Downloads API is unavailable.');
      }
      finalShots = Array.isArray(shots) ? shots.filter(Boolean) : [];
      const sessionId = sessionStartRef?.current ? `session-${sessionStartRef.current}` : 'session';
      console.log('[KEYCHAIN REAL INPUT AUDIT]', {
        layoutId: layout?.id,
        selectedTmpl,
        selectedTemplateName: template?.name,
        shotsLength: shots?.length || 0,
        arrangedShotIndexes,
        shots: shots?.map((shot, index) => {
          const src = getShotImageSource(shot);
          return {
            index,
            rawType: typeof shot,
            rawIsString: typeof shot === 'string',
            rawPrefix: typeof shot === 'string' ? shot.slice(0, 120) : null,
            rawKeys: shot && typeof shot === 'object' ? Object.keys(shot) : null,
            normalizedHasSource: Boolean(src),
            normalizedPrefix: src ? src.slice(0, 120) : null,
            normalizedIsDataUrl: src?.startsWith('data:image/'),
            normalizedLength: src?.length,
          };
        }),
      });
      console.log('[KEYCHAIN STEP4 INPUT]', {
        layoutId: layout?.id,
        selectedTmpl,
        selectedTemplateName: template?.name,
        shotCount: shots?.length || 0,
        shots: shots?.map((shot, index) => {
          const src = getShotImageSource(shot);
          return {
            index,
            hasSource: Boolean(src),
            prefix: src ? src.slice(0, 100) : null,
            isDataUrl: src?.startsWith('data:image/'),
            length: src?.length,
          };
        }),
      });
      console.log('[STEP 4 keychain photo audit] shots prop', {
        isArray: Array.isArray(shots),
        length: shots?.length,
        entries: shots?.map((shot, index) => ({
          index,
          type: typeof shot,
          isString: typeof shot === 'string',
          stringPrefix: typeof shot === 'string' ? shot.slice(0, 80) : null,
          keys: shot && typeof shot === 'object' ? Object.keys(shot) : null,
          hasSrc: Boolean(shot?.src),
          hasFullSrc: Boolean(shot?.fullSrc),
          hasDataUrl: Boolean(shot?.dataUrl),
          hasPreviewUrl: Boolean(shot?.previewUrl),
          srcPrefix: shot?.src ? String(shot.src).slice(0, 80) : null,
          fullSrcPrefix: shot?.fullSrc ? String(shot.fullSrc).slice(0, 80) : null,
          dataUrlPrefix: shot?.dataUrl ? String(shot.dataUrl).slice(0, 80) : null,
        })),
      });
      console.log('[STEP 4 keychain real photos] input photos', {
        sessionId,
        layoutId: layout?.id || '',
        photoCount: finalShots.length,
        photos: finalShots.map((photo, index) => ({
          index,
          hasSrc: Boolean(getShotImageSource(photo)),
          width: photo?.width,
          height: photo?.height,
        })),
      });
      const normalizedSources = finalShots.map(getShotImageSource).filter(Boolean);
      if (normalizedSources.length === 0) {
        const error = new Error('No valid real session photos loaded for keychain.');
        error.photoCount = finalShots.length;
        error.normalizedSourceCount = 0;
        error.validImageCount = 0;
        throw error;
      }
      let decodeOkCount = 0;
      for (const [index, src] of normalizedSources.entries()) {
        const decodeOk = await testImageDecode(src, `KEYCHAIN INPUT PHOTO ${index}`);
        if (decodeOk) decodeOkCount += 1;
      }
      if (decodeOkCount === 0) {
        const error = new Error('No valid real session photos loaded for keychain.');
        error.photoCount = finalShots.length;
        error.normalizedSourceCount = normalizedSources.length;
        error.validImageCount = 0;
        throw error;
      }
      const finalArtworkCanvas = await buildFinalPrintCanvas(
        layout,
        template,
        finalShots,
        selectedFilterCss,
        settings,
        { cameraOrientation: normalizedCameraOrientation },
      );
      const finalArtworkDataUrl = finalArtworkCanvas.toDataURL('image/png');

      console.log('[STEP 4 keychain final artwork] generating', {
        canvasWidth: 1200,
        canvasHeight: 1800,
        selectedFilterCss,
        hasFinalArtwork: Boolean(finalArtworkDataUrl),
        finalArtworkLength: finalArtworkDataUrl.length,
        finalArtworkPrefix: finalArtworkDataUrl.slice(0, 80),
        cameraOrientation: normalizedCameraOrientation,
      });

      const keychain = await generateKeychain4x6Png({
        layout,
        layoutId: layout?.id,
        shots: finalShots,
        sourceStripDataUrl: finalArtworkDataUrl,
        finalArtworkDataUrl,
        selectedTemplate: template,
        selectedTmpl,
        selectedFilterCss,
        sessionId,
        templateAssets,
      });
      if (!keychain) {
        throw new Error(`Unsupported keychain layout: ${layout?.id || 'unknown'}`);
      }

      const filename = makeStep4KeychainFilename(sessionId);
      const arrayBuffer = await keychain.blob.arrayBuffer();
      const result = await window.diagApi.writeDownloadsPngFile({
        filename,
        arrayBuffer,
      });
      console.log('[STEP 4 keychain real photos] save result', {
        filename: result?.filename || filename,
        targetPath: result?.targetPath,
        exists: result?.exists,
        sizeBytes: result?.sizeBytes,
      });
      setStep4KeychainResult({
        ...result,
        filename: result?.filename || filename,
      });
    } catch (error) {
      console.error('[STEP 4 keychain real photos] failed', error);
      setStep4KeychainResult({
        ok: false,
        error: error?.message || String(error),
        photoCount: error?.photoCount ?? finalShots?.length ?? null,
        normalizedSourceCount: error?.normalizedSourceCount ?? null,
        validImageCount: error?.validImageCount ?? null,
      });
    } finally {
      setStep4KeychainSaving(false);
    }
  };

  // Compose the 1200×1800 strip once, use it twice:
  //   • PNG download (lossless local copy)
  //   • JPEG data URL sent to Electron for printing (smaller IPC payload)
  // Then advance to the end screen. Falls back gracefully when running
  // outside Electron (no window.printApi) — the download still happens.
  const handlePrintClick = async () => {
    if (printInFlightRef.current) {
      console.log('[print] duplicate print ignored');
      return;
    }
    printInFlightRef.current = true;
    console.log('[print] print lock acquired');
    if (printError || ['failed', 'cancelled', 'partial'].includes(printTerminalStatus)) {
      console.log('[recovery] retry print started');
    }
    if (printing) {
      printInFlightRef.current = false;
      console.log('[print] print lock released');
      return;
    }
    if (!printEnabled) {
      printInFlightRef.current = false;
      console.log('[print] print lock released');
      return;
    }
    if (!template) {
      printInFlightRef.current = false;
      console.log('[print] print lock released');
      onPrint();
      return;
    }
    if (IS_DEV) {
      console.log('[print] resolved copies', {
        requestedCopies,
        printCopiesEnabled,
        finalCopies: selectedCopies,
      });
      console.log('[print] print clicked, locking session');
    }

    setSessionLocked(true);
    setPrinting(true);
    setPrintCompleted(false);
    setFinishReady(false);
    setPrintError(null);
    setPrintTerminalStatus(null);
    setPrintProgress({ current: 1, total: selectedCopies });
    setSoftcopyWarnings([]);
    setUploadRetrying(false);
    if (softcopyArtifactRef.current?.cacheKey !== softcopyCacheKey) {
      softcopyArtifactRef.current = null;
    }
    if (finishReadyTimerRef.current) {
      clearTimeout(finishReadyTimerRef.current);
      finishReadyTimerRef.current = null;
    }
    const qrEnabled = softcopySettings.qrEnabled !== false;
    const softcopyMediaEnabled = (
      softcopySettings.photoEnabled !== false
      || softcopySettings.gifEnabled !== false
      || softcopySettings.videoEnabled !== false
    );
    if (qrEnabled && softcopyMediaEnabled) {
      setSoftcopyState({ status: 'generating', qrUrl: null });
    } else {
      setSoftcopyState({ status: 'idle', qrUrl: null });
    }
    if (IS_DEV) {
      console.time('[print-click] total');
      console.log('[print-click] starting print and QR flows', {
        qrEnabled,
        photoEnabled: softcopySettings.photoEnabled !== false,
        gifEnabled: softcopySettings.gifEnabled !== false,
        videoEnabled: softcopySettings.videoEnabled !== false,
      });
    }
    let printStatus = 'completed';
    let printFailureReason = null;
    let printMessage = null;
    let printJobId = null;
    let printCopiesRequested = selectedCopies;
    let printCopiesCompleted = 0;
    let softcopyLog = { status: 'idle' };
    let softcopyPromise = Promise.resolve(softcopyLog);
    let softcopyStarted = false;
    let finalArtifact = null;
    const sessionRecordId = sessionStartRef?.current ? `session-${sessionStartRef.current}` : null;

    try {
      if (IS_DEV) {
        console.log('[print] template overlay used', {
          templateId: template.id,
          overlaySrc: template.overlaySrc || null,
          previewSrc: template.previewSrc || null,
        });
      }
      timeStart('[print] compose final');
      try {
        if (IS_DEV) {
          console.log('[filter] final render filter', {
            selectedFilter: selectedFilter || 'none',
            outputType: 'print-and-qr-photo',
          });
          console.log('[BACKGROUND CANVAS COMPOSE]', {
            selectedBackgroundId: template?.id || null,
            selectedBackgroundName: template?.name || null,
            templateAssets,
            backgroundRenderMode: 'background+overlay+photos',
          });
        }
        finalArtifact = await getFinalPrintArtifact();
        if (IS_DEV) {
          console.log('[mirror] final render', {
            cameraOrientation: normalizedCameraOrientation,
            usesCapturedOrientedSource: true,
            extraMirrorApplied: false,
          });
        }
      } finally {
        timeEnd('[print] compose final');
      }

      // This PNG data URL is the shared final artwork source. The canonical
      // local photo file is saved by softcopy-local as Afterimage-...-photo.png.
      const pngUrl = finalArtifact.pngDataUrl || await blobToDataUrl(finalArtifact.pngBlob);
      finalArtifact.pngDataUrl = pngUrl;
      console.log('[DIAG local-save 1] final PNG ready', {
        hasFinalDataUrl: Boolean(pngUrl),
        finalDataUrlLength: pngUrl?.length,
        sessionId: softcopyArtifactRef.current?.sessionToken || null,
        layoutId: layout?.id || '',
        cameraOrientation: normalizedCameraOrientation,
      });
      console.log('[LOCAL SAVE AUDIT PNG]', {
        filename: 'afterimage-strip-*.png',
        isKeychain: false,
        isNormalPhoto: true,
        caller: 'PrintScreen.handlePrint',
        action: 'legacy-afterimage-strip-autosave-disabled',
        canonical: 'softcopy-local:save-session-media photo.png',
      });

      // Print via Electron (JPEG to keep IPC payload small)
      timeStart('[receipt] final blob');
      let jpegUrl;
      try {
        jpegUrl = finalArtifact.jpegDataUrl || finalArtifact.canvas.toDataURL('image/jpeg', PRINT_JPEG_QUALITY);
        finalArtifact.jpegDataUrl = jpegUrl;
      } finally {
        timeEnd('[receipt] final blob');
      }
      printArtifactRef.current = {
        jpegUrl,
        copies: selectedCopies,
        templateName: template.name || null,
        layoutName: layout?.name || layout?.id || null,
        cameraOrientation: normalizedCameraOrientation,
      };

      if (window.printApi?.printStrip) {
        timeStart('[print] send job');
        let res;
        try {
          res = await window.printApi.printStrip(jpegUrl, {
            copies: selectedCopies,
            sessionId: sessionRecordId,
            templateName: template.name,
            layoutName: layout?.name || layout?.id || null,
            cameraOrientation: normalizedCameraOrientation,
          });
        } finally {
          timeEnd('[print] send job');
        }
        const printResult = normalizePrintApiResult(res, selectedCopies);
        console.log('[print] result received', printResult);
        printStatus = printResult.status;
        printJobId = printResult.jobId;
        printCopiesRequested = printResult.copiesRequested;
        printCopiesCompleted = printResult.copiesPrinted;
        printMessage = getPrintStatusMessage(printStatus, printCopiesCompleted, printCopiesRequested, printResult.error);
        if (printStatus === 'failed') {
          printStatus = 'failed';
          printFailureReason = printResult.error || 'print call returned !success';
          console.log('[print] print failed', { jobId: printJobId, error: printFailureReason });
          throw new Error(printFailureReason);
        }
        if (printStatus === 'cancelled' || printStatus === 'partial') {
          console.log('[print] print cancelled by operator', {
            jobId: printJobId,
            copiesPrinted: printCopiesCompleted,
            copiesRequested: printCopiesRequested,
          });
        } else {
          console.log('[print] print completed', { jobId: printJobId, copiesPrinted: printCopiesCompleted });
        }
      } else {
        console.warn('[print] printApi unavailable — running outside Electron?');
        printCopiesCompleted = selectedCopies;
      }

      if (softcopyMediaEnabled) {
        softcopyStarted = true;
        softcopyPromise = prepareSoftcopyMedia(pngUrl, jpegUrl, finalArtifact.pngBlob);
      } else {
        if (IS_DEV) console.log('[softcopy] skipped because no softcopy media is enabled');
        softcopyStarted = true;
        softcopyPromise = prepareSoftcopyMedia(pngUrl, jpegUrl, finalArtifact.pngBlob);
      }
    } catch (err) {
      if (printStatus !== 'failed') {
        printStatus = 'failed';
        printCopiesCompleted = 0;
      }
      printFailureReason = err?.message || String(err);
      printMessage = getPrintStatusMessage(printStatus, printCopiesCompleted, printCopiesRequested, printFailureReason);
      console.error('[print] failed', err);
      if (qrEnabled && softcopyMediaEnabled && !softcopyStarted) {
        setSoftcopyState({
          status: 'error',
          qrUrl: null,
          error: 'Softcopy media could not be prepared.',
        });
        softcopyLogRef.current = { status: 'error', error: 'Softcopy media could not be prepared.' };
      }
    } finally {
      setPrinting(false);
      setPrintCompleted(printStatus === 'completed');
      setPrintTerminalStatus(printStatus);
      if (printStatus !== 'completed') {
        const recoveryText = printStatus === 'failed'
          ? 'Print failed. Please check the printer and try again.'
          : (printMessage || printFailureReason || 'Print failed. Please try again.');
        setPrintError(recoveryText);
        setPrintProgress(null);
      }
      printInFlightRef.current = false;
      console.log('[print] print lock released');

      if (printStatus === 'completed') {
        setPrintProgress(null);
        finishReadyTimerRef.current = setTimeout(() => {
          setFinishReady(true);
          finishReadyTimerRef.current = null;
        }, 700);
      }

      // Record the session regardless of outcome — failed prints still
      // represent a customer interaction and are useful for troubleshooting.
      try {
        if (window.adminApi?.logSession) {
          const startedAt = sessionStartRef?.current;
          const logResult = await window.adminApi.logSession({
            id:           sessionRecordId,
            timestamp:    new Date().toISOString(),
            layoutId:     layout?.id || null,
            layoutName:   layout?.name || null,
            mode:         settings.mode === 'event' ? 'event' : 'daily',
            eventId:      settings.mode === 'event' ? (settings.activeEventId || null) : null,
            eventName:    settings.mode === 'event' ? (activeEvent?.name || null) : null,
            templateId:   template.id,
            templateName: template.name,
            cameraOrientation: normalizedCameraOrientation,
            copies:       printCopiesCompleted,
            printStatus,
            printCopiesRequested,
            printCopiesCompleted,
            unitPrice:    PRICE_PER_COPY,
            totalAmount:  PRICE_PER_COPY * printCopiesCompleted,
            retriesUsed:  Math.max(0, 1 - retries), // retries starts at 1; used = 1 - remaining
            durationMs:   startedAt ? Date.now() - startedAt : null,
            status:       printStatus,
            failureReason: printStatus === 'failed' ? printFailureReason : null,
            softcopySessionToken: null,
            softcopyPhotoPath: null,
            softcopyGifPath: null,
            softcopyVideoPath: null,
            softcopyExpiresAt: null,
            softcopyStatus: softcopyStarted ? 'uploading' : softcopyLog.status,
            finalPrintPath: null,
            printImagePath: null,
            testMode: testModeEnabled,
          });
          console.log('[sessions] saved print status', { printStatus, printCopiesCompleted, printCopiesRequested, testMode: testModeEnabled });
          const loggedSessionId = logResult?.session?.id || sessionRecordId;
          if (softcopyStarted && loggedSessionId && window.adminApi?.updateSessionSoftcopy) {
            softcopyPromise
              .then(async (result) => {
                softcopyLog = result || { status: 'idle' };
                const savedPhotoFile = getSavedPhotoFile(softcopyArtifactRef.current?.localSave?.savedFiles);
                await window.adminApi.updateSessionSoftcopy(loggedSessionId, {
                  cameraOrientation: normalizedCameraOrientation,
                  softcopySessionToken: softcopyLog.sessionToken || null,
                  softcopyPhotoPath: softcopyLog.photoPath || null,
                  softcopyGifPath: softcopyLog.gifPath || null,
                  softcopyVideoPath: softcopyLog.videoPath || null,
                  softcopyExpiresAt: softcopyLog.expiresAt || null,
                  softcopyStatus: softcopyLog.status || null,
                  finalPrintPath: savedPhotoFile?.path || null,
                  printImagePath: savedPhotoFile?.path || null,
                });
              })
              .catch(async (softcopyErr) => {
                const message = softcopyErr?.message || String(softcopyErr);
                await window.adminApi.updateSessionSoftcopy(loggedSessionId, {
                  cameraOrientation: normalizedCameraOrientation,
                  softcopyStatus: 'error',
                  finalPrintPath: null,
                  printImagePath: null,
                });
                console.warn('[softcopy] background session update failed:', message);
              });
          }
        }
      } catch (logErr) {
        console.warn('[print] session log failed:', logErr);
      }
      if (IS_DEV) console.timeEnd('[print-click] total');
    }
  };

  const softcopyIsGenerating = softcopy?.status === 'generating';
  const softcopyIsUploading = softcopy?.status === 'uploading';
  const softcopyIsBusy = softcopyIsGenerating || softcopyIsUploading;
  const softcopyIsReady = softcopy?.status === 'ready' && softcopy.qrUrl;
  const softcopyIsError = softcopy?.status === 'error';
  const softcopyErrorMessage = getSoftcopyErrorMessage(softcopy?.error || '');
  const showSoftcopyGifCard = softcopySettings.gifEnabled !== false;
  const showSoftcopyVideoCard = softcopySettings.videoEnabled !== false;
  const motionPreviewCount = Number(showSoftcopyGifCard) + Number(showSoftcopyVideoCard);
  const finalPreviewGridClass = motionPreviewCount === 2
    ? 'final-media-preview-grid--paired'
    : motionPreviewCount === 1
      ? 'final-media-preview-grid--stacked'
      : 'final-media-preview-grid--photo-only';
  const gifPreviewReady = Boolean(gifPreviewUrl);
  const videoPreviewReady = Boolean(videoPreviewUrl);
  const showChangeBackground = Boolean(onBack) && !sessionLocked && !printing && !printCompleted;
  const canEditCopies = printCopiesEnabled && !sessionLocked && !printing;
  const showTerminalEndSession = !printing && (
    ['failed', 'cancelled', 'partial'].includes(printTerminalStatus)
  );
  const showRecoveryEndSession = !printing && (
    showTerminalEndSession || softcopyIsError
  );
  const printErrorTitle = printTerminalStatus === 'cancelled' || printTerminalStatus === 'partial'
    ? 'Print cancelled.'
    : 'Print failed.';
  const showPrinterGuidance = Boolean(printError || ['failed', 'cancelled', 'partial'].includes(printTerminalStatus));
  const showPrintReadyCard = !printing && !printCompleted;
  const printerGuidance = RUNTIME_PLATFORM === 'darwin'
    ? 'Printer appears offline or the job is waiting in macOS Print Center. Check the printer, then cancel or resume the job in Print Center. Afterimage can stop queued app jobs, but jobs already sent to the printer must be managed in Print Center.'
    : RUNTIME_PLATFORM === 'win32'
      ? 'Printer appears offline or the job is waiting in the Windows print queue. Check Printers & scanners, confirm the correct printer is set as default, then resume or cancel the job in the Windows queue.'
      : 'Printer appears offline or the system print queue is waiting. Check the printer and operating-system print queue, then retry.';
  const actionLabel = printing
    ? (printProgress ? `Printing ${printProgress.current} of ${printProgress.total}...` : 'Printing...')
    : uploadRetrying
      ? 'Uploading...'
      : softcopyIsBusy
      ? (softcopyIsUploading ? 'Uploading Your Photos...' : 'Preparing QR Code...')
      : printCompleted
        ? (softcopyIsError ? 'Finish Without QR' : 'Finish')
        : printError
          ? 'Retry Print'
        : (printEnabled ? 'Print Photos' : 'Printing Disabled');

  // Canvas dims for the chosen layout drive both the preview's
  // aspect-ratio and per-cell percentage positions. Falling back to a
  // 1200×1800 portrait keeps the preview rendering even if (somehow)
  // no layout was set.
  if (IS_DEV) {
    console.log('[final-preview layout] media availability', {
      hasPhoto: Boolean(shots?.length),
      hasGif: gifPreviewReady,
      hasVideo: videoPreviewReady,
      gifEnabled: showSoftcopyGifCard,
      videoEnabled: showSoftcopyVideoCard,
      qrEnabled: softcopySettings.qrEnabled !== false,
    });
    console.log('[PRINT PREVIEW TEMPLATE ASSETS]', {
      selectedTmpl,
      templateName: template?.name || null,
      assets: templateAssets,
    });
    console.log('[FINAL PREVIEW PHOTO INPUT]', {
      layoutId: layout?.id,
      selectedTmpl,
      shotsLength: shots?.length || 0,
      arrangedShotIndexes,
      shots: shots?.map((shot, index) => ({
        index,
        type: typeof shot,
        isString: typeof shot === 'string',
        prefix: typeof shot === 'string' ? shot.slice(0, 100) : null,
        keys: shot && typeof shot === 'object' ? Object.keys(shot) : null,
        src: shot?.src ? String(shot.src).slice(0, 100) : null,
        fullSrc: shot?.fullSrc ? String(shot.fullSrc).slice(0, 100) : null,
        dataUrl: shot?.dataUrl ? String(shot.dataUrl).slice(0, 100) : null,
      })),
    });
  }

  return (
    <div className={`screen ${active ? 'active' : ''}`} id="s-print" data-screen-label="07 Print">
      {/*
      <PageHeader
        step="Step 7 of 7"
        title="Review & Print"
        subtitle="Looking good? Confirm your print."
        pills={['done', 'done', 'done', 'done', 'done', 'done', 'active']}
      />
      */}

      <div className="print-body">
        <div className="print-preview-panel">
          {testModeEnabled && (
            <div className="print-test-badge">TEST MODE</div>
          )}
          <div className="print-preview-heading">
            <div className="print-preview-label">Final preview</div>
            <p>Review your finished photo before printing.</p>
          </div>
          {SHOW_DIAGNOSTIC_UI && (
            <div className="print-photo-debug">
              <strong>PHOTO DEBUG</strong>
              <span>shots: {photoDebug.shotsLength}</span>
              <span>normalized: {photoDebug.normalizedSourceCount}</span>
              <span>first prefix: {photoDebug.firstSourcePrefix || 'none'}</span>
              <span>isDataUrl: {String(photoDebug.firstSourceIsDataUrl)}</span>
              <span>base64Length: {photoDebug.firstSourceAudit?.base64Length ?? 'n/a'}</span>
              <span>base64Mod4: {photoDebug.firstSourceAudit?.base64Mod4 ?? 'n/a'}</span>
              <span>invalidBase64: {String(photoDebug.firstSourceAudit?.hasInvalidBase64Chars ?? false)}</span>
              <span>whitespace: {String(photoDebug.firstSourceAudit?.hasWhitespace ?? false)}</span>
              <span>layout id: {photoDebug.layoutId || 'none'}</span>
              <span>arranged: {photoDebug.arrangedShotIndexes.join(', ') || 'none'}</span>
              <span>missing: {photoDebug.missingSourceCount}</span>
              <div className="print-photo-debug-sample">
                <span>First normalized photo test</span>
                {photoDebug.firstSource ? (
                  <img
                    src={photoDebug.firstSource}
                    alt="First normalized photo test"
                    onLoad={(event) => {
                      console.log('[PHOTO DEBUG SAMPLE LOAD OK]', {
                        srcPrefix: photoDebug.firstSource?.slice(0, 80),
                        naturalWidth: event.currentTarget.naturalWidth,
                        naturalHeight: event.currentTarget.naturalHeight,
                      });
                    }}
                    onError={(event) => {
                      console.error('[PHOTO DEBUG SAMPLE LOAD FAILED]', {
                        srcPrefix: photoDebug.firstSource?.slice(0, 120),
                        srcLength: photoDebug.firstSource?.length,
                        currentSrc: event.currentTarget?.currentSrc,
                      });
                    }}
                  />
                ) : (
                  <em>No normalized source</em>
                )}
              </div>
            </div>
          )}
          <div className="print-frame-box" id="print-frame-box">
            <div className={`final-media-preview-grid ${finalPreviewGridClass}`.trim()}>
              <article className="final-media-card final-media-card--photo">
                <div className="final-media-label">PNG</div>
                <div className="final-media-content final-media-content--photo">
                  {finalPreviewPngStatus === 'generating' && !finalPreviewPngUrl ? (
                    <div className="final-media-status">Generating PNG...</div>
                  ) : finalPreviewPngUrl ? (
                    <img
                      className="final-media-photo-img"
                      src={finalPreviewPngUrl}
                      alt="PNG preview"
                      onLoad={(event) => {
                        console.log('[FINAL PREVIEW PNG LOAD OK]', {
                          naturalWidth: event.currentTarget.naturalWidth,
                          naturalHeight: event.currentTarget.naturalHeight,
                          srcLength: finalPreviewPngUrl?.length || 0,
                        });
                      }}
                      onError={(event) => {
                        console.error('[FINAL PREVIEW PNG LOAD FAILED]', {
                          currentSrc: event.currentTarget?.currentSrc,
                          srcLength: finalPreviewPngUrl?.length || 0,
                        });
                      }}
                    />
                  ) : (
                    <div className="final-media-status">PNG preview unavailable</div>
                  )}
                </div>
              </article>

              {showSoftcopyGifCard && (
                <article className="final-media-card final-media-card--gif">
                  <div className="final-media-label">GIF</div>
                  <div className="final-media-content">
                    {softcopyPreviewAssets.status === 'generating' && !gifPreviewReady && (
                      <div className="final-media-status">Generating GIF...</div>
                    )}
                    {gifPreviewReady && gifPreviewUrl ? (
                      <img
                        src={gifPreviewUrl}
                        alt="GIF preview"
                        onLoad={() => {
                          console.log('[softcopy preview] GIF loaded', {
                            sourceType: gifPreviewSourceType,
                            srcLength: gifPreviewUrl?.length || 0,
                          });
                        }}
                        onError={(event) => {
                          console.error('[softcopy preview] failed', {
                            type: 'gif',
                            error: 'GIF preview failed to load',
                            currentSrc: event.currentTarget?.currentSrc,
                          });
                        }}
                      />
                    ) : softcopyPreviewAssets.status === 'error' || softcopyPreviewAssets.gifError ? (
                      <div className="final-media-status">GIF unavailable</div>
                    ) : null}
                  </div>
                </article>
              )}

              {showSoftcopyVideoCard && (
                <article className="final-media-card final-media-card--video">
                  <div className="final-media-label">VIDEO</div>
                  <div className="final-media-content">
                    {softcopyPreviewAssets.status === 'generating' && !videoPreviewReady && (
                      <div className="final-media-status">Generating Video...</div>
                    )}
                    {videoPreviewReady && videoPreviewUrl ? (
                      <video
                        src={videoPreviewUrl}
                        autoPlay
                        muted
                        loop
                        playsInline
                        preload="metadata"
                        onLoadedData={() => {
                          console.log('[softcopy preview] VIDEO loaded', {
                            sourceType: videoPreviewSourceType,
                            srcLength: videoPreviewUrl?.length || 0,
                          });
                        }}
                        onError={(event) => {
                          console.error('[softcopy preview] failed', {
                            type: 'video',
                            error: 'Video preview failed to load',
                            currentSrc: event.currentTarget?.currentSrc,
                          });
                        }}
                      />
                    ) : softcopyPreviewAssets.status === 'error' || softcopyPreviewAssets.videoError ? (
                      <div className="final-media-status">Video unavailable</div>
                    ) : null}
                  </div>
                </article>
              )}
            </div>
          </div>
        </div>

        <div className="print-sidebar">
          <div className="print-brand-lockup" aria-label="Afterimage">
            <img className="print-brand-mark" src={logoBlack} alt="" aria-hidden="true" />
            <img className="print-brand-wordmark" src={typoBlack} alt="Afterimage" />
          </div>

          <div className="print-sidebar-content">
            {(softcopyIsBusy || softcopyIsReady || softcopyIsError || softcopyWarnings.length > 0) && (
              <section className="print-download-section" aria-label="Photo download">
                {softcopyIsBusy && (
                  <div className="softcopy-qr-card softcopy-qr-card--loading" aria-live="polite">
                    <div className="softcopy-spinner" aria-hidden="true" />
                    <h3>Preparing your download QR...</h3>
                    <p>Your photos are being prepared. This usually takes a moment.</p>
                  </div>
                )}

                {softcopyWarnings.length > 0 && (
                  <div className="retry-banner">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <circle cx="12" cy="12" r="10" />
                      <line x1="12" y1="7" x2="12" y2="13" />
                      <line x1="12" y1="17" x2="12.01" y2="17" />
                    </svg>
                    <div>
                      <p><strong>Some download formats are unavailable.</strong></p>
                      <p>{softcopyWarnings.join(' ')}</p>
                    </div>
                  </div>
                )}

                {softcopyIsReady && (
                  <div className="softcopy-qr-card" aria-live="polite">
                    <h3>Scan to Download</h3>
                    <QRCodeCanvas value={softcopy.qrUrl} size={400} includeMargin />
                    <p>This link expires in 6 hours.</p>
                  </div>
                )}

                {softcopyIsError && (
                  <div className="softcopy-qr-card softcopy-qr-card--error" role="alert">
                    <h3>QR download is unavailable right now.</h3>
                    <p>You may still print your photos. {softcopyErrorMessage}</p>
                    <div className="softcopy-error-actions">
                      <button
                        type="button"
                        className="btn-ghost"
                        onClick={handleRetryUpload}
                        disabled={uploadRetrying}
                      >
                        {uploadRetrying ? 'Retrying…' : 'Retry Upload'}
                      </button>
                      {showRecoveryEndSession && (
                        <button
                          type="button"
                          className="btn-ghost"
                          onClick={handleEndSession}
                        >
                          End Session
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </section>
            )}

            {showPrintReadyCard && (
              <section className="print-ready-card" aria-labelledby="print-ready-title">
                <div className="print-ready-copy">
                  <div className="print-sidebar-title" id="print-ready-title">Ready to Print?</div>
                  <div className="print-sidebar-instruction">
                    {printCopiesEnabled
                      ? `Choose your copies below. This session will print ${selectedCopies} ${selectedCopies === 1 ? 'copy' : 'copies'}.`
                      : 'Press Print Photos when you are ready.'}
                  </div>
                </div>

                {printCopiesEnabled && (
                  <div className="copies-section">
                    <div className="copies-label">Print Copies</div>
                    <div className="copies-row">
                      <button
                        className="cnt-btn"
                        onClick={() => onChangeCopies?.(-1)}
                        disabled={!canEditCopies || selectedCopies <= MIN_PRINT_COPIES}
                        aria-label="Decrease print copies"
                      >
                        -
                      </button>
                      <div className="cnt-num" id="copies-num" aria-live="polite">{selectedCopies}</div>
                      <button
                        className="cnt-btn"
                        onClick={() => onChangeCopies?.(1)}
                        disabled={!canEditCopies || selectedCopies >= MAX_PRINT_COPIES}
                        aria-label="Increase print copies"
                      >
                        +
                      </button>
                    </div>
                  </div>
                )}

                {printError && (
                  <div className="retry-banner print-error-banner">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <circle cx="12" cy="12" r="10" />
                      <line x1="12" y1="7" x2="12" y2="13" />
                      <line x1="12" y1="17" x2="12.01" y2="17" />
                    </svg>
                    <div>
                      <p><strong>{printErrorTitle}</strong> {printError}</p>
                      {showPrinterGuidance && <p>{printerGuidance}</p>}
                    </div>
                  </div>
                )}

                {!printEnabled && (
                  <div className="retry-banner" id="print-disabled-banner">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <circle cx="12" cy="12" r="10" />
                      <line x1="8" y1="8" x2="16" y2="16" />
                      <line x1="16" y1="8" x2="8" y2="16" />
                    </svg>
                    <p><strong>Printing is currently disabled.</strong> Please ask the attendant for assistance.</p>
                  </div>
                )}
              </section>
            )}
          </div>

          <div className="print-actions">
            <button
              className="btn-print"
              aria-live="polite"
              onClick={printCompleted ? (finishReady ? onPrint : undefined) : handlePrintClick}
              disabled={printing || softcopyIsBusy || uploadRetrying || !printEnabled || (printCompleted && !finishReady)}
            >
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <polyline points="6 9 6 2 18 2 18 9" />
                <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
                <rect x="6" y="14" width="12" height="8" />
              </svg>
              {actionLabel}
            </button>

            {showPrinterGuidance && CAN_OPEN_PRINT_CENTER && window.printApi?.openPrintCenter && (
              <button
                type="button"
                className="btn-ghost print-secondary-action"
                onClick={async () => {
                  try {
                    const result = await window.printApi.openPrintCenter();
                    if (!result?.ok) {
                      console.warn('[print] open print center failed', result?.error || 'unknown');
                    }
                  } catch (error) {
                    console.warn('[print] open print center failed', error);
                  }
                }}
              >
                Open Print Center
              </button>
            )}

            {showChangeBackground && (
              <button
                type="button"
                className="btn-ghost print-secondary-action"
                id="btn-change-design"
                onClick={handleChangeBackground}
                title="Pick a different background without retaking photos"
              >
                <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25">
                  <path d="M19 12H5" />
                  <path d="M12 19l-7-7 7-7" />
                </svg>
                Change Background
              </button>
            )}

            {showTerminalEndSession && (
              <button
                type="button"
                className="btn-ghost print-secondary-action"
                onClick={handleEndSession}
              >
                End Session
              </button>
            )}

            {SHOW_KEYCHAIN_DEBUG_UI && (
              <div className="print-step4-keychain">
                <button
                  type="button"
                  className="btn-ghost print-secondary-action"
                  onClick={handleStep4KeychainSave}
                  disabled={step4KeychainSaving}
                >
                  {step4KeychainSaving ? 'Saving keychain...' : 'TEST: Save Keychain 4x6'}
                </button>
                {step4KeychainResult && (
                  <div className={`print-step4-result ${step4KeychainResult.ok ? 'ok' : 'bad'}`}>
                    <div><strong>ok:</strong> {String(step4KeychainResult.ok === true)}</div>
                    {step4KeychainResult.filename && (
                      <div><strong>filename:</strong> {step4KeychainResult.filename}</div>
                    )}
                    {step4KeychainResult.downloadsDir && (
                      <div><strong>downloadsDir:</strong> {step4KeychainResult.downloadsDir}</div>
                    )}
                    {step4KeychainResult.targetPath && (
                      <div><strong>targetPath:</strong> {step4KeychainResult.targetPath}</div>
                    )}
                    {Object.prototype.hasOwnProperty.call(step4KeychainResult, 'exists') && (
                      <div><strong>exists:</strong> {String(step4KeychainResult.exists)}</div>
                    )}
                    {Object.prototype.hasOwnProperty.call(step4KeychainResult, 'sizeBytes') && (
                      <div><strong>sizeBytes:</strong> {step4KeychainResult.sizeBytes}</div>
                    )}
                    {Object.prototype.hasOwnProperty.call(step4KeychainResult, 'photoCount') && (
                      <div><strong>photoCount:</strong> {step4KeychainResult.photoCount}</div>
                    )}
                    {Object.prototype.hasOwnProperty.call(step4KeychainResult, 'normalizedSourceCount') && (
                      <div><strong>normalizedSourceCount:</strong> {step4KeychainResult.normalizedSourceCount}</div>
                    )}
                    {Object.prototype.hasOwnProperty.call(step4KeychainResult, 'validImageCount') && (
                      <div><strong>validImageCount:</strong> {step4KeychainResult.validImageCount}</div>
                    )}
                    {step4KeychainResult.error && (
                      <div><strong>error:</strong> {step4KeychainResult.error}</div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
