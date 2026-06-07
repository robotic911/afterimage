import { useEffect, useMemo, useRef, useState } from 'react';
import { QRCodeCanvas } from 'qrcode.react';
import './PrintScreen.css';
import LayoutPreview from '../LayoutPreview';
import logoBlack from '../../assets/ai-logo-black.png';
import typoBlack from '../../assets/ai-typo-black.png';
import { buildFinalPrintCanvas, PRINT_JPEG_QUALITY } from '../../lib/printImage';
import { versionTemplateAssetSrc } from '../../lib/templateAssetUrl';
import { DEFAULT_PRINTER_PROFILE_ID, DEFAULT_SAFE_MARGIN_OVERRIDE } from '../../constants/printers';
import { createSoftcopySessionToken, uploadSoftcopyAssets } from '../../lib/softcopyUpload';
import { DEFAULT_SOFTCOPY_SETTINGS, resolveSoftcopySettings } from '../../constants/softcopySettings';
import {
  clampPrintCopies,
  DEFAULT_PRINT_COPIES,
  MAX_PRINT_COPIES,
  MIN_PRINT_COPIES,
} from '../../constants/printSettings';

const PRICE_PER_COPY = 99; // PHP
const FINAL_PRINT_STATUSES = new Set(['completed', 'failed', 'cancelled', 'partial']);
const IS_DEV = import.meta.env.DEV;
const RUNTIME_PLATFORM = window.printApi?.platform || 'unknown';
const CAN_OPEN_PRINT_CENTER = window.printApi?.canOpenPrintCenter === true;

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
    return 'Softcopy upload failed. Please check internet/Supabase and retry.';
  }
  return 'Softcopy upload failed. Please check internet/Supabase and retry.';
}

function createEmptySoftcopyPayload() {
  return {
    sessionToken: null,
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
  };
}

function timeStart(label) {
  if (IS_DEV) console.time(label);
}

function timeEnd(label) {
  if (IS_DEV) console.timeEnd(label);
}

function makeSoftcopyCacheKey({ layout, template, shots, selectedFilterCss, softcopySettings, sessionVideo }) {
  return JSON.stringify({
    layoutId: layout?.id || null,
    templateId: template?.id || null,
    templateUpdatedAt: template?.updatedAt || template?.createdAt || null,
    selectedFilterCss,
    shots: (shots || []).map((shot) => (shot ? `${shot.length}:${shot.slice(0, 96)}` : null)),
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

export default function PrintScreen({
  active,
  layout,
  templates = [],
  settings = {
    mode: 'daily',
    activeEventId: null,
    printEnabled: true,
    testModeEnabled: false,
    printerProfileId: DEFAULT_PRINTER_PROFILE_ID,
    safeMarginOverride: DEFAULT_SAFE_MARGIN_OVERRIDE,
    softcopySettings: DEFAULT_SOFTCOPY_SETTINGS,
  },
  events = [],
  selectedTmpl,
  selectedFilterCss = '',
  shots,
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
  const activeEvent = useMemo(
    () => events.find((event) => event.id === settings.activeEventId) || null,
    [events, settings.activeEventId],
  );
  const printEnabled = settings.printEnabled !== false;
  const testModeEnabled = settings.testModeEnabled === true;
  const softcopySettings = useMemo(
    () => resolveSoftcopySettings(settings.softcopySettings),
    [settings.softcopySettings],
  );
  const selectedCopies = clampPrintCopies(copies);
  const [printing, setPrinting] = useState(false);
  const [sessionLocked, setSessionLocked] = useState(false);
  const [printCompleted, setPrintCompleted] = useState(false);
  const [finishReady, setFinishReady] = useState(false);
  const [printProgress, setPrintProgress] = useState(null);
  const [printError, setPrintError] = useState(null);
  const [printTerminalStatus, setPrintTerminalStatus] = useState(null);
  const [softcopyWarnings, setSoftcopyWarnings] = useState([]);
  const [uploadRetrying, setUploadRetrying] = useState(false);
  const finishReadyTimerRef = useRef(null);
  const sessionLockedRef = useRef(false);
  const printInFlightRef = useRef(false);
  const uploadInFlightRef = useRef(false);
  const printArtifactRef = useRef(null);
  const softcopyArtifactRef = useRef(null);
  const softcopyLogRef = useRef(null);

  useEffect(() => {
    sessionLockedRef.current = sessionLocked;
  }, [sessionLocked]);

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
      softcopyArtifactRef.current = null;
      softcopyLogRef.current = null;
      setSoftcopyWarnings([]);
      setUploadRetrying(false);
      if (finishReadyTimerRef.current) {
        clearTimeout(finishReadyTimerRef.current);
        finishReadyTimerRef.current = null;
      }
    }
  }, [active]);

  useEffect(() => {
    return () => {
      if (finishReadyTimerRef.current) {
        clearTimeout(finishReadyTimerRef.current);
      }
    };
  }, []);

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
  }), [layout, template, shots, selectedFilterCss, softcopySettings, sessionVideo]);

  const buildSoftcopyPayload = async (jpegUrl, cacheKey = softcopyCacheKey) => {
    const cachedPayload = softcopyArtifactRef.current;
    if (cachedPayload?.cacheKey === cacheKey && cachedPayload.canUpload) {
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
    const photoDataUrl = enabled.photo ? jpegUrl : null;
    const uploadedPaths = cachedPayload?.cacheKey === cacheKey
      ? {
          photoPath: cachedPayload.photoPath || cachedPayload.uploadedPaths?.photoPath || null,
          gifPath: cachedPayload.gifPath || cachedPayload.uploadedPaths?.gifPath || null,
          videoPath: cachedPayload.videoPath || cachedPayload.uploadedPaths?.videoPath || null,
        }
      : {};

    if (!softcopySettings.qrEnabled || !Object.values(enabled).some(Boolean)) {
      return {
        sessionToken,
        photoDataUrl,
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

    let gifBlob = null;
    let videoBlob = null;
    let videoMimeType = '';
    let videoExtension = '';

    timeStart('[softcopy] generate media');
    try {
      const mediaTasks = [];
      if (enabled.gif) {
        mediaTasks.push((async () => {
          try {
            const { generateSessionGif } = await import('../../lib/gifGenerator');
            const gif = await generateSessionGif(shots, {
              layoutId: layout?.id,
              width: layout?.camera?.width,
              height: layout?.camera?.height,
            });
            gifBlob = gif?.blob || null;
          } catch (error) {
            console.warn('[gif] generation failed', error);
            warnings.push('GIF could not be generated.');
          }
        })());
      }

      if (enabled.video) {
        mediaTasks.push((async () => {
          try {
            const { composeSimultaneousSlotVideo } = await import('../../lib/sessionVideoRecorder');
            const finalVideo = await composeSimultaneousSlotVideo({
              layout,
              shotVideoClips: sessionVideo?.shotVideoClips || [],
              backgroundSrc: versionTemplateAssetSrc(template.backgroundSrc || template.overlaySrc || template.src, template),
              templateSrc: versionTemplateAssetSrc(template.overlaySrc || template.src, template),
            });
            if (finalVideo?.blob) {
              videoBlob = finalVideo.blob;
              videoMimeType = finalVideo.mimeType || '';
              videoExtension = finalVideo.extension || '';
            } else if (enabled.video) {
              warnings.push('Video could not be generated.');
            }
          } catch (error) {
            console.warn('[video] generation failed', error);
            warnings.push('Video could not be generated.');
          }
        })());
      }

      await Promise.all(mediaTasks);
    } finally {
      timeEnd('[softcopy] generate media');
    }

    return {
      sessionToken,
      photoDataUrl,
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

  const performSoftcopyUpload = async (payload, { isRetry = false } = {}) => {
    if (!payload?.canUpload || !softcopySettings.qrEnabled) {
      softcopyArtifactRef.current = payload || null;
      softcopyLogRef.current = { status: 'disabled' };
      setSoftcopyWarnings(payload?.warnings || []);
      onSoftcopyChange?.({ status: 'idle', qrUrl: null });
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
    onSoftcopyChange?.({ status: 'uploading', qrUrl: null });
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
      const nextLog = { status: 'ready', ...uploaded };
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
      onSoftcopyChange?.({
        status: 'ready',
        ...uploaded,
      });
      return nextLog;
    } catch (softcopyErr) {
      const message = softcopyErr?.message || String(softcopyErr);
      const successfulOutputs = softcopyErr?.successfulOutputs || {};
      console.warn('[softcopy] upload failed', {
        reason: message,
        step: 'upload_softcopy_assets',
        enabledOutputs: payload?.enabled || {},
        hasPhoto: Boolean(payload?.photoDataUrl),
        hasGif: Boolean(payload?.gifBlob),
        hasVideo: Boolean(payload?.videoBlob),
        sessionToken: payload?.sessionToken || null,
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
      softcopyLogRef.current = { status: 'error', error: message, sessionToken: payload.sessionToken || null };
      onSoftcopyChange?.({
        status: 'error',
        qrUrl: null,
        error: message,
      });
      return { status: 'error', error: message };
    } finally {
      uploadInFlightRef.current = false;
    }
  };

  const prepareAndUploadSoftcopy = async (jpegUrl) => {
    if (IS_DEV) console.log('[softcopy] active settings before upload', softcopySettings);
    const shouldPrepareSoftcopy = softcopySettings.qrEnabled;
    if (!shouldPrepareSoftcopy) {
      console.log('[softcopy] skipped because QR is disabled');
      softcopyLogRef.current = { status: 'disabled' };
      onSoftcopyChange?.({ status: 'idle', qrUrl: null });
      return { status: 'disabled' };
    }
    if (softcopyLogRef.current?.status === 'ready') {
      console.log('[softcopy] existing QR reused for print retry');
      return softcopyLogRef.current;
    }

    timeStart('[softcopy] generate/upload');
    try {
      const payload = await buildSoftcopyPayload(jpegUrl, softcopyCacheKey);
      softcopyArtifactRef.current = payload;
      setSoftcopyWarnings(payload.warnings || []);
      if (!payload.canUpload) {
        if (IS_DEV) console.log('[softcopy] skipped disabled media', payload.enabled);
        softcopyLogRef.current = { status: 'disabled' };
        onSoftcopyChange?.({ status: 'idle', qrUrl: null });
        return { status: 'disabled' };
      }

      const uploaded = await performSoftcopyUpload(payload);
      if (uploaded.status === 'ready') {
        if (uploaded.partial) {
          console.warn('[softcopy] partial upload completed', {
            sessionToken: uploaded.sessionToken || payload.sessionToken || null,
            warnings: uploaded.warnings || [],
          });
        }
        return softcopyLogRef.current;
      }
      return {
        status: 'error',
        error: uploaded.error || 'Softcopy upload failed.',
        sessionToken: payload.sessionToken || null,
      };
    } catch (softcopyErr) {
      const message = softcopyErr?.message || String(softcopyErr);
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
      });
      const nextLog = { status: 'error', error: message, sessionToken: softcopyArtifactRef.current?.sessionToken || null };
      softcopyLogRef.current = nextLog;
      softcopyArtifactRef.current = softcopyArtifactRef.current || createEmptySoftcopyPayload();
      onSoftcopyChange?.({
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
      onSoftcopyChange?.({ status: 'error', qrUrl: null, error: message });
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
      console.log('[print] selected copies', selectedCopies);
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
      onSoftcopyChange?.({ status: 'generating', qrUrl: null });
    } else {
      onSoftcopyChange?.({ status: 'idle', qrUrl: null });
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
    let canvas = null;

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
        canvas = await buildFinalPrintCanvas(
          layout,
          versionTemplateAssetSrc(template.overlaySrc || template.backgroundSrc || template.src, template),
          shots,
          selectedFilterCss,
          settings,
        );
      } finally {
        timeEnd('[print] compose final');
      }

      // Save a lossless PNG automatically. Electron writes to Downloads
      // without a browser download prompt; browser mode keeps the old fallback.
      const pngUrl = canvas.toDataURL('image/png');
      const timestampStamp = () => {
        const d = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
      };
      const downloadDataUrl = (dataUrl, filename) => {
        const a = document.createElement('a');
        a.href = dataUrl;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
      };
      const pngFilename = `afterimage-strip-${timestampStamp()}.png`;
      let savedPng = false;
      if (window.printApi?.saveStrip) {
        const saveRes = await window.printApi.saveStrip(pngUrl, { filename: pngFilename });
        savedPng = !!saveRes?.ok;
        if (saveRes?.ok) {
          console.log('[print] autosaved PNG:', saveRes.path);
        } else {
          console.warn('[print] autosave failed:', saveRes?.error || 'unknown');
        }
      }
      if (!savedPng) {
        downloadDataUrl(pngUrl, pngFilename);
      }

      // Print via Electron (JPEG to keep IPC payload small)
      timeStart('[receipt] final blob');
      let jpegUrl;
      try {
        jpegUrl = canvas.toDataURL('image/jpeg', PRINT_JPEG_QUALITY);
      } finally {
        timeEnd('[receipt] final blob');
      }
      printArtifactRef.current = {
        jpegUrl,
        copies: selectedCopies,
        templateName: template.name || null,
        layoutName: layout?.name || layout?.id || null,
      };

      if (qrEnabled && softcopyMediaEnabled) {
        softcopyStarted = true;
        softcopyPromise = prepareAndUploadSoftcopy(jpegUrl);
      } else if (!qrEnabled) {
        console.log('[softcopy] skipped because QR is disabled');
        softcopyLogRef.current = { status: 'disabled' };
        softcopyPromise = Promise.resolve({ status: 'disabled' });
      } else {
        if (IS_DEV) console.log('[softcopy] skipped because no softcopy media is enabled');
        softcopyLogRef.current = { status: 'disabled' };
        softcopyPromise = Promise.resolve({ status: 'disabled' });
      }

      if (window.printApi?.printStrip) {
        timeStart('[print] send job');
        let res;
        try {
          res = await window.printApi.printStrip(jpegUrl, {
            copies: selectedCopies,
            sessionId: sessionStartRef?.current ? `session-${sessionStartRef.current}` : null,
            templateName: template.name,
            layoutName: layout?.name || layout?.id || null,
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
    } catch (err) {
      if (printStatus !== 'failed') {
        printStatus = 'failed';
        printCopiesCompleted = 0;
      }
      printFailureReason = err?.message || String(err);
      printMessage = getPrintStatusMessage(printStatus, printCopiesCompleted, printCopiesRequested, printFailureReason);
      console.error('[print] failed', err);
      if (qrEnabled && softcopyMediaEnabled && !softcopyStarted) {
        onSoftcopyChange?.({
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
      if (typeof canvas !== 'undefined' && canvas) {
        canvas.width = 0;
        canvas.height = 0;
      }
      if (printStatus === 'completed') {
        setPrintProgress(null);
        finishReadyTimerRef.current = setTimeout(() => {
          setFinishReady(true);
          finishReadyTimerRef.current = null;
        }, 700);
      }
      printInFlightRef.current = false;
      console.log('[print] print lock released');

      try {
        softcopyLog = await softcopyPromise;
      } catch (softcopyErr) {
        const message = softcopyErr?.message || String(softcopyErr);
        softcopyLog = { status: 'error', error: message, sessionToken: softcopyArtifactRef.current?.sessionToken || null };
      }

      // Record the session regardless of outcome — failed prints still
      // represent a customer interaction and are useful for troubleshooting.
      try {
        if (window.adminApi?.logSession) {
          const startedAt = sessionStartRef?.current;
          await window.adminApi.logSession({
            timestamp:    new Date().toISOString(),
            layoutId:     layout?.id || null,
            layoutName:   layout?.name || null,
            mode:         settings.mode === 'event' ? 'event' : 'daily',
            eventId:      settings.mode === 'event' ? (settings.activeEventId || null) : null,
            eventName:    settings.mode === 'event' ? (activeEvent?.name || null) : null,
            templateId:   template.id,
            templateName: template.name,
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
            softcopySessionToken: softcopyLog.sessionToken || null,
            softcopyPhotoPath: softcopyLog.photoPath || null,
            softcopyGifPath: softcopyLog.gifPath || null,
            softcopyVideoPath: softcopyLog.videoPath || null,
            softcopyExpiresAt: softcopyLog.expiresAt || null,
            softcopyStatus: softcopyLog.status || null,
            testMode: testModeEnabled,
          });
          console.log('[sessions] saved print status', { printStatus, printCopiesCompleted, printCopiesRequested, testMode: testModeEnabled });
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
  const showChangeBackground = Boolean(onBack) && !sessionLocked && !printing && !printCompleted;
  const canEditCopies = !sessionLocked && !printing;
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
      ? (softcopyIsUploading ? 'Uploading softcopy...' : 'Generating QR...')
      : printCompleted
        ? (softcopyIsError ? 'Finish Without QR' : 'Finish')
        : printError
          ? 'Retry Print'
        : (printEnabled ? 'Print Photos' : 'Printing Disabled');

  // Canvas dims for the chosen layout drive both the preview's
  // aspect-ratio and per-cell percentage positions. Falling back to a
  // 1200×1800 portrait keeps the preview rendering even if (somehow)
  // no layout was set.
  return (
    <div className={`screen ${active ? 'active' : ''}`} id="s-print" data-screen-label="07 Print">
      {/*
      <PageHeader
        step="Step 6 of 6"
        title="Review & Print"
        subtitle="Looking good? Confirm your print."
        pills={['done', 'done', 'done', 'done', 'done', 'active']}
      />
      */}

      <div className="print-body">
        <div className="print-preview-panel">
          {testModeEnabled && (
            <div className="print-test-badge">TEST MODE</div>
          )}
          <div className="print-preview-label">Final preview</div>
          <div className="print-frame-box" id="print-frame-box">
            <LayoutPreview
              layout={layout}
              shots={shots}
              templateSrc={versionTemplateAssetSrc(template?.overlaySrc || template?.src, template)}
              templateAlt={template?.name}
              className="print-frame-wrap"
              cellClassName="print-frame-cell"
              overlayClassName="tmpl-bg"
              photoFilter={selectedFilterCss}
            />
          </div>
          
        </div>

        <div className="print-sidebar">
          <div className="print-brand-lockup" aria-label="Afterimage">
            <img className="print-brand-mark" src={logoBlack} alt="" aria-hidden="true" />
            <img className="print-brand-wordmark" src={typoBlack} alt="Afterimage" />
          </div>

          {softcopyIsBusy && (
            <div className="softcopy-qr-card">
              <div className="softcopy-spinner" aria-hidden="true" />
              <h3>{softcopyIsUploading ? 'Uploading softcopy...' : 'Generating QR Code...'}</h3>
              <p>{softcopyIsUploading ? 'Please wait while your enabled media is uploaded.' : 'Please wait while your softcopy media is prepared.'}</p>
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
                <p><strong>Some softcopy outputs could not be generated.</strong></p>
                <p>{softcopyWarnings.join(' ')}</p>
              </div>
            </div>
          )}

          {softcopyIsReady && (
            <div className="softcopy-qr-card">
              <QRCodeCanvas value={softcopy.qrUrl} size={240} includeMargin />
              <h3>Scan to get your photo, GIF, and video</h3>
              <p>This link expires in 6 hours.</p>
            </div>
          )}

          {softcopyIsError && (
            <div className="softcopy-qr-card softcopy-qr-card--error">
              <h3>Softcopy upload failed</h3>
              <p>{softcopyErrorMessage}</p>
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

          <div className="print-sidebar-title">Print Options</div>

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

          <div className="print-actions">
            <button
              className="btn-print"
              onClick={printCompleted ? (finishReady ? onPrint : undefined) : handlePrintClick}
              disabled={printing || softcopyIsBusy || uploadRetrying || !printEnabled || (printCompleted && !finishReady)}
            >
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
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
          </div>
        </div>
      </div>
    </div>
  );
}
