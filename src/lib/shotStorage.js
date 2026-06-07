// Tiny wrapper around localStorage for the in-progress photobooth session.
// A full captured set is well under localStorage's ~5MB cap,
// so this is plenty for one session without needing IndexedDB or a DB.
// If/when we want to keep a permanent archive of past sessions, the right next
// step is writing real JPEG files to disk via Electron's `fs` module.

const KEY = 'kuku.photobooth.shots';

export function loadShots() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveShots(shots) {
  try {
    if (!shots || shots.length === 0) {
      localStorage.removeItem(KEY);
      return;
    }
    localStorage.setItem(KEY, JSON.stringify(shots));
  } catch (err) {
    // Quota errors are the realistic failure mode — drop silently so the UI keeps working.
    console.warn('[shotStorage] failed to persist shots:', err);
  }
}

export function clearShots() {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}
