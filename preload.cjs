// Preload script — runs in the renderer process with access to Electron's
// ipcRenderer before any page script loads. Exposes narrowly-scoped APIs
// on `window.printApi` and `window.adminApi` via contextBridge so the
// React app can trigger native operations without nodeIntegration.
const { contextBridge, ipcRenderer } = require('electron');

console.log('[DIAG preload] preload loaded', {
  hasContextBridge: true,
  href: window.location.href,
});

// ── Hardware printing ──────────────────────────────────────────────────
contextBridge.exposeInMainWorld('printApi', {
  platform: process.platform,
  isPackaged: !process.defaultApp,
  canOpenPrintCenter: process.platform === 'darwin',
  /**
   * Send a pre-composed photobooth strip (JPEG/PNG data URL) to the main
   * process for printing at 4"×6" with no scaling.
   */
  printStrip: (dataUrl, options = {}) =>
    ipcRenderer.invoke('print-strip', { dataUrl, ...options }),
  saveStrip: (dataUrl, options = {}) =>
    ipcRenderer.invoke('save-strip', { dataUrl, ...options }),
  openPrintCenter: () =>
    ipcRenderer.invoke('print-center:open'),
  getQueue: () =>
    ipcRenderer.invoke('print-queue:get'),
  cancelJob: (id) =>
    ipcRenderer.invoke('print-queue:cancel', { id }),
  deleteJob: (id) =>
    ipcRenderer.invoke('print-queue:delete', { id }),
  clearCompletedJobs: () =>
    ipcRenderer.invoke('print-queue:clear-completed'),
  listPrinters: () =>
    ipcRenderer.invoke('printers:list'),
  onPrintProgress: (cb) => {
    const listener = (_ev, progress) => { try { cb(progress); } catch { /* ignore */ } };
    ipcRenderer.on('print-strip-progress', listener);
    return () => ipcRenderer.removeListener('print-strip-progress', listener);
  },
  onQueueChanged: (cb) => {
    const listener = (_ev, jobs) => { try { cb(jobs); } catch { /* ignore */ } };
    ipcRenderer.on('print-queue:changed', listener);
    return () => ipcRenderer.removeListener('print-queue:changed', listener);
  },
  printExtraSessionCopy: (payload) =>
    ipcRenderer.invoke('today-monitor:print-extra-session-copy', payload),
});

contextBridge.exposeInMainWorld('softcopyApi', {
  saveSessionMedia: (payload) => {
    console.log('[DIAG preload] saveSessionMedia called', {
      fileCount: payload?.files?.length,
      files: payload?.files?.map(f => ({
        kind: f.kind,
        name: f.name,
        mimeType: f.mimeType,
        hasData: Boolean(f.data || f.arrayBuffer || f.dataUrl),
      })),
    });
    return ipcRenderer.invoke('softcopy-local:save-session-media', payload);
  },
  readSavedMediaFile: (payload) =>
    ipcRenderer.invoke('softcopy-local:read-saved-media-file', payload),
});

contextBridge.exposeInMainWorld('keychainApi', {
  saveKeychain4x6: (payload) => {
    console.log('[keychain-save preload] called', {
      sessionId: payload?.sessionId,
      layoutId: payload?.layoutId,
      filename: payload?.filename,
      mimeType: payload?.mimeType,
      hasData: Boolean(payload?.data || payload?.dataUrl || payload?.arrayBuffer),
    });
    return ipcRenderer.invoke('keychain:save-4x6-to-downloads', payload);
  },
});

const resetTodayRecords = () => ipcRenderer.invoke('today-monitor:reset-today-records');
const onTodayRecordsReset = (cb) => {
  const listener = (_ev, payload) => { try { cb(payload); } catch { /* ignore */ } };
  ipcRenderer.on('today-monitor:records-reset', listener);
  return () => ipcRenderer.removeListener('today-monitor:records-reset', listener);
};
const onSessionsUpdated = (cb) => {
  const listener = (_ev, payload) => { try { cb(payload); } catch { /* ignore */ } };
  ipcRenderer.on('sessions:updated', listener);
  return () => ipcRenderer.removeListener('sessions:updated', listener);
};
const onTodayMonitorSessionsUpdated = (cb) => {
  const listener = (_ev, payload) => { try { cb(payload); } catch { /* ignore */ } };
  ipcRenderer.on('today-monitor:sessions-updated', listener);
  return () => ipcRenderer.removeListener('today-monitor:sessions-updated', listener);
};

contextBridge.exposeInMainWorld('diagApi', {
  logEvent: (payload) => ipcRenderer.invoke('diag:log-event', payload),
  writeDownloadsTextFile: () => ipcRenderer.invoke('diag:write-downloads-text-file'),
  writeDownloadsPngFile: (payload) => {
    console.log('[DIAG STEP 2 preload] writeDownloadsPngFile called', {
      hasArrayBuffer: Boolean(payload?.arrayBuffer),
      byteLength: payload?.arrayBuffer?.byteLength,
    });
    return ipcRenderer.invoke('diag:write-downloads-png-file', payload);
  },
});
console.log('[DIAG preload] diagApi exposed');

const todayMonitorApi = {
  resetTodayRecords,
  onRecordsReset: onTodayRecordsReset,
  onSessionsUpdated: onTodayMonitorSessionsUpdated,
  printExtraSessionCopy: (payload) => ipcRenderer.invoke('today-monitor:print-extra-session-copy', payload),
  generateAndPrintKeychain: (payload) => ipcRenderer.invoke('today-monitor:generate-and-print-keychain', payload),
};
contextBridge.exposeInMainWorld('todayMonitorApi', todayMonitorApi);
console.log('[todayMonitorApi preload] keys exposed', Object.keys(todayMonitorApi));
console.log('[keychain preload] generateAndPrintKeychain exposed');
console.log('[preload loaded]', {
  href: window.location.href,
  hasTodayMonitorApi: true,
  todayMonitorApiKeys: Object.keys(todayMonitorApi),
  isolatedWorldWindowHasTodayMonitorApi: Boolean(window.todayMonitorApi),
});
console.log('[print extra copy preload] printExtraSessionCopy exposed', {
  hasPrintApi: true,
  hasTodayMonitorApi: true,
});

// ── Admin / template management ───────────────────────────────────────
contextBridge.exposeInMainWorld('adminApi', {
  // Templates
  listTemplates:    ()           => ipcRenderer.invoke('templates:list'),
  auditDuplicateTemplates: ()    => ipcRenderer.invoke('templates:audit-duplicates'),
  cleanDuplicateTemplates: ()    => ipcRenderer.invoke('templates:clean-duplicates'),
  createTemplate:   (payload)    => ipcRenderer.invoke('templates:create', payload),
  createTemplateFromBundled: (payload) => ipcRenderer.invoke('templates:create-from-bundled', payload),
  replaceTemplateAsset: (payload) => ipcRenderer.invoke('templates:replace-asset', payload),
  updateTemplate:   (id, patch)  => ipcRenderer.invoke('templates:update', { id, patch }),
  deleteTemplate:   (id)         => ipcRenderer.invoke('templates:delete', { id }),
  getSettings:      ()           => ipcRenderer.invoke('settings:get'),
  updateSettings:   (patch)      => ipcRenderer.invoke('settings:update', patch),
  listEvents:       ()           => ipcRenderer.invoke('events:list'),
  createEvent:      (payload)    => ipcRenderer.invoke('events:create', payload),
  updateEvent:      (id, patch)  => ipcRenderer.invoke('events:update', { id, patch }),
  deleteEvent:      (id)         => ipcRenderer.invoke('events:delete', { id }),

  // PIN
  checkPin:         (pin)                 => ipcRenderer.invoke('admin:checkPin', { pin }),
  setPin:           (currentPin, newPin)  => ipcRenderer.invoke('admin:setPin', { currentPin, newPin }),

  // Sessions / analytics
  logSession:       (session)                     => ipcRenderer.invoke('sessions:log', session),
  listSessions:     ({
    limit = 50,
    offset = 0,
    eventId = null,
    mode = null,
    sessionType = null,
    status = null,
    templateName = null,
    from = null,
    to = null,
    search = null,
  } = {}) =>
                      ipcRenderer.invoke('sessions:list', {
                        limit,
                        offset,
                        eventId,
                        mode,
                        sessionType,
                        status,
                        templateName,
                        from,
                        to,
                        search,
                      }),
  getStats:         (filters = {})                => ipcRenderer.invoke('sessions:stats', filters),
  clearSessions:    ()                            => ipcRenderer.invoke('sessions:clear'),
  updateSessionSoftcopy: (id, patch)              => ipcRenderer.invoke('sessions:update-softcopy', { id, patch }),
  resetTodayMonitorRecords: ()                    => ipcRenderer.invoke('today-monitor:reset-today-records'),
  printExtraSessionCopy: (payload) =>
    ipcRenderer.invoke('today-monitor:print-extra-session-copy', payload),

  // Pub/sub — main process fires these after writes so any open dashboard
  // updates in real time. Both return an unsubscribe() callable.
  onSessionLogged: (cb) => {
    const listener = (_ev, record) => { try { cb(record); } catch { /* ignore */ } };
    ipcRenderer.on('sessions:logged', listener);
    return () => ipcRenderer.removeListener('sessions:logged', listener);
  },
  onSessionsUpdated,
  onSessionsCleared: (cb) => {
    const listener = () => { try { cb(); } catch { /* ignore */ } };
    ipcRenderer.on('sessions:cleared', listener);
    return () => ipcRenderer.removeListener('sessions:cleared', listener);
  },
  onTodayMonitorRecordsReset: (cb) => {
    return onTodayRecordsReset(cb);
  },
  onSettingsChanged: (cb) => {
    const listener = (_ev, settings) => { try { cb(settings); } catch { /* ignore */ } };
    ipcRenderer.on('settings:changed', listener);
    return () => ipcRenderer.removeListener('settings:changed', listener);
  },
  onEventsChanged: (cb) => {
    const listener = () => { try { cb(); } catch { /* ignore */ } };
    ipcRenderer.on('events:changed', listener);
    return () => ipcRenderer.removeListener('events:changed', listener);
  },
  resetSession: () => ipcRenderer.invoke('session:reset'),
  onSessionReset: (cb) => {
    const listener = () => { try { cb(); } catch { /* ignore */ } };
    ipcRenderer.on('session:reset', listener);
    return () => ipcRenderer.removeListener('session:reset', listener);
  },
  quitApp: () => ipcRenderer.invoke('app:quit'),
  onMonitorExitRequest: (cb) => {
    const listener = () => { try { cb(); } catch { /* ignore */ } };
    ipcRenderer.on('monitor:exit-request', listener);
    return () => ipcRenderer.removeListener('monitor:exit-request', listener);
  },
  getMonitorStatus: () => ipcRenderer.invoke('monitor:status'),
});
