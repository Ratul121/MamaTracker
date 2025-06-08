const { app, BrowserWindow, ipcMain, Tray, Menu, dialog, globalShortcut, systemPreferences, nativeImage } = require('electron');
const path = require('path');
const { DatabaseManager } = require('./database/database-manager');
const { CaptureManager } = require('./capture/capture-manager');
const { FileManager } = require('./file-manager/file-manager');
const { IntervalManager } = require('./capture/interval-manager');
const Store = require('electron-store');

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
    await app.whenReady();
    await this.checkMacOSPermissions();
    await this.dbManager.initialize();
    
    // Initialize managers that depend on database
    this.captureManager = new CaptureManager(this.dbManager);
    this.intervalManager = new IntervalManager(this.dbManager);
    
    this.createWindow();
    this.createTray();
    this.setupIPC();
    this.registerShortcuts();
    this.setupAppEvents();
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
      
      if (screenAccess !== 'granted') {
        console.log('Screen recording permission not granted. User needs to enable it in System Preferences.');
        // Show dialog to inform user with more detailed instructions
        const response = await dialog.showMessageBox(null, {
          type: 'warning',
          title: 'Screen Recording Permission Required',
          message: 'This app needs screen recording permission to capture screenshots.',
          detail: 'Please follow these steps:\n\n1. Click "Open System Preferences" below\n2. Go to Security & Privacy > Privacy > Screen Recording\n3. Check the box next to this app\n4. Quit and restart the app after granting permission',
          buttons: ['Open System Preferences', 'Later'],
          defaultId: 0,
          cancelId: 1
        });
        
        if (response.response === 0) {
          // Open the Security & Privacy preferences
          const { shell } = require('electron');
          shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
        }
      }
      
      // Check camera permission
      const cameraAccess = systemPreferences.getMediaAccessStatus('camera');
      console.log('Camera access:', cameraAccess);
      
      if (cameraAccess !== 'granted') {
        console.log('Requesting camera permission...');
        try {
          const granted = await systemPreferences.askForMediaAccess('camera');
          console.log('Camera permission granted:', granted);
          
          if (!granted) {
            dialog.showMessageBox(null, {
              type: 'warning',
              title: 'Camera Permission Required',
              message: 'Camera access was denied.',
              detail: 'Please enable camera access in System Preferences > Security & Privacy > Privacy > Camera',
              buttons: ['OK']
            });
          }
        } catch (error) {
          console.error('Error requesting camera permission:', error);
        }
      }
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

    this.mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

    this.mainWindow.once('ready-to-show', () => {
      this.mainWindow.show();
    });

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

  createTray() {
    // Create a simple tray icon using a built-in icon or skip if file doesn't exist
    const trayIconPath = path.join(__dirname, '../../assets/tray-icon.png');
    try {
      this.tray = new Tray(trayIconPath);
    } catch (error) {
      console.log('Tray icon not found, creating tray without icon');
      // Create a simple 16x16 transparent PNG as fallback
      this.tray = new Tray(this.createFallbackIcon());
    }
    
    const contextMenu = Menu.buildFromTemplate([
      {
        label: 'Show App',
        click: () => {
          this.mainWindow.show();
          if (process.platform === 'darwin') {
            app.dock.show();
          }
        }
      },
      { type: 'separator' },
      {
        label: 'Quick Screenshot',
        click: () => this.captureManager.captureFullScreen()
      },
      {
        label: 'Quick Camera',
        click: () => this.captureManager.captureCamera()
      },
      { type: 'separator' },
      {
        label: 'Active Sessions',
        submenu: this.buildSessionsMenu()
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

    this.tray.setContextMenu(contextMenu);
    this.tray.setToolTip('Capture App');

    this.tray.on('double-click', () => {
      this.mainWindow.show();
      if (process.platform === 'darwin') {
        app.dock.show();
      }
    });
  }

  buildSessionsMenu() {
    const sessions = this.intervalManager.getActiveSessions();
    if (sessions.length === 0) {
      return [{ label: 'No active sessions', enabled: false }];
    }

    return sessions.map(session => ({
      label: `${session.session_name || session.session_id}`,
      submenu: [
        {
          label: session.status === 'active' ? 'Pause' : 'Resume',
          click: () => {
            if (session.status === 'active') {
              this.intervalManager.pauseSession(session.session_id);
            } else {
              this.intervalManager.resumeSession(session.session_id);
            }
            this.updateTrayMenu();
          }
        },
        {
          label: 'Stop',
          click: () => {
            this.intervalManager.stopSession(session.session_id);
            this.updateTrayMenu();
          }
        }
      ]
    }));
  }

  updateTrayMenu() {
    // Simply recreate the tray menu with updated sessions
    if (this.tray) {
      this.createTray();
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
      return await this.captureManager.capturePhoto(deviceId);
    });

    // Composite capture
    ipcMain.handle('capture-composite', async () => {
      return await this.captureManager.captureComposite();
    });

    // Interval operations
    ipcMain.handle('start-interval-capture', async (event, config) => {
      const sessionId = await this.intervalManager.startSession(config);
      this.updateTrayMenu();
      return sessionId;
    });

    ipcMain.handle('pause-interval-capture', async (event, sessionId) => {
      await this.intervalManager.pauseSession(sessionId);
      this.updateTrayMenu();
    });

    ipcMain.handle('resume-interval-capture', async (event, sessionId) => {
      await this.intervalManager.resumeSession(sessionId);
      this.updateTrayMenu();
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
      this.mainWindow.show();
      if (process.platform === 'darwin') {
        app.dock.show();
      }
    });

    // Settings
    ipcMain.handle('get-setting', (event, key) => {
      return this.store.get(key);
    });

    ipcMain.handle('set-setting', (event, key, value) => {
      this.store.set(key, value);
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
      if (BrowserWindow.getAllWindows().length === 0) {
        this.createWindow();
      }
    });

    app.on('before-quit', () => {
      this.isQuitting = true;
      globalShortcut.unregisterAll();
    });
  }
}

// Initialize the application
const captureApp = new ElectronCaptureApp();
captureApp.initialize().catch(console.error); 