// Tiny wrapper around localStorage for the in-progress photobooth session.
// A full captured set is well under localStorage's ~5MB cap,
// so this is plenty for one session without needing IndexedDB or a DB.
// If/when we want to keep a permanent archive of past sessions, the right next
// step is writing real JPEG files to disk via Electron's `fs` module.
import { inspectDataUrl } from './shotImageSource';

const KEY = 'kuku.photobooth.shots';
const IS_DEV = import.meta.env.DEV;
let pendingSaveHandle = null;
let pendingUsesIdleCallback = false;
let pendingShots = null;

function cancelPendingSave() {
  if (!pendingSaveHandle) return;
  if (pendingUsesIdleCallback && typeof window !== 'undefined' && window.cancelIdleCallback) {
    window.cancelIdleCallback(pendingSaveHandle);
  } else {
    clearTimeout(pendingSaveHandle);
  }
  pendingSaveHandle = null;
  pendingUsesIdleCallback = false;
}

function scheduleStorageWrite(callback) {
  if (typeof window !== 'undefined' && window.requestIdleCallback) {
    pendingUsesIdleCallback = true;
    pendingSaveHandle = window.requestIdleCallback(callback, { timeout: 1500 });
    return;
  }
  pendingUsesIdleCallback = false;
  pendingSaveHandle = setTimeout(callback, 250);
}

export function loadShots() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (IS_DEV && Array.isArray(parsed)) {
      console.log('[DATA URL AUDIT shotStorage load first]', inspectDataUrl(parsed[0]));
    }
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveShots(shots) {
  cancelPendingSave();
  if (!shots || shots.length === 0) {
    pendingShots = null;
    try {
      localStorage.removeItem(KEY);
    } catch {
      // Ignore storage failures; the live session state remains authoritative.
    }
    return;
  }

  pendingShots = [...shots];
  scheduleStorageWrite(() => {
    const snapshot = pendingShots;
    pendingSaveHandle = null;
    pendingUsesIdleCallback = false;
    pendingShots = null;
    try {
      const serialized = JSON.stringify(snapshot);
      localStorage.setItem(KEY, serialized);
      if (IS_DEV) {
        console.log('[DATA URL AUDIT shotStorage save]', {
          shotCount: snapshot.length,
          serializedLength: serialized.length,
          firstShot: inspectDataUrl(snapshot[0]),
        });
      }
    } catch (err) {
      // Quota errors are the realistic failure mode — drop silently so the UI keeps working.
      console.warn('[shotStorage] failed to persist shots:', err);
    }
  });
}

export function clearShots() {
  cancelPendingSave();
  pendingShots = null;
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}
