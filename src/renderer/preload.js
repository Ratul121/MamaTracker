const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  // Screenshot operations
  captureScreenshot: (options) => ipcRenderer.invoke('capture-screenshot', options),
  captureRegion: () => ipcRenderer.invoke('capture-region'),

  // Camera operations
  enumerateCameras: () => ipcRenderer.invoke('enumerate-cameras'),
  capturePhoto: (deviceId) => ipcRenderer.invoke('capture-photo', deviceId),

  // Diagnostic functions
  runDiagnostics: () => ipcRenderer.invoke('run-diagnostics'),

  // Composite capture
  captureComposite: () => ipcRenderer.invoke('capture-composite'),

  // Interval operations
  startIntervalCapture: (config) => ipcRenderer.invoke('start-interval-capture', config),
  pauseIntervalCapture: (sessionId) => ipcRenderer.invoke('pause-interval-capture', sessionId),
  resumeIntervalCapture: (sessionId) => ipcRenderer.invoke('resume-interval-capture', sessionId),
  stopIntervalCapture: (sessionId) => ipcRenderer.invoke('stop-interval-capture', sessionId),
  getActiveSessions: () => ipcRenderer.invoke('get-active-sessions'),

  // File management
  selectDirectory: () => ipcRenderer.invoke('select-directory'),
  getCaptures: (filters) => ipcRenderer.invoke('get-captures', filters),
  deleteCapture: (captureId) => ipcRenderer.invoke('delete-capture', captureId),

  // System tray operations
  minimizeToTray: () => ipcRenderer.invoke('minimize-to-tray'),
  restoreFromTray: () => ipcRenderer.invoke('restore-from-tray'),

  // Settings
  getSetting: (key) => ipcRenderer.invoke('get-setting', key),
  setSetting: (key, value) => ipcRenderer.invoke('set-setting', key, value),

  // Permissions
  resetPermissions: () => ipcRenderer.invoke('reset-permissions'),
  openPrivacySettings: (type) => ipcRenderer.invoke('open-privacy-settings', type),
  checkPermissions: () => ipcRenderer.invoke('check-permissions'),
  requestPermission: (type) => ipcRenderer.invoke('request-permission', type),
  relaunchApp: () => ipcRenderer.invoke('relaunch-app'),
  permissionsCompleted: () => ipcRenderer.invoke('permissions-completed'),

  // Event listeners
  onCaptureComplete: (callback) => ipcRenderer.on('capture-complete', callback),
  onSessionUpdate: (callback) => ipcRenderer.on('session-update', callback),
  onError: (callback) => ipcRenderer.on('error', callback),

  // Remove listeners
  removeAllListeners: (channel) => ipcRenderer.removeAllListeners(channel)
}); 