import { useCallback, useEffect, useRef, useState } from 'react';

const IS_DEV = import.meta.env.DEV;
const WIDESCREEN_ASPECT_RATIO = 16 / 9;
const CAMERA_QUALITY_PROFILES = [
  { label: '4k-24', width: 3840, height: 2160, frameRate: 24 },
  { label: '1440p-30', width: 2560, height: 1440, frameRate: 30 },
  { label: '1440p-24', width: 2560, height: 1440, frameRate: 24 },
  { label: '1080p-30', width: 1920, height: 1080, frameRate: 30 },
];
let cachedPreferredCameraDeviceId = null;

function formatCameraError(error) {
  const name = String(error?.name || '').toLowerCase();
  const message = String(error?.message || '').toLowerCase();
  if (name.includes('notallowed') || name.includes('permissiondenied') || message.includes('permission')) {
    return 'Camera access was blocked. Please allow camera access.';
  }
  if (name.includes('notfound')) {
    return 'No camera was detected.';
  }
  if (name.includes('overconstrained') || name.includes('constraintsnotsatisfied')) {
    return 'The selected camera is unavailable.';
  }
  if (name.includes('notreadable') || name.includes('abort')) {
    return 'Camera unavailable. Please retry.';
  }
  return 'Camera unavailable. Please retry.';
}

async function applyWidestSupportedFieldOfView(track) {
  const capabilities = track?.getCapabilities?.();
  const minimumZoom = Number(capabilities?.zoom?.min);

  if (!Number.isFinite(minimumZoom) || !track?.applyConstraints) {
    return { supported: false, minimumZoom: null };
  }

  try {
    await track.applyConstraints({ advanced: [{ zoom: minimumZoom }] });
    return {
      supported: true,
      minimumZoom,
      appliedZoom: track.getSettings?.().zoom ?? minimumZoom,
    };
  } catch (error) {
    if (IS_DEV) {
      console.warn('[camera] unable to apply widest supported field of view', error);
    }
    return { supported: true, minimumZoom, error: error?.message || String(error) };
  }
}

/**
 * Starts and stops a video stream on the given video element whenever
 * the `active` flag changes. layout.camera stays a design ratio; this
 * hook asks the webcam for the best available source stream for capture.
 */
export function useCamera(active, preferredWidth, preferredHeight) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const trackCleanupRef = useRef(null);
  const [hasSignal, setHasSignal] = useState(false);
  const [cameraError, setCameraError] = useState(null);
  const [deviceRefreshKey, setDeviceRefreshKey] = useState(0);

  const retryCamera = useCallback(() => {
    setCameraError(null);
    setDeviceRefreshKey((key) => key + 1);
  }, []);

  useEffect(() => {
    if (!navigator.mediaDevices?.addEventListener) return undefined;

    const handleDeviceChange = () => {
      setDeviceRefreshKey(key => key + 1);
    };

    navigator.mediaDevices.addEventListener('devicechange', handleDeviceChange);

    return () => {
      navigator.mediaDevices.removeEventListener('devicechange', handleDeviceChange);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const stop = () => {
      if (trackCleanupRef.current) {
        trackCleanupRef.current();
        trackCleanupRef.current = null;
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop());
        streamRef.current = null;
      }
      setHasSignal(false);
    };

    const buildConstraints = (profile, deviceId) => ({
      video: {
        width: { ideal: profile.width },
        height: { ideal: profile.height },
        aspectRatio: { ideal: WIDESCREEN_ASPECT_RATIO },
        frameRate: { ideal: profile.frameRate },
        resizeMode: { ideal: 'none' },
        zoom: { ideal: 1 },
        facingMode: 'user',
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      },
      audio: false,
    });

    const openBestStream = async (deviceId) => {
      let lastError = null;

      for (const profile of CAMERA_QUALITY_PROFILES) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia(
            buildConstraints(profile, deviceId),
          );
          return { stream, profile };
        } catch (error) {
          lastError = error;
          if (IS_DEV) console.warn(`[camera] ${profile.label} stream unavailable, trying fallback.`, error);
        }
      }

      throw lastError || new Error('No camera stream profile was available');
    };

    const findPreferredCamera = async () => {
      if (!navigator.mediaDevices?.enumerateDevices) return null;

      const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
      if (cachedPreferredCameraDeviceId) {
        const cached = devices.find(
          (device) => device.kind === 'videoinput' && device.deviceId === cachedPreferredCameraDeviceId,
        );
        if (cached) return cached;
      }
      return devices.find(
        (device) =>
          device.kind === 'videoinput' &&
          /insta\s*360|insta360/i.test(device.label || ''),
      ) || null;
    };

    const attachStream = async (stream, preferredDevice, requestedProfile) => {
      if (cancelled) {
        stream.getTracks().forEach(t => t.stop());
        return;
      }

      streamRef.current = stream;
      if (videoRef.current) videoRef.current.srcObject = stream;
      const track = stream.getVideoTracks()[0];
      const fieldOfView = await applyWidestSupportedFieldOfView(track);
      if (cancelled) {
        stream.getTracks().forEach(t => t.stop());
        return;
      }
      const handleTrackEnded = () => {
        if (!cancelled) {
          setHasSignal(false);
          setCameraError('Camera disconnected.');
        }
      };
      track?.addEventListener?.('ended', handleTrackEnded);
      trackCleanupRef.current = () => {
        track?.removeEventListener?.('ended', handleTrackEnded);
      };
      const settings = track?.getSettings?.();
      const streamWidth = settings?.width || null;
      const streamHeight = settings?.height || null;
      if (IS_DEV) {
        console.log('[camera] selected settings', settings);
        console.log('[camera] stream selection', {
          requestedProfile,
          selectedDevice: preferredDevice
            ? { label: preferredDevice.label, deviceId: preferredDevice.deviceId }
            : null,
          layoutCamera: preferredWidth && preferredHeight
            ? { width: preferredWidth, height: preferredHeight }
            : null,
          fieldOfView,
          streamWidth,
          streamHeight,
          streamFrameRate: settings?.frameRate || null,
          streamAspectRatio: settings?.aspectRatio || (
            streamWidth && streamHeight ? streamWidth / streamHeight : null
          ),
        });
      }
      setCameraError(null);
      setHasSignal(true);
    };

    if (active) {
      (async () => {
        let preferredDevice = await findPreferredCamera();
        if (preferredDevice?.deviceId) {
          cachedPreferredCameraDeviceId = preferredDevice.deviceId;
          try {
            const { stream: preferredStream, profile: preferredProfile } =
              await openBestStream(preferredDevice.deviceId);
            await attachStream(preferredStream, preferredDevice, preferredProfile);
            return;
          } catch (error) {
            if (IS_DEV) console.warn('[camera] preferred camera open failed, falling back to default camera.', error);
          }
        }

        const { stream: bootstrapStream, profile: bootstrapProfile } = await openBestStream();
        if (cancelled) {
          bootstrapStream.getTracks().forEach(t => t.stop());
          return;
        }
          const bootstrapTrack = bootstrapStream.getVideoTracks()[0];
          const bootstrapSettings = bootstrapTrack?.getSettings?.();
          preferredDevice = await findPreferredCamera();

          if (
            preferredDevice &&
            preferredDevice.deviceId &&
            bootstrapSettings?.deviceId !== preferredDevice.deviceId
          ) {
            cachedPreferredCameraDeviceId = preferredDevice.deviceId;
            bootstrapStream.getTracks().forEach(t => t.stop());

            try {
              const { stream: preferredStream, profile: preferredProfile } =
                await openBestStream(preferredDevice.deviceId);
              await attachStream(preferredStream, preferredDevice, preferredProfile);
              return;
            } catch (error) {
              console.warn('[camera] preferred Insta360 open failed, falling back to default camera.', error);
            }
          }

          await attachStream(bootstrapStream, preferredDevice, bootstrapProfile);
      })()
        .catch((error) => {
          console.error('[camera] failed', error);
          setCameraError(formatCameraError(error));
          setHasSignal(false);
        });
    } else {
      stop();
      queueMicrotask(() => {
        setCameraError(null);
      });
    }

    return () => {
      cancelled = true;
      stop();
    };
  }, [active, preferredWidth, preferredHeight, deviceRefreshKey]);

  return { videoRef, hasSignal, cameraError, retryCamera };
}
