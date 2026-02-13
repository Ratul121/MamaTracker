const { app, BrowserWindow, ipcMain, Tray, Menu, dialog, globalShortcut, systemPreferences, nativeImage, shell } = require('electron');
const path = require('path');
const { DatabaseManager } = require('./database/database-manager');
const { CaptureManager } = require('./capture/capture-manager');
const { FileManager } = require('./file-manager/file-manager');
const { IntervalManager } = require('./capture/interval-manager');
const Store = require('electron-store');
const { promisify } = require('util');
const { exec } = require('child_process');
const fs = require('fs/promises');
const macPermissions = require('mac-screen-capture-permissions');

class ElectronCaptureApp {
  constructor() {
    this.mainWindow = null;
    this.tray = null;
    this.store = new Store();
    this.dbManager = new DatabaseManager();
    this.fileManager = new FileManager();
    this.captureManager = null; // Will be initialized after dbManager
    this.intervalManager = null; // Will be initialized after dbManager
    this.isQuitting = false;
  }

  async initialize() {
    try {
      await app.whenReady();
      // We still check permissions for logging/initialization but the window flow handles the UI
      await this.checkMacOSPermissions();

      try {
        await this.dbManager.initialize();
      } catch (dbError) {
        console.error('Database initialization error:', dbError);
        // Continue with application startup even if database fails
      }

      // Initialize managers that depend on database
      this.captureManager = new CaptureManager(this.dbManager);
      this.intervalManager = new IntervalManager(this.dbManager);

      // Initialize the managers
      await this.captureManager.initialize();
      await this.intervalManager.initialize();

      this.createWindow();
      this.createTray();
      this.setupIPC();
      this.registerShortcuts();
      this.setupAppEvents();
    } catch (error) {
      console.error('Application initialization failed:', error);
      // Show error dialog to user
      const { dialog } = require('electron');
      dialog.showErrorBox(
        'Initialization Error',
        'The application failed to initialize properly. Some features may not work correctly.\n\nError: ' + error.message
      );
    }
  }

  createFallbackIcon() {
    // Create a simple fallback icon
    const { nativeImage } = require('electron');
    return nativeImage.createEmpty();
  }

  async checkMacOSPermissions() {
    if (process.platform === 'darwin') {
      console.log('Checking macOS permissions...');

      // Check screen recording permission
      const screenAccess = systemPreferences.getMediaAccessStatus('screen');
      console.log('Screen recording access:', screenAccess);

      // Check camera permission
      const cameraAccess = systemPreferences.getMediaAccessStatus('camera');
      console.log('Camera access:', cameraAccess);

      // Check microphone permission for system audio
      const microphoneAccess = systemPreferences.getMediaAccessStatus('microphone');
      console.log('Microphone access:', microphoneAccess);
    }
  }

  createWindow() {
    this.mainWindow = new BrowserWindow({
      width: 1200,
      height: 850,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, '../renderer/preload.js')
      },
      icon: path.join(__dirname, '../../assets/icon.png'),
      show: false
    });

    // innovative permission check flow
    this.checkPermissionsStatus().then(allGranted => {
      // If permissions are granted, load the main app
      // Since checkPermissionsStatus handles platform-specific logic (assuming TRUE for screen on Windows),
      // we can rely on its result for all platforms.
      if (allGranted) {
        this.mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
        // Permissions are good, resume any active sessions
        this.intervalManager.resumeActiveSessions();
      } else {
        // Otherwise load the permissions onboarding page
        this.mainWindow.loadFile(path.join(__dirname, '../renderer/permissions.html'));
      }
    });

    this.mainWindow.once('ready-to-show', () => {
      this.mainWindow.show();
    });

    // Reset permissions on macOS when window is focused
    if (process.platform === 'darwin') {
      this.mainWindow.on('focus', () => {
        const screenAccess = systemPreferences.getMediaAccessStatus('screen');
        const cameraAccess = systemPreferences.getMediaAccessStatus('camera');
        const microphoneAccess = systemPreferences.getMediaAccessStatus('microphone');
        // console.log('Current permissions - Screen:', screenAccess, 'Camera:', cameraAccess, 'Microphone:', microphoneAccess);
      });
    }

    this.mainWindow.on('close', (event) => {
      if (!this.isQuitting) {
        event.preventDefault();
        this.mainWindow.hide();
        if (process.platform === 'darwin') {
          app.dock.hide();
        }
      }
    });

    this.mainWindow.on('minimize', (event) => {
      if (this.store.get('backgroundOperation.minimizeToTray', true)) {
        event.preventDefault();
        this.mainWindow.hide();
      }
    });
  }

  async checkPermissionsStatus() {
    // Check permissions on both macOS and Windows
    const camera = systemPreferences.getMediaAccessStatus('camera');
    const mic = systemPreferences.getMediaAccessStatus('microphone');

    let screen = true;
    if (process.platform === 'darwin') {
      screen = macPermissions.hasScreenCapturePermission();
    }
    // On Windows, screen capture permission is not generally restricted by the system in the same way,
    // so we assume true unless we want to implement a specific check (e.g. attempting a capture).

    // Log for debugging
    console.log(`Permission Check (${process.platform}): Screen=${screen}, Camera=${camera}, Mic=${mic}`);

    return screen && camera === 'granted' && mic === 'granted';
  }

  buildTrayContextMenu() {
    return Menu.buildFromTemplate([
      {
        label: 'Show App',
        click: () => {
          if (this.mainWindow === null || this.mainWindow.isDestroyed()) {
            this.createWindow();
          } else {
            this.mainWindow.show();
            this.mainWindow.focus();
            if (process.platform === 'darwin') {
              app.dock.show();
            }
          }
        }
      },
      { type: 'separator' },
      {
        label: 'Take Screenshot',
        click: () => {
          this.captureManager.captureScreenshot();
        }
      },
      {
        label: 'Take Camera Photo',
        click: () => {
          this.captureManager.takeCameraPhoto();
        }
      },
      {
        label: 'Take Composite Capture',
        click: () => {
          this.captureManager.takeCompositeCapture();
        }
      },
      { type: 'separator' },
      {
        label: 'Interval Captures',
        submenu: this.buildSessionsMenu()
      },
      { type: 'separator' },
      {
        label: 'Settings',
        submenu: [
          {
            label: 'Select Save Location',
            click: () => {
              this.selectSaveDirectory();
            }
          },
          {
            label: 'Reset Permission Cache',
            click: () => {
              this.resetPermissionCache();
            }
          }
        ]
      },
      {
        label: 'Troubleshooting',
        submenu: [
          {
            label: 'Reset Permission Cache',
            click: () => {
              this.resetPermissionCache();
            }
          },
          {
            label: 'Check imagesnap',
            click: () => {
              this.captureManager.checkAndInstallImagesnap();
            }
          },
          {
            label: 'Open Privacy Settings',
            click: () => {
              shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy');
            }
          },
          {
            label: 'Run Diagnostics',
            click: async () => {
              await this.runDiagnostics();
            }
          }
        ]
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          this.isQuitting = true;
          app.quit();
        }
      }
    ]);
  }

  createTray() {
    if (this.tray) {
      this.tray.destroy();
      this.tray = null;
    }

    const trayIconPath = path.join(__dirname, '../../assets/tray-icon.png');
    try {
      this.tray = new Tray(trayIconPath);
    } catch (error) {
      console.log('Tray icon not found, creating tray without icon');
      this.tray = new Tray(this.createFallbackIcon());
    }

    this.tray.setContextMenu(this.buildTrayContextMenu());
    this.tray.setToolTip('Capture App');

    this.tray.on('double-click', () => {
      if (this.mainWindow === null || this.mainWindow.isDestroyed()) {
        this.createWindow();
      } else {
        this.mainWindow.show();
        this.mainWindow.focus();
        if (process.platform === 'darwin') {
          app.dock.show();
        }
      }
    });
  }

  buildSessionsMenu() {
    const sessions = this.intervalManager.getActiveSessions();
    console.log('Building sessions menu, active sessions:', sessions.length, sessions);

    if (sessions.length === 0) {
      return [{ label: 'No active sessions', enabled: false }];
    }

    const hasActiveSession = this.intervalManager.hasActiveSession();

    return sessions.map(session => ({
      label: `${session.session_name || session.session_id} (${session.status})`,
      submenu: [
        {
          label: session.status === 'active' ? 'Pause' : 'Resume',
          enabled: session.status === 'active' || !hasActiveSession,
          click: async () => {
            try {
              if (session.status === 'active') {
                await this.intervalManager.pauseSession(session.session_id);
              } else {
                await this.intervalManager.resumeSession(session.session_id);
              }
              this.updateTrayMenu();
            } catch (error) {
              console.error('Error toggling session:', error);
              const { dialog } = require('electron');
              dialog.showErrorBox('Session Error', error.message);
            }
          }
        },
        {
          label: 'Stop',
          click: async () => {
            try {
              await this.intervalManager.stopSession(session.session_id);
              this.updateTrayMenu();
            } catch (error) {
              console.error('Error stopping session:', error);
              const { dialog } = require('electron');
              dialog.showErrorBox('Session Error', error.message);
            }
          }
        }
      ]
    }));
  }

  updateTrayMenu() {
    console.log('Updating tray menu...');
    if (this.tray) {
      const sessions = this.intervalManager.getActiveSessions();
      console.log('Active sessions for tray update:', sessions.length);
      this.tray.setContextMenu(this.buildTrayContextMenu());
    }
  }

  setupIPC() {
    // Screenshot operations
    ipcMain.handle('capture-screenshot', async (event, options) => {
      return await this.captureManager.captureScreenshot(options);
    });

    ipcMain.handle('capture-region', async () => {
      return await this.captureManager.captureRegion();
    });

    // Camera operations
    ipcMain.handle('enumerate-cameras', async () => {
      return await this.captureManager.enumerateCameras();
    });

    ipcMain.handle('capture-photo', async (event, deviceId) => {
      return await this.captureManager.takeCameraPhoto({ deviceId });
    });

    // Diagnostics
    ipcMain.handle('run-diagnostics', async () => {
      return await this.runDiagnostics();
    });

    // Composite capture
    ipcMain.handle('capture-composite', async () => {
      return await this.captureManager.takeCompositeCapture();
    });

    // Interval operations
    ipcMain.handle('start-interval-capture', async (event, config) => {
      try {
        const sessionId = await this.intervalManager.startSession(config);
        this.updateTrayMenu();
        return { success: true, sessionId };
      } catch (error) {
        console.error('Failed to start interval capture:', error);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle('pause-interval-capture', async (event, sessionId) => {
      try {
        await this.intervalManager.pauseSession(sessionId);
        this.updateTrayMenu();
        return { success: true };
      } catch (error) {
        console.error('Failed to pause interval capture:', error);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle('resume-interval-capture', async (event, sessionId) => {
      try {
        await this.intervalManager.resumeSession(sessionId);
        this.updateTrayMenu();
        return { success: true };
      } catch (error) {
        console.error('Failed to resume interval capture:', error);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle('stop-interval-capture', async (event, sessionId) => {
      await this.intervalManager.stopSession(sessionId);
      this.updateTrayMenu();
    });

    ipcMain.handle('get-active-sessions', async () => {
      return this.intervalManager.getActiveSessions();
    });

    // File management
    ipcMain.handle('select-directory', async () => {
      const result = await dialog.showOpenDialog(this.mainWindow, {
        properties: ['openDirectory']
      });
      return result;
    });

    ipcMain.handle('get-captures', async (event, filters) => {
      return await this.dbManager.getCaptures(filters);
    });

    ipcMain.handle('delete-capture', async (event, captureId) => {
      return await this.fileManager.deleteCapture(captureId);
    });

    // System tray operations
    ipcMain.handle('minimize-to-tray', () => {
      this.mainWindow.hide();
    });

    ipcMain.handle('restore-from-tray', () => {
      if (this.mainWindow === null || this.mainWindow.isDestroyed()) {
        this.createWindow();
      } else {
        this.mainWindow.show();
        this.mainWindow.focus();
        if (process.platform === 'darwin') {
          app.dock.show();
        }
      }
    });

    // Settings
    ipcMain.handle('get-setting', (event, key) => {
      return this.store.get(key);
    });

    ipcMain.handle('set-setting', (event, key, value) => {
      this.store.set(key, value);

      // If this is a camera setting, update the capture manager
      if (key === 'defaultCameraId') {
        this.captureManager.setDefaultCamera(value);
      }
    });

    // Permissions Handlers
    ipcMain.handle('open-privacy-settings', (event, type) => {
      const { shell } = require('electron');
      if (process.platform === 'darwin') {
        let url = 'x-apple.systempreferences:com.apple.preference.security?Privacy';
        if (type === 'screen') url += '_ScreenCapture';
        else if (type === 'camera') url += '_Camera';
        else if (type === 'microphone') url += '_Microphone';

        shell.openExternal(url);
        return true;
      } else if (process.platform === 'win32') {
        let url = 'ms-settings:privacy-webcam';
        if (type === 'microphone') url = 'ms-settings:privacy-microphone';
        // Windows doesn't typically have a specific screen recording permission setting page
        // that users need to toggle like macOS, so we default to webcam/mic settings
        // or just general privacy if needed.

        shell.openExternal(url);
        return true;
      }
      return false;
    });

    ipcMain.handle('check-permissions', async () => {
      const camera = systemPreferences.getMediaAccessStatus('camera');
      const mic = systemPreferences.getMediaAccessStatus('microphone');

      let screen = 'granted';
      if (process.platform === 'darwin') {
        screen = macPermissions.hasScreenCapturePermission() ? 'granted' : 'denied';
      }

      return {
        screen,
        camera,
        microphone: mic
      };
    });

    ipcMain.handle('request-permission', async (event, type) => {
      try {
        if (type === 'camera' || type === 'microphone') {
          return await systemPreferences.askForMediaAccess(type);
        }
        return false;
      } catch (error) {
        console.error(`Error requesting ${type} permission:`, error);
        // On Windows, askForMediaAccess might throw or not exist in older Electron versions,
        // or return true/false without prompting.
        return false;
      }
    });

    ipcMain.handle('relaunch-app', () => {
      app.relaunch();
      app.exit(0);
    });

    ipcMain.handle('permissions-completed', () => {
      this.mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
      // Permissions granted, resume sessions
      this.intervalManager.resumeActiveSessions();
    });

    ipcMain.handle('reset-permissions', async () => {
      return await this.resetPermissionCache();
    });
  }

  registerShortcuts() {
    const shortcuts = this.store.get('shortcutKeys', {
      fullScreen: 'CommandOrControl+Shift+F',
      activeWindow: 'CommandOrControl+Shift+W',
      camera: 'CommandOrControl+Shift+C',
      startInterval: 'CommandOrControl+Shift+I',
      stopInterval: 'CommandOrControl+Shift+S',
      showFromTray: 'CommandOrControl+Shift+T'
    });

    Object.entries(shortcuts).forEach(([action, shortcut]) => {
      globalShortcut.register(shortcut, () => {
        this.handleShortcut(action);
      });
    });
  }

  handleShortcut(action) {
    switch (action) {
      case 'fullScreen':
        this.captureManager.captureFullScreen();
        break;
      case 'activeWindow':
        this.captureManager.captureActiveWindow();
        break;
      case 'camera':
        this.captureManager.captureCamera();
        break;
      case 'showFromTray':
        this.mainWindow.show();
        if (process.platform === 'darwin') {
          app.dock.show();
        }
        break;
    }
  }

  setupAppEvents() {
    app.on('window-all-closed', () => {
      if (process.platform !== 'darwin') {
        app.quit();
      }
    });

    app.on('activate', () => {
      // On macOS, re-create or show the window when the dock icon is clicked
      if (this.mainWindow === null) {
        this.createWindow();
      } else if (this.mainWindow.isDestroyed()) {
        this.createWindow();
      } else {
        // Window exists but might be hidden, show it
        this.mainWindow.show();
        if (process.platform === 'darwin') {
          app.dock.show();
        }
      }
    });

    app.on('before-quit', () => {
      this.isQuitting = true;
      globalShortcut.unregisterAll();

      // Clean up tray to prevent multiple instances
      if (this.tray) {
        this.tray.destroy();
        this.tray = null;
      }
    });
  }

  async resetPermissionCache() {
    if (process.platform !== 'darwin') {
      dialog.showMessageBox({
        type: 'info',
        title: 'Permission Reset',
        message: 'Permission reset is only available on macOS',
        buttons: ['OK']
      });
      return false;
    }

    // Confirm with user
    const response = await dialog.showMessageBox({
      type: 'warning',
      title: 'Reset Permission Cache',
      message: 'Reset macOS permission cache?',
      detail: 'This will clear cached permission status and may help if you experience permission issues even after granting access in System Settings.\n\nThe app will restart after this operation.',
      buttons: ['Reset & Restart', 'Cancel'],
      defaultId: 0,
      cancelId: 1
    });

    if (response.response === 0) {
      // Clear the permission status for screen recording and camera
      try {
        if (systemPreferences.resetPermissions) {
          // Some versions of Electron provide this API
          systemPreferences.resetPermissions();
        } else {
          // Alternative approach - use terminal command to reset TCC database
          // (requires user password, so we'll show instructions)
          dialog.showMessageBoxSync({
            type: 'info',
            title: 'Manual Reset Required',
            message: 'Please run these commands in Terminal:',
            detail: 'tccutil reset ScreenCapture com.yourcompany.electron-capture-app\n' +
              'tccutil reset Camera com.yourcompany.electron-capture-app\n\n' +
              'Then restart the app.',
            buttons: ['OK']
          });

          shell.openExternal('file:///Applications/Utilities/Terminal.app');
          return false;
        }

        // Restart the app
        app.relaunch();
        app.exit();
        return true;
      } catch (error) {
        console.error('Error resetting permissions:', error);
        dialog.showMessageBoxSync({
          type: 'error',
          title: 'Error',
          message: 'Failed to reset permissions',
          detail: error.message,
          buttons: ['OK']
        });
      }
    }
    return false;
  }

  async selectSaveDirectory() {
    try {
      const result = await dialog.showOpenDialog({
        properties: ['openDirectory'],
        title: 'Select Save Location',
        buttonLabel: 'Select'
      });

      if (!result.canceled && result.filePaths.length > 0) {
        const newSaveDir = result.filePaths[0];

        // Update the save directory
        this.store.set('saveDirectory', newSaveDir);
        this.captureManager.saveDirectory = newSaveDir;

        // Try to create a test folder to verify access
        try {
          const testDir = path.join(newSaveDir, 'test-folder');
          await fs.mkdir(testDir, { recursive: true });
          await fs.rmdir(testDir);

          dialog.showMessageBox({
            type: 'info',
            title: 'Save Location Updated',
            message: `Successfully set save location to:\n${newSaveDir}`,
            buttons: ['OK']
          });
        } catch (accessError) {
          console.error('Error testing save directory access:', accessError);

          dialog.showMessageBox({
            type: 'warning',
            title: 'Permission Issue',
            message: 'Limited access to selected directory',
            detail: `The app may have limited access to the selected directory. Try selecting a different location or check app permissions.\n\nError: ${accessError.message}`,
            buttons: ['OK']
          });
        }
      }
    } catch (error) {
      console.error('Error selecting save directory:', error);
    }
  }

  async runDiagnostics() {
    try {
      // Check various components and return diagnostic info
      const diagnostics = {
        platform: process.platform,
        isPackaged: app.isPackaged,
        appPath: app.getAppPath(),
        resourcePath: process.resourcesPath,
        execPath: process.execPath,
        versions: process.versions,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME
        }
      };

      // Check save directory
      const saveDir = this.store.get('saveDirectory') || app.getPath('pictures');
      diagnostics.saveDirectory = {
        path: saveDir,
        exists: false,
        writable: false
      };

      try {
        const stats = await fs.stat(saveDir);
        diagnostics.saveDirectory.exists = stats.isDirectory();

        try {
          const testFile = path.join(saveDir, `.test-${Date.now()}`);
          await fs.writeFile(testFile, 'test');
          await fs.unlink(testFile);
          diagnostics.saveDirectory.writable = true;
        } catch (writeError) {
          diagnostics.saveDirectory.writeError = writeError.message;
        }
      } catch (statError) {
        diagnostics.saveDirectory.statError = statError.message;
      }

      // Check if imagesnap exists
      if (process.platform === 'darwin') {
        try {
          const { stdout } = await promisify(exec)('which imagesnap');
          diagnostics.imagesnap = {
            found: true,
            path: stdout.trim()
          };

          // Try to list cameras with imagesnap
          try {
            const { stdout: cameraOutput } = await promisify(exec)(`${stdout.trim()} -l`);
            diagnostics.imagesnapOutput = cameraOutput;
          } catch (imagesnapError) {
            diagnostics.imagesnapError = imagesnapError.toString();
          }
        } catch (whichError) {
          diagnostics.imagesnap = {
            found: false,
            error: whichError.toString()
          };
        }

        // Check permissions
        diagnostics.permissions = {
          screen: systemPreferences.getMediaAccessStatus('screen'),
          camera: systemPreferences.getMediaAccessStatus('camera'),
          microphone: systemPreferences.getMediaAccessStatus('microphone')
        };
      }

      console.log('Diagnostics:', diagnostics);

      // Show diagnostic info in a dialog
      dialog.showMessageBox({
        type: 'info',
        title: 'Diagnostics Information',
        message: 'App Diagnostics',
        detail: JSON.stringify(diagnostics, null, 2),
        buttons: ['OK'],
        defaultId: 0
      });

      return diagnostics;
    } catch (error) {
      console.error('Error running diagnostics:', error);
      return { error: error.toString() };
    }
  }
}

// Initialize the application
const captureApp = new ElectronCaptureApp();
captureApp.initialize().catch(console.error);