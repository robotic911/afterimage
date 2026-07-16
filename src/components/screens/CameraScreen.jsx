import { useEffect, useRef, useState } from 'react';
import './CameraScreen.css';
import { useCamera } from '../../hooks/useCamera';
import { FILTERS } from '../../constants/filters';
import { getBeautificationFilterCss } from '../../constants/beautificationSettings';
import { MIRROR_CAMERA_OUTPUT } from '../../constants/cameraSettings';
import { getCameraDrawRect } from '../../lib/cameraFraming';
import { saveShots } from '../../lib/shotStorage';
import {
  canvasToPngDataUrl,
  getShotImageSource,
  inspectDataUrl,
  testImageLoad,
} from '../../lib/shotImageSource';

const CAPTURE_SCALE = 2;
const CAPTURE_MIME = 'image/png';
const CAPTURE_JPEG_QUALITY = 0.98;
const IS_DEV = import.meta.env.DEV;

/**
 * Auto-runs the shooting sequence once the user clicks "Start Session".
 * Captures `totalShots` frames separated by the configurable countdown,
 * then calls onDone(shots). `totalShots` comes from the chosen layout
 * (varies between 2 and 4 depending on the photo arrangement).
 */
export default function CameraScreen({
  active,
  layout,
  countdown,
  totalShots = 4,
  shots,
  setShots,
  selectedFilter = 'none',
  selectedFilterCss = '',
  onSelectFilter,
  beautificationSettings,
  beautificationPreviewCss = '',
  recordVideo = true,
  retakeQueue = [],
  onFlash,
  onDone,
  onBack,
}) {
  const cameraWidth = layout?.camera?.width;
  const cameraHeight = layout?.camera?.height;
  const isPortraitCamera = Number(cameraHeight) > Number(cameraWidth);
  const shotRatio = `${cameraWidth} / ${cameraHeight}`;
  const cameraRatio = `${cameraWidth} / ${cameraHeight}`;
  const { videoRef, hasSignal, cameraError, retryCamera } = useCamera(active, cameraWidth, cameraHeight);
  const [shotIndex, setShotIndex] = useState(shots.length);
  const [counting, setCounting] = useState(false);
  const [displayDigit, setDisplayDigit] = useState(countdown);
  const [showCountdown, setShowCountdown] = useState(false);
  const [countdownCycleKey, setCountdownCycleKey] = useState(0);
  const [captureLabel, setCaptureLabel] = useState(null);
  const [previewSize, setPreviewSize] = useState({ width: 0, height: 0 });
  const safeRetakeQueue = retakeQueue.filter((shotIndex) => (
    Number.isInteger(shotIndex) && shotIndex >= 0 && shotIndex < totalShots
  ));
  const isRetakingShot = safeRetakeQueue.length > 0;
  const activeRetakeShotIndex = isRetakingShot ? safeRetakeQueue[0] : null;

  const cntIntervalRef = useRef(null);
  const nextShotTimerRef = useRef(null);
  const finishTimerRef = useRef(null);
  const previewAreaRef = useRef(null);
  const shotVideoRecorderRef = useRef(null);
  const shotVideoClipsRef = useRef([]);
  const previewLogKeyRef = useRef('');
  const currentRetakePositionRef = useRef(0);
  const [currentRetakePosition, setCurrentRetakePosition] = useState(0);
  const livePhotoFilter = [beautificationPreviewCss, selectedFilterCss].filter(Boolean).join(' ');
  const captureBeautificationCss = getBeautificationFilterCss(
    beautificationSettings,
    { pixelScale: CAPTURE_SCALE },
  );

  // captureShot / shootNext fire from setTimeouts scheduled on earlier renders,
  // so `shots` in their closures is stale. We keep a ref mirrored to the latest
  // shots array and use that when composing the next update — otherwise each
  // capture would overwrite earlier ones.
  const shotsRef = useRef(shots);
  useEffect(() => { shotsRef.current = shots; }, [shots]);

  // Reset when the screen becomes active with a fresh set
  useEffect(() => {
    let cancelled = false;
    if (active) {
      queueMicrotask(() => {
        if (cancelled) return;
        currentRetakePositionRef.current = 0;
        setCurrentRetakePosition(0);
        setShotIndex(isRetakingShot ? activeRetakeShotIndex : shots.length);
        setCounting(false);
        setShowCountdown(false);
        setCaptureLabel(null);
      });
    }
    // cleanup any running interval when leaving
    return () => {
      cancelled = true;
      if (cntIntervalRef.current) {
        clearInterval(cntIntervalRef.current);
        cntIntervalRef.current = null;
      }
      if (nextShotTimerRef.current) {
        clearTimeout(nextShotTimerRef.current);
        nextShotTimerRef.current = null;
      }
      if (finishTimerRef.current) {
        clearTimeout(finishTimerRef.current);
        finishTimerRef.current = null;
      }
      if (shotVideoRecorderRef.current) {
        shotVideoRecorderRef.current.stop()
          .catch((error) => console.warn('[video] cleanup stop failed:', error));
        shotVideoRecorderRef.current = null;
      }
    };
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps

  // Persist the in-progress shot set to localStorage so a page refresh or
  // navigation away doesn't lose captures. App.jsx rehydrates from the same key
  // on boot, and EndScreen's onReturn handler clears it.
  useEffect(() => {
    saveShots(shots);
  }, [shots]);

  // Captured-photo ratio comes from layout.camera.
  // Final print placement comes from layout.canvas + layout.slots.
  // Do not use hardcoded 4/3 for captured-photo displays.
  useEffect(() => {
    if (!active || (cameraWidth && cameraHeight)) return;
    console.error('CameraScreen: missing layout.camera for layout.', {
      layoutId: layout?.id,
    });
  }, [active, cameraHeight, cameraWidth, layout?.id]);

  const cameraAspect = cameraWidth / cameraHeight;

  useEffect(() => {
    if (!active || !cameraWidth || !cameraHeight) return undefined;
    const el = previewAreaRef.current;
    if (!el) return undefined;

    const fitInside = (containerW, containerH, aspect) => {
      if (!containerW || !containerH || !aspect) {
        return { width: 0, height: 0 };
      }

      let width = containerW;
      let height = width / aspect;

      if (height > containerH) {
        height = containerH;
        width = height * aspect;
      }

      return {
        width: Math.floor(width),
        height: Math.floor(height),
      };
    };

    const update = () => {
      const rect = el.getBoundingClientRect();
      const nextSize = fitInside(rect.width, rect.height, cameraAspect);
      setPreviewSize((current) => (
        current.width === nextSize.width && current.height === nextSize.height
          ? current
          : nextSize
      ));
    };

    update();

    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [active, cameraAspect, cameraHeight, cameraWidth]);

  useEffect(() => {
    if (!IS_DEV || !active || !hasSignal || !previewSize.width || !previewSize.height) {
      return undefined;
    }

    const video = videoRef.current;
    if (!video) return undefined;

    const logPreviewFraming = () => {
      const videoWidth = video.videoWidth;
      const videoHeight = video.videoHeight;
      if (!videoWidth || !videoHeight) return;

      const framing = layout?.cameraFraming || {};
      const drawRect = getCameraDrawRect({
        sourceWidth: videoWidth,
        sourceHeight: videoHeight,
        targetWidth: previewSize.width,
        targetHeight: previewSize.height,
        framing,
      });
      const logKey = [
        layout?.id,
        videoWidth,
        videoHeight,
        previewSize.width,
        previewSize.height,
        framing.fitMode,
        framing.zoom,
        framing.offsetX,
        framing.offsetY,
      ].join(':');
      if (previewLogKeyRef.current === logKey) return;
      previewLogKeyRef.current = logKey;

      console.log('[camera-preview]', {
        containerWidth: previewSize.width,
        containerHeight: previewSize.height,
        containerAspect: drawRect.targetAspect,
        objectFit: 'height-locked',
        cssObjectFit: getComputedStyle(video).objectFit || 'none',
        zoom: Number(framing.zoom) || 1,
        offsetX: Number(framing.offsetX) || 0,
        offsetY: Number(framing.offsetY) || 0,
        sourceWidth: videoWidth,
        sourceHeight: videoHeight,
        sourceAspect: drawRect.sourceAspect,
        drawWidth: drawRect.drawWidth,
        drawHeight: drawRect.drawHeight,
        drawX: drawRect.drawX,
        drawY: drawRect.drawY,
      });
      console.log('[mirror] live preview', {
        mirrored: MIRROR_CAMERA_OUTPUT,
        method: 'css',
      });
    };

    logPreviewFraming();
    video.addEventListener('loadedmetadata', logPreviewFraming);
    return () => video.removeEventListener('loadedmetadata', logPreviewFraming);
  }, [
    active,
    hasSignal,
    layout?.cameraFraming,
    layout?.id,
    previewSize.height,
    previewSize.width,
    videoRef,
  ]);

  if (!cameraWidth || !cameraHeight) {
    return (
      <div
        className={`screen ${active ? 'active' : ''} ${isPortraitCamera ? 'camera-screen--portrait' : 'camera-screen--landscape'}`}
        id="s-camera"
        data-screen-label="04 Camera"
      >
        <div className="cam-topbar">
          <div className="cam-live"><div className="live-dot" />Camera Live</div>
        </div>
        <div className={`cam-main ${isPortraitCamera ? 'cam-main--portrait' : 'cam-main--landscape'}`}>
          <div className="camera-preview-area">
            <div className="cam-no-signal">
              Camera sizing is unavailable for this layout. Please ask the admin to verify the layout camera settings.
            </div>
          </div>
        </div>
      </div>
    );
  }

  async function finishSession(newShots) {
    finishTimerRef.current = setTimeout(() => {
      finishTimerRef.current = null;
      onDone(newShots, { shotVideoClips: shotVideoClipsRef.current.filter(Boolean) });
    }, 300);
  }

  async function stopShotClip(shotIndex) {
    const recorder = shotVideoRecorderRef.current;
    shotVideoRecorderRef.current = null;
    if (!recorder) return;

    try {
      const clip = await recorder.stop();
      const nextClips = [...shotVideoClipsRef.current];
      nextClips[shotIndex] = clip;
      shotVideoClipsRef.current = nextClips;
    } catch (error) {
      console.warn('[video] shot clip recording stop failed:', error);
    }
  }

  async function captureShot(nextIndex) {
    if (IS_DEV) {
      console.log('[filter] applying to capture', {
        selectedFilter: selectedFilter || 'none',
        shotIndex: nextIndex,
        layoutId: layout?.id || null,
      });
    }
    // flash
    onFlash();

    const video = videoRef.current;
    if (IS_DEV && isRetakingShot) {
      console.log('[retake-flow] replacing photo', {
        activeRetakeIndex: nextIndex,
      });
    }
    const baseCameraWidth = cameraWidth;
    const baseCameraHeight = cameraHeight;
    const canvas = document.createElement('canvas');
    const outputWidth = Math.round(baseCameraWidth * CAPTURE_SCALE);
    const outputHeight = Math.round(baseCameraHeight * CAPTURE_SCALE);
    canvas.width = outputWidth;
    canvas.height = outputHeight;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    if (video && video.srcObject && video.readyState >= 2) {
      // Match the CSS height-locked preview: use the full source and let the
      // destination width overflow or pad while the canvas clips its bounds.
      const vw = video.videoWidth || cameraWidth;
      const vh = video.videoHeight || cameraHeight;
      const drawRect = getCameraDrawRect({
        sourceWidth: vw,
        sourceHeight: vh,
        targetWidth: outputWidth,
        targetHeight: outputHeight,
        framing: layout?.cameraFraming,
      });
      const {
        sourceX,
        sourceY,
        sourceWidth,
        sourceHeight,
        sourceAspect,
        targetAspect,
        drawX,
        drawY,
        drawWidth,
        drawHeight,
        fitMode,
      } = drawRect;

      if (IS_DEV) {
        console.log('[capture-crop]', {
          sourceWidth,
          sourceHeight,
          sourceAspect,
          targetWidth: outputWidth,
          targetHeight: outputHeight,
          targetAspect,
          cropX: sourceX,
          cropY: sourceY,
          cropWidth: sourceWidth,
          cropHeight: sourceHeight,
          drawX,
          drawY,
          drawWidth,
          drawHeight,
          zoom: Number(layout?.cameraFraming?.zoom) || 1,
          offsetX: Number(layout?.cameraFraming?.offsetX) || 0,
          offsetY: Number(layout?.cameraFraming?.offsetY) || 0,
          fullSourceHeightVisible: drawRect.fullSourceHeightVisible,
        });
        console.log('[capture] framing mode', fitMode);
      }

      ctx.fillStyle = '#0a0a0a';
      ctx.fillRect(0, 0, outputWidth, outputHeight);
      if (captureBeautificationCss) ctx.filter = captureBeautificationCss;
      if (IS_DEV) {
        console.log('[mirror] capture output', {
          mirrorApplied: MIRROR_CAMERA_OUTPUT,
          sourceWidth,
          sourceHeight,
          targetWidth: outputWidth,
          targetHeight: outputHeight,
        });
      }
      if (MIRROR_CAMERA_OUTPUT) {
        ctx.save();
        ctx.translate(outputWidth, 0);
        ctx.scale(-1, 1);
      }
      ctx.drawImage(
        video,
        sourceX,
        sourceY,
        sourceWidth,
        sourceHeight,
        drawX,
        drawY,
        drawWidth,
        drawHeight,
      );
      if (MIRROR_CAMERA_OUTPUT) {
        ctx.restore();
      }
      ctx.filter = 'none';
    } else {
      // fallback placeholder when no camera signal
      ctx.fillStyle = '#f4f4f4';
      ctx.fillRect(0, 0, outputWidth, outputHeight);
      ctx.fillStyle = '#000000';
      ctx.font = `bold ${36 * CAPTURE_SCALE}px Inter,sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText('AFTERIMAGE', outputWidth / 2, (outputHeight / 2) - (20 * CAPTURE_SCALE));
      ctx.font = `500 ${20 * CAPTURE_SCALE}px Inter,sans-serif`;
      ctx.fillStyle = '#666666';
      ctx.fillText('Shot ' + (nextIndex + 1), outputWidth / 2, (outputHeight / 2) + (20 * CAPTURE_SCALE));

      if (IS_DEV) {
        console.log('[capture] fallback output', {
          layoutId: layout.id,
          captureScale: CAPTURE_SCALE,
          outputWidth: canvas.width,
          outputHeight: canvas.height,
          mime: CAPTURE_MIME,
        });
      }
    }

    const dataUrl = CAPTURE_MIME === 'image/jpeg'
      ? canvas.toDataURL(CAPTURE_MIME, CAPTURE_JPEG_QUALITY)
      : await canvasToPngDataUrl(canvas);
    if (IS_DEV) console.log('[CAPTURE DATA URL CREATED]', inspectDataUrl(dataUrl));
    if (IS_DEV) {
      console.log('[capture-resolution] captured photo', {
        shotIndex: nextIndex,
        width: outputWidth,
        height: outputHeight,
        aspectRatio: outputWidth / outputHeight,
        bytesOrLength: dataUrl.length,
        sourceType: CAPTURE_MIME,
      });
      console.log('[CAPTURE CANVAS AUDIT]', {
        canvasWidth: canvas.width,
        canvasHeight: canvas.height,
        videoWidth: video?.videoWidth || null,
        videoHeight: video?.videoHeight || null,
        dataUrlLength: dataUrl.length,
      });
    }
    if (IS_DEV) {
      const canDecode = await testImageLoad(dataUrl, 'CAPTURE BLOB DATA URL');
      if (!canDecode) {
        throw new Error('Captured data URL failed to decode immediately after capture');
      }
    }
    canvas.width = 0;
    canvas.height = 0;
    await stopShotClip(nextIndex);
    // Use shotsRef.current instead of the captured-closure `shots` —
    // otherwise sequential captures overwrite each other because this
    // function was defined on an earlier render.
    const newShots = [...shotsRef.current];
    newShots[nextIndex] = dataUrl;
    if (IS_DEV) {
      console.log('[PHOTO AUDIT capture] new shot', {
        type: typeof dataUrl,
        isString: typeof dataUrl === 'string',
        prefix: typeof dataUrl === 'string' ? dataUrl.slice(0, 100) : null,
        keys: dataUrl && typeof dataUrl === 'object' ? Object.keys(dataUrl) : null,
      });
      console.log('[DATA URL AUDIT capture]', inspectDataUrl(dataUrl));
    }
    shotsRef.current = newShots;
    setShots(newShots);
    const newIndex = nextIndex + 1;
    setShotIndex(newIndex);

    if (isRetakingShot) {
      const queuePosition = currentRetakePositionRef.current;
      setCaptureLabel(`✓ Photo ${nextIndex + 1} retaken!`);
      if (queuePosition < safeRetakeQueue.length - 1) {
        const nextPosition = queuePosition + 1;
        const nextRetakeIndex = safeRetakeQueue[nextPosition];
        currentRetakePositionRef.current = nextPosition;
        setCurrentRetakePosition(nextPosition);
        setShotIndex(nextRetakeIndex);
        nextShotTimerRef.current = setTimeout(() => {
          nextShotTimerRef.current = null;
          shootNext(nextRetakeIndex);
        }, 700);
      } else {
        finishSession(newShots);
      }
    } else if (newIndex >= totalShots) {
      setCaptureLabel('✓ All shots taken!');
      finishSession(newShots);
    } else {
      nextShotTimerRef.current = setTimeout(() => {
        nextShotTimerRef.current = null;
        shootNext(newIndex);
      }, 600);
    }
  }

  async function shootNext(idx = shotIndex) {
    if (idx >= totalShots) return;
    if (isRetakingShot) {
      console.log('[retake] capturing replacement', {
        photoIndex: idx,
        queuePosition: currentRetakePositionRef.current + 1,
        totalSelected: safeRetakeQueue.length,
      });
    }
    if (recordVideo && !shotVideoRecorderRef.current) {
      try {
        const { startShotClipRecording } = await import('../../lib/sessionVideoRecorder');
        shotVideoRecorderRef.current = await startShotClipRecording({
          layout,
          video: videoRef.current,
          shotIndex: idx,
          durationTargetMs: countdown * 1000,
          photoFilter: beautificationPreviewCss,
        });
      } catch (error) {
        console.warn('[video] shot clip recording start failed:', error);
      }
    }
    let t = countdown;
    setShowCountdown(true);
    setDisplayDigit(t);
    setCountdownCycleKey(k => k + 1);

    cntIntervalRef.current = setInterval(() => {
      t -= 1;
      if (t > 0) {
        setDisplayDigit(t);
      } else {
        clearInterval(cntIntervalRef.current);
        cntIntervalRef.current = null;
        setShowCountdown(false);
        captureShot(idx);
      }
    }, 1000);
  }

  async function startSession() {
    if (cntIntervalRef.current) return;
    setCounting(true);
    setCaptureLabel(null);
    shotVideoClipsRef.current = [];
    currentRetakePositionRef.current = 0;
    setCurrentRetakePosition(0);
    shootNext(isRetakingShot ? activeRetakeShotIndex : shotIndex);
  }

  const hasCapturedShots = shots.some(Boolean);
  const showStartOverlay = active && hasSignal && !counting && !showCountdown && (
    isRetakingShot || (shotIndex === 0 && !hasCapturedShots)
  );
  const showCameraRecovery = Boolean(cameraError);
  const showNoSignalPlaceholder = active && !hasSignal && !cameraError;
  const filterLocked = counting || showCountdown || shotIndex > 0 || hasCapturedShots;
  const cameraRecoveryMessage = cameraError || 'Camera preview will appear here';
  const retakeProgressLabel = isRetakingShot
    ? `${currentRetakePosition + 1} of ${safeRetakeQueue.length} retake${safeRetakeQueue.length === 1 ? '' : 's'}`
    : null;
  const cameraInstruction = showStartOverlay
    ? (isRetakingShot ? `Retaking Photo ${activeRetakeShotIndex + 1}` : 'Look at the camera, then tap Start')
    : showCountdown
      ? (isRetakingShot ? `Retaking Photo ${shotIndex + 1} — Look at the camera` : 'Look at the camera')
      : counting
        ? (isRetakingShot ? `Retaking Photo ${shotIndex + 1} — Look at the camera` : `Photo ${Math.min(shotIndex + 1, totalShots)} of ${totalShots}`)
        : 'Get ready for your photos';

  function auditCapturedPreview(event, index) {
    if (!IS_DEV) return;

    const image = event.currentTarget;
    const preview = image.parentElement;
    const previewRect = preview?.getBoundingClientRect();
    const imageAspect = image.naturalWidth / image.naturalHeight;
    const previewAspect = previewRect?.width && previewRect?.height
      ? previewRect.width / previewRect.height
      : null;
    const objectFit = getComputedStyle(image).objectFit;

    console.log('[captured-preview]', {
      imageWidth: image.naturalWidth,
      imageHeight: image.naturalHeight,
      imageAspect,
      displayContainerWidth: previewRect?.width || null,
      displayContainerHeight: previewRect?.height || null,
      displayContainerAspect: previewAspect,
      objectFit,
      sourceUsed: 'full captured data URL',
      layoutId: layout.id,
      shotIndex: index,
      preservesAspectRatio: objectFit === 'cover' || objectFit === 'contain'
        || (previewAspect !== null && Math.abs(imageAspect - previewAspect) < 0.001),
    });
  }

  return (
    <div
      className={`screen ${active ? 'active' : ''} ${isPortraitCamera ? 'camera-screen--portrait' : 'camera-screen--landscape'}`}
      id="s-camera"
      data-screen-label="04 Camera"
    >
      {/* Top bar */}
      <div className="cam-topbar">
        <div className="cam-live">
          <div className="live-dot" />
          <span>{cameraInstruction}</span>
          {retakeProgressLabel && <small>{retakeProgressLabel}</small>}
        </div>
      </div>

      {/* Full preview area */}
      <div className={`cam-main ${isPortraitCamera ? 'cam-main--portrait' : 'cam-main--landscape'}`}>
        <aside className={`camera-filter-panel ${filterLocked ? 'is-locked' : ''}`}>
          <div className="camera-filter-heading">
            <strong>Choose Filter</strong>
            <span>{filterLocked ? 'Filter locked while taking photos' : 'Pick a photo look before we start'}</span>
          </div>
          <div
            className="camera-filter-grid"
            role="group"
            aria-label="Choose Filter"
            style={{ '--filter-count': FILTERS.length }}
          >
            {FILTERS.map((filter) => {
              const isSelected = selectedFilter === filter.id;
              return (
                <button
                  key={filter.id}
                  type="button"
                  className={`camera-filter-option ${isSelected ? 'is-selected' : ''}`}
                  onClick={() => onSelectFilter?.(filter.id)}
                  disabled={filterLocked}
                  aria-pressed={isSelected}
                >
                  <span
                    className="camera-filter-swatch"
                    style={{ background: filter.bg, filter: filter.css || 'none' }}
                    aria-hidden="true"
                  />
                  <span className="camera-filter-copy">
                    <span className="camera-filter-name">{filter.name}</span>
                    <span className="camera-filter-desc">{filter.desc}</span>
                  </span>
                  <span className="camera-filter-check" aria-hidden="true">✓</span>
                </button>
              );
            })}
          </div>
        </aside>

        <div ref={previewAreaRef} className="camera-preview-area">
          <div
            className="cam-viewport camera-preview-frame"
            style={{
              aspectRatio: cameraRatio,
              '--camera-ratio': cameraRatio,
              '--shot-ratio': shotRatio,
              '--shot-count': totalShots,
              width: previewSize.width ? `${previewSize.width}px` : undefined,
              height: previewSize.height ? `${previewSize.height}px` : undefined,
            }}
          >
            <video
              id="camera-video"
              ref={videoRef}
              autoPlay
              playsInline
              muted
              style={livePhotoFilter ? { filter: livePhotoFilter } : undefined}
            />
            {showCameraRecovery && (
              <div className="cam-no-signal" id="cam-placeholder">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1">
                  <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                  <circle cx="12" cy="13" r="4" />
                </svg>
                <p>{cameraRecoveryMessage}</p>
                <div className="camera-error-actions">
                  <button type="button" className="camera-error-btn" onClick={retryCamera}>Retry Camera</button>
                  {onBack && <button type="button" className="camera-error-btn" onClick={onBack}>Return</button>}
                </div>
              </div>
            )}
            {showNoSignalPlaceholder && (
              <div className="cam-no-signal" id="cam-placeholder">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1">
                  <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                  <circle cx="12" cy="13" r="4" />
                </svg>
                <p>Camera preview will appear here</p>
              </div>
            )}
            {showStartOverlay && (
              <button
                type="button"
                className="camera-start-overlay"
                onClick={startSession}
              >
                {isRetakingShot ? `Retake Photo ${activeRetakeShotIndex + 1}` : 'Start Photos'}
              </button>
            )}
            {captureLabel && <div className="camera-capture-status">{captureLabel}</div>}
            <div className={`countdown-wrap ${showCountdown ? 'is-visible' : ''}`} id="countdown-wrap">
              <div
                key={countdownCycleKey}
                className="countdown-ring"
                style={{ '--countdown-duration': `${Math.max(1, Number(countdown) || 1) * 1000}ms` }}
              >
                <svg viewBox="0 0 120 120" className="countdown-svg" aria-hidden="true">
                  <circle className="countdown-ring-bg" cx="60" cy="60" r="54" />
                  <circle className="countdown-ring-progress" cx="60" cy="60" r="54" />
                </svg>
                <div className="countdown-digit" id="countdown-digit">
                  {displayDigit}
                </div>
              </div>
            </div>
          </div>
        </div>

        <div
          className="camera-bottom-strip camera-side-strip"
          id="thumb-row"
          style={{
            '--shot-ratio': shotRatio,
            '--shot-count': totalShots,
          }}
        >
          {Array.from({ length: totalShots }).map((_, i) => {
            const imageSrc = getShotImageSource(shots[i]);
            return (
              <div key={i} className="camera-bottom-thumb-cell camera-side-thumb-cell">
                <div
                  id={`th-${i}`}
                  className={`thumb-slot ${shots[i] ? 'is-filled' : 'is-empty'} ${i === shotIndex && shotIndex < totalShots ? 'is-current' : ''} ${isRetakingShot && safeRetakeQueue.includes(i) ? 'is-retake-target' : ''}`}
                >
                  {imageSrc
                    ? (
                      <img
                        src={imageSrc}
                        alt={`Shot ${i + 1}`}
                        decoding="async"
                        style={selectedFilterCss ? { filter: selectedFilterCss } : undefined}
                        onLoad={(event) => auditCapturedPreview(event, i)}
                      />
                    )
                    : <span>{shots[i] ? 'Missing' : i + 1}</span>
                  }
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
