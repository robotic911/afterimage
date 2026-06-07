import { useEffect, useRef, useState } from 'react';
import './CameraScreen.css';
import { useCamera } from '../../hooks/useCamera';
import { saveShots } from '../../lib/shotStorage';

const CAPTURE_SCALE = 2;
const CAPTURE_MIME = 'image/png';
const CAPTURE_JPEG_QUALITY = 0.98;
const LANDSCAPE_THUMB_RAIL_RESERVED_PX = 520;
const PORTRAIT_THUMB_RAIL_RESERVED_PX = 360;
const IS_DEV = import.meta.env.DEV;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

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
  recordVideo = true,
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

  const cntIntervalRef = useRef(null);
  const nextShotTimerRef = useRef(null);
  const finishTimerRef = useRef(null);
  const previewAreaRef = useRef(null);
  const shotVideoRecorderRef = useRef(null);
  const shotVideoClipsRef = useRef([]);

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
        setShotIndex(shots.length);
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

      const reservedRailWidth = isPortraitCamera
        ? PORTRAIT_THUMB_RAIL_RESERVED_PX
        : LANDSCAPE_THUMB_RAIL_RESERVED_PX;
      const safeWidth = Math.max(0, containerW - reservedRailWidth);
      let width = safeWidth || containerW;
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
  }, [active, cameraAspect, cameraHeight, cameraWidth, isPortraitCamera]);

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
    // flash
    onFlash();

    const video = videoRef.current;
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
      // Match CSS object-fit: cover so preview and saved capture share the
      // same crop for the selected layout camera frame.
      const vw = video.videoWidth || cameraWidth;
      const vh = video.videoHeight || cameraHeight;
      const destAspect = cameraAspect;
      const srcAspect = vw / vh;

      let sx, sy, sw, sh;
      if (srcAspect > destAspect) {
        // Source is wider than the selected camera frame → crop left/right
        sh = vh;
        sw = vh * destAspect;
        sx = (vw - sw) / 2;
        sy = 0;
      } else {
        // Source is taller than the selected camera frame → crop top/bottom
        sw = vw;
        sh = vw / destAspect;
        sx = 0;
        sy = (vh - sh) / 2;
      }

      const framing = layout?.cameraFraming || {};
      const zoom = Math.max(1, Number(framing.zoom) || 1);
      const offsetX = clamp(Number(framing.offsetX) || 0, -0.5, 0.5);
      const offsetY = clamp(Number(framing.offsetY) || 0, -0.5, 0.5);
      const zoomedSw = sw / zoom;
      const zoomedSh = sh / zoom;

      sx += (sw - zoomedSw) / 2;
      sy += (sh - zoomedSh) / 2;
      sx += offsetX * zoomedSw;
      sy += offsetY * zoomedSh;
      sw = zoomedSw;
      sh = zoomedSh;
      sx = clamp(sx, 0, Math.max(0, vw - sw));
      sy = clamp(sy, 0, Math.max(0, vh - sh));

      if (IS_DEV) {
        console.log('[capture] output', {
          layoutId: layout.id,
          captureScale: CAPTURE_SCALE,
          outputWidth: canvas.width,
          outputHeight: canvas.height,
          mime: CAPTURE_MIME,
          videoWidth: vw,
          videoHeight: vh,
          framing: { zoom, offsetX, offsetY },
        });
      }

      // Mirror horizontally so the saved capture matches the preview
      // (which has `transform: scaleX(-1)` applied via CSS).
      ctx.translate(outputWidth, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(video, sx, sy, sw, sh, 0, 0, outputWidth, outputHeight);
      // Reset transform before any further draws.
      ctx.setTransform(1, 0, 0, 1, 0, 0);
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
      : canvas.toDataURL(CAPTURE_MIME);
    canvas.width = 0;
    canvas.height = 0;
    await stopShotClip(nextIndex);
    // Use shotsRef.current instead of the captured-closure `shots` —
    // otherwise sequential captures overwrite each other because this
    // function was defined on an earlier render.
    const newShots = [...shotsRef.current];
    newShots[nextIndex] = dataUrl;
    shotsRef.current = newShots;
    setShots(newShots);
    const newIndex = nextIndex + 1;
    setShotIndex(newIndex);

    if (newIndex >= totalShots) {
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
    if (recordVideo && !shotVideoRecorderRef.current) {
      try {
        const { startShotClipRecording } = await import('../../lib/sessionVideoRecorder');
        shotVideoRecorderRef.current = await startShotClipRecording({
          layout,
          video: videoRef.current,
          shotIndex: idx,
          durationTargetMs: countdown * 1000,
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
    shootNext(shotIndex);
  }

  const hasCapturedShots = shots.some(Boolean);
  const showStartOverlay = active && hasSignal && !counting && !showCountdown && shotIndex === 0 && !hasCapturedShots;
  const showCameraRecovery = Boolean(cameraError);
  const showNoSignalPlaceholder = active && !hasSignal && !cameraError;
  const cameraRecoveryMessage = cameraError || 'Camera preview will appear here';

  return (
    <div
      className={`screen ${active ? 'active' : ''} ${isPortraitCamera ? 'camera-screen--portrait' : 'camera-screen--landscape'}`}
      id="s-camera"
      data-screen-label="04 Camera"
    >
      {/* Top bar */}
      <div className="cam-topbar">
        <div className="cam-live"><div className="live-dot" />Camera Live</div>
      </div>

      {/* Full preview area */}
      <div className={`cam-main ${isPortraitCamera ? 'cam-main--portrait' : 'cam-main--landscape'}`}>
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
                Click here to start
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
          <div
            className="camera-bottom-strip camera-side-strip"
            id="thumb-row"
            style={{
              '--shot-ratio': shotRatio,
              '--shot-count': totalShots,
            }}
          >
            {Array.from({ length: totalShots }).map((_, i) => (
              <div key={i} className="camera-bottom-thumb-cell camera-side-thumb-cell">
                <div
                  id={`th-${i}`}
                  className={`thumb-slot ${shots[i] ? 'is-filled' : 'is-empty'} ${i === shotIndex && shotIndex < totalShots ? 'is-current' : ''}`}
                >
                  {shots[i]
                    ? <img src={shots[i]} alt={`Shot ${i + 1}`} />
                    : <span>{i + 1}</span>
                  }
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
