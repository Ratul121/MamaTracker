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
      
      // If camera access is not granted, request it
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
              detail: 'Please enable camera access in System Settings → Privacy & Security → Camera',
              buttons: ['OK']
            });
          }
        } catch (error) {
          console.error('Error requesting camera permission:', error);
        }
      }
      
      // Request microphone access for system audio if not granted
      if (microphoneAccess !== 'granted') {
        console.log('Requesting microphone permission...');
        try {
          const granted = await systemPreferences.askForMediaAccess('microphone');
          console.log('Microphone permission granted:', granted);
          
          if (!granted) {
            dialog.showMessageBox(null, {
              type: 'warning',
              title: 'Microphone Permission Required',
              message: 'Microphone access was denied.',
              detail: 'Please enable microphone access in System Settings → Privacy & Security → Microphone',
              buttons: ['OK']
            });
          }
        } catch (error) {
          console.error('Error requesting microphone permission:', error);
        }
      }
      
      // For screen recording, we'll use the mac-screen-capture-permissions module in the CaptureManager
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

    // Reset permissions on macOS when window is focused
    // This helps macOS re-check if permissions have been granted
    if (process.platform === 'darwin') {
      this.mainWindow.on('focus', () => {
        console.log('Window focused, checking for updated permissions');
        // Instead of using resetMediaAccessStatus, just log current status
        // which will refresh the internal cache
        const screenAccess = systemPreferences.getMediaAccessStatus('screen');
        const cameraAccess = systemPreferences.getMediaAccessStatus('camera');
        const microphoneAccess = systemPreferences.getMediaAccessStatus('microphone');
        console.log('Current permissions - Screen:', screenAccess, 'Camera:', cameraAccess, 'Microphone:', microphoneAccess);
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
              // Call the run-diagnostics IPC handler directly
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
      return await this.captureManager.takeCameraPhoto({ deviceId });
    });
    
    // Diagnostics
    ipcMain.handle('run-diagnostics', async () => {
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
    });

    // Composite capture
    ipcMain.handle('capture-composite', async () => {
      return await this.captureManager.takeCompositeCapture();
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
      
      // If this is a camera setting, update the capture manager
      if (key === 'defaultCameraId') {
        this.captureManager.setDefaultCamera(value);
      }
    });
    
    // Permissions
    ipcMain.handle('reset-permissions', async () => {
      if (process.platform === 'darwin') {
        console.log('Checking current permission status to refresh cache');
        // Instead of using resetMediaAccessStatus, check each permission type
        // which forces Electron to refresh its internal cache
        const screenAccess = systemPreferences.getMediaAccessStatus('screen');
        const cameraAccess = systemPreferences.getMediaAccessStatus('camera');
        const microphoneAccess = systemPreferences.getMediaAccessStatus('microphone');
        console.log('Current permissions - Screen:', screenAccess, 'Camera:', cameraAccess, 'Microphone:', microphoneAccess);
        
        // Show confirmation dialog
        await dialog.showMessageBox({
          type: 'info',
          title: 'Permissions Checked',
          message: 'Current permission status has been checked.',
          detail: 'Screen: ' + screenAccess + '\nCamera: ' + cameraAccess + '\nMicrophone: ' + microphoneAccess + 
                  '\n\nIf you\'ve recently granted permissions in System Settings, please restart the app.',
          buttons: ['OK']
        });
        
        return true;
      }
      return false;
    });
    
    ipcMain.handle('open-privacy-settings', () => {
      if (process.platform === 'darwin') {
        const { shell } = require('electron');
        // Open Screen Recording settings
        shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy');
        return true;
      }
      return false;
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

  async resetPermissionCache() {
    if (process.platform !== 'darwin') {
      dialog.showMessageBox({
        type: 'info',
        title: 'Permission Reset',
        message: 'Permission reset is only available on macOS',
        buttons: ['OK']
      });
      return;
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
          return;
        }
        
        // Restart the app
        app.relaunch();
        app.exit();
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