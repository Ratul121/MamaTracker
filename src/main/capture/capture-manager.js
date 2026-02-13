const screenshot = require('screenshot-desktop');
const NodeWebcam = require('node-webcam');
const path = require('path');
const fs = require('fs').promises;
const { DatabaseManager } = require('../database/database-manager');
const { FileManager } = require('../file-manager/file-manager');
const { systemPreferences, dialog, BrowserWindow } = require('electron');
const macPermissions = require('mac-screen-capture-permissions');
const { createCanvas, loadImage, registerFont } = require('canvas');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const Store = require('electron-store');
const { app } = require('electron');
const { format } = require('date-fns');

class CaptureManager {
  constructor(dbManager = null) {
    this.dbManager = dbManager || new DatabaseManager();
    this.fileManager = new FileManager();
    this.store = new Store();
    this.webcamOptions = {
      width: 1280,
      height: 720,
      quality: 100,
      delay: 0,
      saveShots: true,
      output: 'jpeg',
      callbackReturn: 'location',
      verbose: false
    };
    this.defaultCameraId = this.store.get('defaultCameraId');
  }

  async initialize() {
    if (!this.dbManager.db) {
      await this.dbManager.initialize();
    }

    console.log('Initializing CaptureManager...');

    try {
      // Get save directory
      this.saveDirectory = this.store.get('saveDirectory') || app.getPath('pictures');
      console.log('Save directory:', this.saveDirectory);

      // Check and set up permissions on macOS
      if (process.platform === 'darwin') {
        console.log('Checking macOS permissions...');

        // We no longer pop up a dialog here during initialization.
        // The main process window creation handles the onboarding flow via permissions.html
        const hasScreenPermission = macPermissions.hasScreenCapturePermission();
        console.log(`Screen capture permission status: ${hasScreenPermission}`);

        // Check camera permission (but don't request it yet to avoid prompts on startup)
        const cameraAccess = systemPreferences.getMediaAccessStatus('camera');
        console.log(`Camera access status: ${cameraAccess}`);

        // Check and install imagesnap
        const imagesnapAvailable = await this.checkAndInstallImagesnap();
        console.log(`imagesnap available: ${imagesnapAvailable}`);
      }

      // Enumerate cameras and set default if not already set
      console.log('Initializing camera settings...');
      await this.initializeDefaultCamera();

      console.log('CaptureManager initialization complete');
    } catch (error) {
      console.error('Error during CaptureManager initialization:', error);
    }
  }

  async checkMacOSScreenRecordingPermission() {
    if (process.platform !== 'darwin') {
      return true;
    }

    console.log('Checking macOS screen recording permission...');

    // macOS 10.15 (Catalina) and later requires special permissions for screen recording
    try {
      const hasPermission = macPermissions.hasScreenCapturePermission();
      console.log(`Screen capture permission: ${hasPermission}`);

      if (!hasPermission) {
        // Show dialog explaining why permission is needed and how to grant it
        const response = await dialog.showMessageBox({
          type: 'warning',
          title: 'Screen Recording Permission Required',
          message: 'This app requires Screen Recording permission',
          detail: 'To capture screenshots, you need to enable Screen Recording permission for this app in System Settings.\n\n' +
            'Steps to enable permission:\n' +
            '1. Click "Open Settings" below\n' +
            '2. Go to Privacy & Security → Screen Recording\n' +
            '3. Find and check the box next to "Capture App"\n' +
            '4. Quit and restart the app\n\n' +
            'Note: If you don\'t see the app in the list, try taking a screenshot first. macOS will then prompt you to grant permission.',
          buttons: ['Open Settings', 'Take Screenshot Anyway', 'Cancel'],
          defaultId: 0,
          cancelId: 2
        });

        if (response.response === 0) {
          // Open System Preferences to the Screen Recording permission
          const { shell } = require('electron');
          shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');

          // Let the user know they should restart the app after granting permission
          dialog.showMessageBox({
            type: 'info',
            title: 'Restart Required',
            message: 'Please restart the app after granting permission',
            buttons: ['OK']
          });
        } else if (response.response === 1) {
          // User wants to try taking a screenshot anyway, which might trigger the system permission dialog
          console.log('User opted to take screenshot without confirmed permission');
          return true;
        }

        return false;
      }

      return true;
    } catch (error) {
      console.error('Error checking screen recording permission:', error);
      return false;
    }
  }

  async checkAndInstallImagesnap() {
    if (process.platform !== 'darwin') {
      // Not needed on non-macOS platforms
      return true;
    }

    try {
      console.log('Checking if imagesnap is installed...');

      // In packaged apps, PATH is restricted - add common brew paths
      if (app.isPackaged) {
        // Add common Homebrew paths to PATH for packaged app
        const homebrewPaths = [
          '/usr/local/bin',
          '/opt/homebrew/bin'
        ];

        // Get current PATH and add Homebrew paths
        const currentPath = process.env.PATH || '';
        process.env.PATH = [...homebrewPaths, currentPath].join(':');
        console.log('Updated PATH for packaged app:', process.env.PATH);
      }

      // First check common installation paths
      const possiblePaths = [
        '/usr/local/bin/imagesnap',
        '/opt/homebrew/bin/imagesnap',
        '/usr/bin/imagesnap'
      ];

      // Check if imagesnap exists in any of the common paths
      for (const imagesnapPath of possiblePaths) {
        try {
          await fs.access(imagesnapPath);
          console.log(`Found imagesnap at: ${imagesnapPath}`);
          return true;
        } catch (err) {
          // Path doesn't exist, continue checking
        }
      }

      // If we get here, try using 'which' to find it
      try {
        const { stdout } = await execAsync('which imagesnap');
        if (stdout && stdout.trim()) {
          console.log(`imagesnap found at: ${stdout.trim()}`);
          return true;
        }
      } catch (whichError) {
        console.log('imagesnap not found in PATH');
      }

      // If packaged app, try to install imagesnap locally in the app's temp directory
      if (app.isPackaged) {
        try {
          const tempDir = app.getPath('temp');
          const localImagesnapDir = path.join(tempDir, 'imagesnap');
          const localImagesnapPath = path.join(localImagesnapDir, 'imagesnap');

          // Create directory if it doesn't exist
          await fs.mkdir(localImagesnapDir, { recursive: true });

          // Check if we already have a local copy
          try {
            await fs.access(localImagesnapPath);
            console.log(`Using local imagesnap at: ${localImagesnapPath}`);

            // Add to PATH
            process.env.PATH = `${localImagesnapDir}:${process.env.PATH}`;
            return true;
          } catch (accessErr) {
            // Local copy doesn't exist, try to download
            console.log('Attempting to download imagesnap binary...');

            const response = await dialog.showMessageBox({
              type: 'info',
              title: 'Camera Setup',
              message: 'The app needs to download imagesnap',
              detail: 'imagesnap is required for camera capture on macOS. Would you like to download and install it now?',
              buttons: ['Download and Install', 'Cancel'],
              defaultId: 0,
              cancelId: 1
            });

            if (response.response === 0) {
              // Create installation script
              const scriptPath = path.join(tempDir, 'install-imagesnap-local.command');
              const scriptContent = `#!/bin/bash
echo "=== MamaTracker: Installing imagesnap ==="
echo ""
echo "This script will download and install imagesnap locally for this app"
echo ""

# Create directory if needed
mkdir -p "${localImagesnapDir}"

# Check if brew is available to install
if command -v brew >/dev/null 2>&1; then
  echo "Homebrew found, installing imagesnap..."
  brew install imagesnap
  
  # Copy to local directory
  if [ -f /usr/local/bin/imagesnap ]; then
    cp /usr/local/bin/imagesnap "${localImagesnapPath}"
    chmod +x "${localImagesnapPath}"
    echo "Copied imagesnap to local directory"
  elif [ -f /opt/homebrew/bin/imagesnap ]; then
    cp /opt/homebrew/bin/imagesnap "${localImagesnapPath}"
    chmod +x "${localImagesnapPath}"
    echo "Copied imagesnap to local directory"
  else
    # Try to find imagesnap
    IMAGESNAP_PATH=$(which imagesnap)
    if [ -n "$IMAGESNAP_PATH" ]; then
      cp "$IMAGESNAP_PATH" "${localImagesnapPath}"
      chmod +x "${localImagesnapPath}"
      echo "Copied imagesnap to local directory"
    else
      echo "Could not find imagesnap to copy"
    fi
  fi
else
  echo "Downloading imagesnap binary directly..."
  # Download directly from GitHub release or alternative source
  curl -L https://github.com/rharder/imagesnap/releases/download/0.2.9/imagesnap-0.2.9 -o "${localImagesnapPath}"
  chmod +x "${localImagesnapPath}"
fi

# Check if installation was successful
if [ -f "${localImagesnapPath}" ] && [ -x "${localImagesnapPath}" ]; then
  echo ""
  echo "✅ imagesnap successfully installed to: ${localImagesnapPath}"
  echo ""
  echo "You can now close this Terminal window and restart the app"
else
  echo ""
  echo "❌ Failed to install imagesnap"
  echo ""
fi

echo ""
echo "Press any key to close this window"
read -n 1
`;

              // Write and execute the script
              await fs.writeFile(scriptPath, scriptContent);
              await fs.chmod(scriptPath, 0o755);

              const { shell } = require('electron');
              shell.openExternal(`file://${scriptPath}`);

              // Inform user to restart the app
              dialog.showMessageBox({
                type: 'info',
                title: 'Restart Required',
                message: 'Please restart the app after installing imagesnap',
                buttons: ['OK']
              });
            }
          }

          return false;
        } catch (localInstallError) {
          console.error('Error setting up local imagesnap:', localInstallError);
        }
      }

      // If we get here, try the normal Homebrew installation flow
      console.log('Attempting normal imagesnap installation...');

      // Check if Homebrew is installed
      try {
        await execAsync('which brew');

        // Try to install with homebrew
        console.log('Homebrew found, attempting to install imagesnap...');
        try {
          await execAsync('brew install imagesnap');
          console.log('Successfully installed imagesnap');
          return true;
        } catch (brewError) {
          console.error('Failed to install imagesnap with Homebrew:', brewError);
        }
      } catch (noBrewError) {
        console.log('Homebrew not found, cannot automatically install imagesnap');
      }

      // If we get here, installation failed or Homebrew not available
      const response = await dialog.showMessageBox({
        type: 'warning',
        title: 'Camera Capture Issue',
        message: 'The "imagesnap" tool is required for camera capture',
        detail: 'Would you like to install it using Terminal?\n\nThis will open Terminal and provide instructions.',
        buttons: ['Open Terminal with Instructions', 'Cancel'],
        defaultId: 0,
        cancelId: 1
      });

      if (response.response === 0) {
        // Create a temporary script to guide the user
        const tmpDir = app.getPath('temp');
        const scriptPath = path.join(tmpDir, 'install-imagesnap.command');

        const scriptContent = `#!/bin/bash
echo "=== MamaTracker: Installing imagesnap ==="
echo ""
echo "This script will check for Homebrew and install imagesnap"
echo ""

# Check if Homebrew is installed
if command -v brew >/dev/null 2>&1; then
  echo "Homebrew is installed, installing imagesnap..."
  brew install imagesnap
  
  # Check if installation was successful
  if command -v imagesnap >/dev/null 2>&1; then
    echo ""
    echo "✅ imagesnap successfully installed!"
    echo ""
    echo "You can now close this Terminal window and restart the app"
  else
    echo ""
    echo "❌ Failed to install imagesnap"
    echo ""
  fi
else
  echo "Homebrew is not installed. Would you like to install it? (y/n)"
  read answer
  if [ "$answer" = "y" ]; then
    echo "Installing Homebrew..."
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/master/install.sh)"
    
    echo "Now installing imagesnap..."
    brew install imagesnap
    
    # Check if installation was successful
    if command -v imagesnap >/dev/null 2>&1; then
      echo ""
      echo "✅ imagesnap successfully installed!"
      echo ""
      echo "You can now close this Terminal window and restart the app"
    else
      echo ""
      echo "❌ Failed to install imagesnap"
      echo ""
    fi
  else
    echo ""
    echo "❌ Homebrew installation declined. Cannot install imagesnap."
    echo ""
  fi
fi

echo ""
echo "Press any key to close this window"
read -n 1
`;

        // Write the script to a temporary file
        await fs.writeFile(scriptPath, scriptContent);
        await fs.chmod(scriptPath, 0o755); // Make executable

        // Open the script in Terminal
        const { shell } = require('electron');
        shell.openExternal(`file://${scriptPath}`);
      }

      return false;
    } catch (error) {
      console.error('Error checking for imagesnap:', error);
      return false;
    }
  }

  async initializeDefaultCamera() {
    try {
      // Enumerate available cameras
      console.log('Enumerating cameras during initialization...');
      const cameras = await this.enumerateCameras();
      console.log('Available cameras:', cameras);

      // Get stored default camera ID
      const storedDefaultId = this.store.get('defaultCameraDeviceId');
      console.log('Stored default camera ID:', storedDefaultId);

      // If no default camera is set but cameras are available, set the first one as default
      if ((!storedDefaultId || storedDefaultId === 'default') && cameras.length > 0) {
        const newDefaultId = cameras[0].device_id;
        this.store.set('defaultCameraDeviceId', newDefaultId);
        console.log('Set default camera to:', newDefaultId);
      } else if (storedDefaultId) {
        // Check if the stored default camera still exists
        const cameraExists = cameras.some(camera => camera.device_id === storedDefaultId);

        if (!cameraExists && cameras.length > 0) {
          // If the stored camera no longer exists, update to the first available
          const newDefaultId = cameras[0].device_id;
          this.store.set('defaultCameraDeviceId', newDefaultId);
          console.log('Updated default camera to:', newDefaultId);
        }
      }
    } catch (error) {
      console.error('Failed to initialize default camera:', error);
    }
  }

  // Method to set default camera
  setDefaultCamera(deviceId) {
    this.defaultCameraId = deviceId;
    this.store.set('defaultCameraId', deviceId);
    console.log('Default camera set to:', deviceId);
  }

  // Screenshot operations
  async captureFullScreen() {
    try {
      console.log('Capturing full screen...');

      // Capture full screen screenshot
      const imageBuffer = await screenshot({ format: 'png' });

      // Save screenshot
      return this.saveScreenshot(imageBuffer, 'screenshot');
    } catch (error) {
      console.error('Full screen capture failed:', error);

      // Check if this might be a permission error
      if (error.message && (
        error.message.includes('permission') ||
        error.message.includes('access') ||
        error.message.includes('screen capture'))) {
        await this.handlePermissionError(error, 'screenshot');
      }

      throw error;
    }
  }

  async captureActiveWindow() {
    try {
      // For macOS, we need to ensure screen recording permission is granted
      if (process.platform === 'darwin') {
        const hasPermission = macPermissions.hasScreenCapturePermission();
        if (!hasPermission) {
          throw new Error('Screen recording permission is required. Please restart the app after granting permission in System Preferences.');
        }

        // Window capture is not well-supported across platforms
        // For now, we'll just capture the full screen on macOS
        return await this.captureFullScreen();
      }

      const img = await screenshot({ format: 'png' });
      return await this.saveScreenshot(img, 'window');
    } catch (error) {
      console.error('Active window capture failed:', error);
      throw error;
    }
  }

  async captureScreenshot(options = {}) {
    const { type = 'fullscreen', saveToDisk = true, includeTimestamp = true } = options;

    try {
      let imageBuffer;

      // Capture based on type
      if (type === 'fullscreen') {
        imageBuffer = await screenshot({ format: 'png' });
      } else if (type === 'window') {
        // For active window capture, we'll use the same method for now
        imageBuffer = await screenshot({ format: 'png' });
      } else {
        throw new Error(`Unknown screenshot type: ${type}`);
      }

      // If we don't need to save to disk, just return the buffer
      if (!saveToDisk) {
        return {
          success: true,
          buffer: imageBuffer
        };
      }

      // Otherwise, save to disk and return file info
      const result = await this.saveScreenshot(imageBuffer, 'screenshot');
      return {
        success: true,
        ...result
      };
    } catch (error) {
      console.error('Screenshot capture failed:', error);

      // Check if this might be a permission error
      if (error.message && (
        error.message.includes('permission') ||
        error.message.includes('access') ||
        error.message.includes('screen capture'))) {
        await this.handlePermissionError(error, 'screenshot');
      }

      return {
        success: false,
        error: error.message
      };
    }
  }

  async saveScreenshot(imageBuffer, captureType) {
    try {
      const timestamp = new Date();
      const dateFolder = this.formatDate(timestamp);

      // Use different prefix for composite images
      const prefix = captureType === 'composite' ? 'COMPOSITE' : 'SCREEN';
      const filename = this.generateFilename(prefix, timestamp, 'png');

      const saveDir = await this.fileManager.ensureDateFolder(dateFolder);
      const filepath = path.join(saveDir, filename);

      // Save the image
      await fs.writeFile(filepath, imageBuffer);

      // Get image metadata using canvas instead of sharp
      const img = await loadImage(imageBuffer);
      const width = img.width;
      const height = img.height;

      // Save to database - wrapped in try/catch to continue even if DB fails
      let dbResult = { id: 0 };
      try {
        const captureData = {
          filename,
          filepath,
          date_folder: dateFolder,
          capture_type: captureType === 'composite' ? 'composite' : 'screenshot',
          capture_mode: 'manual',
          file_size: imageBuffer.length,
          width: width,
          height: height,
          thumbnail_path: null // No longer generating thumbnails
        };

        dbResult = await this.dbManager.insertCapture(captureData);
      } catch (dbError) {
        console.error('Database save failed, but file was saved:', dbError);
      }

      return {
        id: dbResult.id,
        filepath,
        filename,
        thumbnail_path: null,
        metadata: {
          width: width,
          height: height,
          size: imageBuffer.length
        }
      };
    } catch (error) {
      console.error('Screenshot save failed:', error);
      throw error;
    }
  }

  // Camera operations
  async enumerateCameras() {
    try {
      console.log('Enumerating cameras...');

      if (process.platform === 'darwin') {
        // On macOS, we'll use the imagesnap tool to list available devices
        // First make sure imagesnap is installed
        await this.checkAndInstallImagesnap();

        return new Promise((resolve, reject) => {
          // Get PATH to ensure imagesnap can be found
          const pathEnv = process.env.PATH || '';
          console.log('Current PATH:', pathEnv);

          // Try to find imagesnap in common locations
          let imagesnap = 'imagesnap';

          // In production builds, we might need to handle paths differently
          const isPackaged = app.isPackaged;
          console.log('App is packaged:', isPackaged);

          // Check if we can use imagesnap directly
          exec('which imagesnap', async (whichErr, whichStdout) => {
            if (whichErr) {
              console.log('imagesnap not found in PATH, falling back to default camera');
              resolve([{
                device_id: 'default',
                device_name: 'Default Camera',
                device_type: 'camera'
              }]);
              return;
            }

            const imagesnapPath = whichStdout.trim();
            console.log('Found imagesnap at:', imagesnapPath);

            // Now use the full path to imagesnap
            exec(`${imagesnapPath} -l`, (error, stdout, stderr) => {
              if (error) {
                console.error('Failed to enumerate cameras using imagesnap:', error);
                // Fallback to default camera
                resolve([{
                  device_id: 'default',
                  device_name: 'Default Camera',
                  device_type: 'camera'
                }]);
                return;
              }

              console.log('Available cameras from imagesnap:', stdout);

              const devices = [];
              const lines = stdout.split('\n');

              // Parse the output to find camera devices
              // Format is like:
              // Video Devices:
              // => FaceTime HD Camera (Built-in)
              // => Iriun Camera
              let foundDevices = false;
              for (const line of lines) {
                if (line.trim().startsWith('=>')) {
                  foundDevices = true;
                  const deviceName = line.replace('=>', '').trim();
                  devices.push({
                    device_id: deviceName,
                    device_name: deviceName,
                    device_type: 'camera'
                  });
                }
              }

              if (!foundDevices) {
                // If no devices found but command succeeded, add a default device
                devices.push({
                  device_id: 'default',
                  device_name: 'Default Camera',
                  device_type: 'camera'
                });
              }

              resolve(devices);
            });
          });
        });
      } else {
        // For non-macOS platforms, use node-webcam to enumerate devices
        try {
          const NodeWebcam = require('node-webcam');

          // Wrap list in a promise
          const getCameras = () => {
            return new Promise((resolve) => {
              NodeWebcam.list((list) => {
                resolve(list);
              });
            });
          };

          const devices = await getCameras() || [];

          if (devices.length === 0) {
            return [{
              device_id: '0',
              device_name: 'Default Camera',
              device_type: 'camera'
            }];
          }

          return devices.map((device, index) => {
            // NodeWebcam.list() on Windows might return strings or objects depending on the backend
            // If it's a string, use it as both ID and Name
            if (typeof device === 'string') {
              return {
                device_id: device,
                device_name: device,
                device_type: 'camera'
              };
            }

            // If it's an object, try to find id/name
            return {
              device_id: device.id || device.name || index.toString(),
              device_name: device.name || device.label || `Camera ${index + 1}`,
              device_type: 'camera'
            };
          });
        } catch (webcamError) {
          console.error('Failed to enumerate webcams:', webcamError);
          return [{
            device_id: '0',
            device_name: 'Default Camera',
            device_type: 'camera'
          }];
        }
      }
    } catch (error) {
      console.error('Camera enumeration failed:', error);
      return [{
        device_id: 'default',
        device_name: 'Default Camera (Fallback)',
        device_type: 'camera'
      }];
    }
  }

  async capturePhoto(deviceId = null) {
    try {
      console.log('Attempting camera capture...');

      // Use default camera if none specified
      const cameraId = deviceId || this.defaultCameraId || false;
      console.log('Using camera ID:', cameraId);

      const timestamp = new Date();
      const dateFolder = this.formatDate(timestamp);
      const filename = this.generateFilename('CAMERA', timestamp, 'jpg');

      const saveDir = await this.fileManager.ensureDateFolder(dateFolder);
      const filepath = path.join(saveDir, filename);

      const webcamOptions = {
        ...this.webcamOptions,
        device: cameraId
      };

      // On macOS, we need different settings
      if (process.platform === 'darwin') {
        if (cameraId === 'default') {
          // Use no specific device for default
          webcamOptions.device = false;
        } else if (cameraId) {
          // Use the specific device ID
          webcamOptions.device = cameraId;
        } else {
          // No device specified, use false to let imagesnap pick the default
          webcamOptions.device = false;
        }
      }

      console.log('Webcam options:', webcamOptions);
      const webcam = NodeWebcam.create(webcamOptions);

      // Capture photo
      const tempPath = await new Promise((resolve, reject) => {
        webcam.capture(filename, (err, data) => {
          if (err) {
            console.error('Webcam capture error:', err);
            reject(new Error(`Camera capture failed: ${err.message || err}`));
          } else {
            console.log('Camera capture successful, temp path:', data);
            resolve(data);
          }
        });
      });

      // Move from temp location to our organized structure
      const imageBuffer = await fs.readFile(tempPath);
      await fs.writeFile(filepath, imageBuffer);
      await fs.unlink(tempPath); // Clean up temp file

      // Get image metadata using canvas
      const img = await loadImage(imageBuffer);
      const width = img.width;
      const height = img.height;

      // Save to database - wrapped in try/catch to continue even if DB fails
      let dbResult = { id: 0 };
      try {
        const captureData = {
          filename,
          filepath,
          date_folder: dateFolder,
          capture_type: 'camera',
          capture_mode: 'manual',
          file_size: imageBuffer.length,
          width: width,
          height: height,
          device_info: { device_id: cameraId || 'default' },
          thumbnail_path: null // No longer generating thumbnails
        };

        dbResult = await this.dbManager.insertCapture(captureData);
      } catch (dbError) {
        console.error('Database save failed, but file was saved:', dbError);
      }

      return {
        id: dbResult.id,
        filepath,
        filename,
        thumbnail_path: null,
        metadata: {
          width: metadata.width,
          height: metadata.height,
          size: imageBuffer.length
        }
      };
    } catch (error) {
      console.error('Camera capture failed:', error);

      // Check if this might be a permission error
      if (error.message && (
        error.message.includes('permission') ||
        error.message.includes('access') ||
        error.message.includes('imagesnap'))) {
        await this.handlePermissionError(error, 'camera');
      }

      throw error;
    }
  }

  async captureCamera(deviceId = null) {
    return await this.capturePhoto(deviceId);
  }

  // Utility methods
  formatDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  generateFilename(prefix, timestamp, extension) {
    const year = timestamp.getFullYear();
    const month = String(timestamp.getMonth() + 1).padStart(2, '0');
    const day = String(timestamp.getDate()).padStart(2, '0');
    const hours = String(timestamp.getHours()).padStart(2, '0');
    const minutes = String(timestamp.getMinutes()).padStart(2, '0');
    const seconds = String(timestamp.getSeconds()).padStart(2, '0');

    return `${prefix}-${year}-${month}-${day}_${hours}-${minutes}-${seconds}.${extension}`;
  }

  // Interval capture support
  async captureForInterval(sessionId, captureType, deviceId = null) {
    try {
      let result;

      if (captureType === 'screenshot') {
        result = await this.captureFullScreen();
      } else if (captureType === 'camera') {
        result = await this.capturePhoto(deviceId);
      } else if (captureType === 'both') {
        // Capture both screenshot and camera
        result = await this.captureBoth(deviceId, sessionId);
      } else if (captureType === 'composite') {
        // Capture a composite image with screenshot and camera overlay
        result = await this.takeCompositeCapture({ deviceId, sessionId, captureMode: 'interval' });
      } else {
        throw new Error(`Unknown capture type: ${captureType}`);
      }

      // We no longer need to increment session captures here
      // It's now handled by the IntervalManager

      return result;
    } catch (error) {
      console.error('Interval capture failed:', error);
      throw error;
    }
  }

  // New method to capture both screenshot and camera
  async captureBoth(deviceId = null, sessionId = null) {
    try {
      console.log('Capturing both screenshot and camera...');

      // First, try to capture screenshot
      let screenshotResult = null;
      let cameraResult = null;

      try {
        screenshotResult = await this.captureFullScreen();
      } catch (screenshotError) {
        console.error('Screenshot capture failed in combined capture:', screenshotError);
      }

      // Then try to capture camera
      try {
        cameraResult = await this.capturePhoto(deviceId);
      } catch (cameraError) {
        console.error('Camera capture failed in combined capture:', cameraError);
      }

      // If both failed, throw an error
      if (!screenshotResult && !cameraResult) {
        throw new Error('Both screenshot and camera captures failed');
      }

      // Return the results
      return {
        screenshot: screenshotResult,
        camera: cameraResult,
        // Return the screenshot as the primary result, fallback to camera if screenshot failed
        ...(screenshotResult || cameraResult)
      };
    } catch (error) {
      console.error('Combined capture failed:', error);
      throw error;
    }
  }

  async capturePhotoBuffer(deviceId = null) {
    try {
      console.log('Attempting camera capture to buffer...');

      // Use default camera if none specified
      const cameraId = deviceId || this.defaultCameraId || false;
      console.log('Using camera ID for buffer capture:', cameraId);

      const webcamOptions = {
        ...this.webcamOptions,
        device: cameraId,
        output: 'buffer'
      };

      // On macOS, we need different settings
      if (process.platform === 'darwin') {
        if (cameraId === 'default') {
          // Use no specific device for default
          webcamOptions.device = false;
        } else if (cameraId) {
          // Use the specific device ID
          webcamOptions.device = cameraId;
        } else {
          // No device specified, use false to let imagesnap pick the default
          webcamOptions.device = false;
        }
      }

      console.log('Webcam options:', webcamOptions);
      const webcam = NodeWebcam.create(webcamOptions);

      // Capture photo to buffer
      return new Promise((resolve, reject) => {
        webcam.capture('temp', (err, data) => {
          if (err) {
            console.error('Webcam capture error:', err);
            reject(new Error(`Camera capture failed: ${err.message || err}`));
          } else {
            fs.readFile(data)
              .then(buffer => {
                fs.unlink(data).catch(err => console.error('Failed to delete temp file:', err));
                resolve(buffer);
              })
              .catch(err => {
                console.error('Failed to read camera buffer:', err);
                reject(err);
              });
          }
        });
      });
    } catch (error) {
      console.error('Camera capture to buffer failed:', error);

      // Check if this might be a permission error
      if (error.message && (
        error.message.includes('permission') ||
        error.message.includes('access') ||
        error.message.includes('imagesnap'))) {
        await this.handlePermissionError(error, 'camera');
      }

      throw error;
    }
  }



  async handlePermissionError(error, captureType) {
    console.error(`Permission error for ${captureType} capture:`, error);

    if (process.platform === 'darwin') {
      // Check current permissions
      const screenAccess = systemPreferences.getMediaAccessStatus('screen');
      const cameraAccess = systemPreferences.getMediaAccessStatus('camera');
      console.log(`Current permissions - Screen: ${screenAccess}, Camera: ${cameraAccess}`);

      // If permissions are already granted but still getting errors, provide alternative guidance
      if ((captureType === 'screenshot' && screenAccess === 'granted') ||
        (captureType === 'camera' && cameraAccess === 'granted') ||
        (captureType === 'composite' && screenAccess === 'granted' && cameraAccess === 'granted')) {

        // Show alternative instructions for when permissions are granted but not working
        const response = await dialog.showMessageBox({
          type: 'info',
          title: 'Permission Issue',
          message: 'Permissions appear to be granted but still having issues',
          detail: 'Try these steps:\n\n' +
            '1. Quit the app completely\n' +
            '2. Open Terminal and run: killall Capture\\ App\n' +
            '3. Open System Settings → Privacy & Security\n' +
            '4. Under Screen Recording and Camera, toggle the permission OFF and then back ON\n' +
            '5. Restart your computer\n' +
            '6. Launch the app again\n\n' +
            'For camera issues, also check if imagesnap is installed by running "which imagesnap" in Terminal.',
          buttons: ['Open Terminal', 'Open Privacy Settings', 'Cancel'],
          defaultId: 0,
          cancelId: 2
        });

        if (response.response === 0) {
          const { shell } = require('electron');
          shell.openExternal('file:///Applications/Utilities/Terminal.app');
        } else if (response.response === 1) {
          const { shell } = require('electron');
          shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy');
        }

        return;
      }

      // Default case for when permissions are not granted
      let message = 'Permission error';
      let detail = 'Please check app permissions in System Settings.';

      if (captureType === 'screenshot' && screenAccess !== 'granted') {
        message = 'Screen Recording Permission Required';
        detail = 'This app needs screen recording permission. Please open System Settings → Privacy & Security → Screen Recording, and enable this app.';
      } else if ((captureType === 'camera' || captureType === 'composite') && cameraAccess !== 'granted') {
        message = 'Camera Permission Required';
        detail = 'This app needs camera permission. Please open System Settings → Privacy & Security → Camera, and enable this app.';
      } else if (captureType === 'composite' && (screenAccess !== 'granted' || cameraAccess !== 'granted')) {
        message = 'Multiple Permissions Required';
        detail = 'Composite capture requires both screen recording and camera permissions. Please check both in System Settings → Privacy & Security.';
      }

      // Show permission guidance dialog
      const response = await dialog.showMessageBox({
        type: 'warning',
        title: 'Permission Error',
        message: message,
        detail: detail + '\n\nAfter granting permissions, please restart the app.',
        buttons: ['Open Privacy Settings', 'Cancel'],
        defaultId: 0,
        cancelId: 1
      });

      if (response.response === 0) {
        const { shell } = require('electron');
        shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy');
      }
    }
  }

  async takeCameraPhoto(options = {}) {
    try {
      console.log('Taking camera photo with options:', options);

      // Check for camera permission on macOS
      if (process.platform === 'darwin') {
        const cameraAccess = systemPreferences.getMediaAccessStatus('camera');
        console.log(`Camera access status: ${cameraAccess}`);

        if (cameraAccess !== 'granted') {
          console.log('Requesting camera permission...');
          const hasAccess = await systemPreferences.askForMediaAccess('camera');
          console.log(`Camera permission request result: ${hasAccess}`);

          if (!hasAccess) {
            throw new Error('Camera permission denied');
          }
        }

        // Check for imagesnap on macOS, which is required for camera access
        const imagesnapAvailable = await this.checkAndInstallImagesnap();
        if (!imagesnapAvailable) {
          throw new Error('imagesnap not available, which is required for camera capture on macOS');
        }
      }

      // Get selected camera device
      const deviceId = options.deviceId || this.store.get('defaultCameraDeviceId');
      console.log(`Using camera device ID: ${deviceId || 'default'}`);

      // Get timestamp and filename
      const timestamp = new Date();
      const dateStr = format(timestamp, 'yyyy-MM-dd');
      const timeStr = format(timestamp, 'HH-mm-ss');

      // Generate filename
      const filename = `CAMERA-${dateStr}_${timeStr}.jpg`;

      // Use the same directory creation method as other captures
      const saveDir = await this.fileManager.ensureDateFolder(dateStr);
      const filepath = path.join(saveDir, filename);

      console.log(`Saving camera photo to: ${filepath}`);

      // Capture photo using appropriate method for the platform
      let success = false;

      if (process.platform === 'darwin') {
        // Use imagesnap on macOS
        try {
          // Get imagesnap path
          let imagesnapPath = 'imagesnap';

          // Try to find imagesnap with which
          try {
            const { stdout } = await execAsync('which imagesnap');
            if (stdout && stdout.trim()) {
              imagesnapPath = stdout.trim();
            }
          } catch (whichErr) {
            console.log('Could not find imagesnap with which, trying common paths');

            // Check common paths
            const possiblePaths = [
              '/usr/local/bin/imagesnap',
              '/opt/homebrew/bin/imagesnap',
              '/usr/bin/imagesnap',
              path.join(app.getPath('temp'), 'imagesnap', 'imagesnap')
            ];

            for (const possiblePath of possiblePaths) {
              try {
                await fs.access(possiblePath);
                imagesnapPath = possiblePath;
                console.log(`Found imagesnap at: ${imagesnapPath}`);
                break;
              } catch (err) {
                // Continue checking
              }
            }
          }

          console.log(`Using imagesnap at: ${imagesnapPath}`);

          // Build command
          let command = `"${imagesnapPath}"`;

          // Add device selection if specified
          if (deviceId) {
            command += ` -d "${deviceId}"`;
          }

          // Add output path
          command += ` "${filepath}"`;

          console.log(`Executing: ${command}`);
          await execAsync(command);

          // Verify file was created
          try {
            await fs.access(filepath);
            success = true;
            console.log(`Successfully created file: ${filepath}`);
          } catch (fileAccessErr) {
            console.error(`File access error: ${fileAccessErr.message}`);
            throw new Error(`Camera capture completed but file not found at: ${filepath}`);
          }
        } catch (error) {
          console.error('Error capturing with imagesnap:', error);
          // Try alternate method if imagesnap fails
          throw new Error(`imagesnap error: ${error.message}`);
        }
      } else {
        // Use CommandCam.exe directly on Windows to handle paths with spaces correctly
        // node-webcam's command builder doesn't quote paths, breaking on spaces
        const commandCamPath = path.join(
          path.dirname(require.resolve('node-webcam')),
          'src', 'bindings', 'CommandCam', 'CommandCam.exe'
        );

        let cmd = `"${commandCamPath}"`;
        if (deviceId && deviceId !== 'default') {
          cmd += ` /devnum ${deviceId}`;
        }
        cmd += ` /filename "${filepath}"`;

        console.log(`Executing CommandCam: ${cmd}`);
        await execAsync(cmd);

        // Verify file exists
        try {
          await fs.access(filepath);
          success = true;
          console.log(`Successfully created file: ${filepath}`);
        } catch (fileAccessErr) {
          console.error(`File access error: ${fileAccessErr.message}`);
          throw new Error(`Camera capture completed but file not found at: ${filepath}`);
        }
      }

      if (!success) {
        throw new Error('Failed to save camera photo');
      }

      // Save to database
      const captureRecord = {
        filename,
        filepath,
        date_folder: dateStr,
        capture_type: 'camera',
        capture_mode: options.captureMode || 'manual',
        interval_session_id: options.sessionId || null,
        timestamp: timestamp.toISOString(),
        device_info: deviceId ? JSON.stringify({ deviceId }) : null
      };

      await this.dbManager.insertCapture(captureRecord);
      console.log('Camera photo saved to database');

      return {
        success: true,
        filepath,
        filename,
        timestamp
      };
    } catch (error) {
      console.error('Error in takeCameraPhoto:', error);

      // Check if this is a permission error
      if (error.message.includes('permission') ||
        error.message.includes('access') ||
        error.message.includes('denied')) {
        await this.handlePermissionError(error, 'camera');
      } else {
        // Generic error handling
        dialog.showMessageBox({
          type: 'error',
          title: 'Camera Capture Error',
          message: 'Failed to capture camera photo',
          detail: `Error: ${error.message}`,
          buttons: ['OK']
        });
      }

      return {
        success: false,
        error: error.message
      };
    }
  }

  async takeCompositeCapture(options = {}) {
    try {
      console.log('Taking composite capture with options:', options);

      // Check both permissions on macOS
      if (process.platform === 'darwin') {
        // Check screen recording permission
        const screenAccess = systemPreferences.getMediaAccessStatus('screen');
        console.log(`Screen recording access status: ${screenAccess}`);

        if (screenAccess !== 'granted') {
          throw new Error('Screen recording permission required for composite capture');
        }

        // Check camera permission
        const cameraAccess = systemPreferences.getMediaAccessStatus('camera');
        console.log(`Camera access status: ${cameraAccess}`);

        if (cameraAccess !== 'granted') {
          console.log('Requesting camera permission...');
          const hasAccess = await systemPreferences.askForMediaAccess('camera');
          console.log(`Camera permission request result: ${hasAccess}`);

          if (!hasAccess) {
            throw new Error('Camera permission denied for composite capture');
          }
        }

        // Check for imagesnap on macOS
        const imagesnapAvailable = await this.checkAndInstallImagesnap();
        if (!imagesnapAvailable) {
          throw new Error('imagesnap not available, which is required for camera capture on macOS');
        }
      }

      // Get camera device ID
      const deviceId = options.deviceId || this.store.get('defaultCameraDeviceId');

      // Get timestamp for both captures
      const timestamp = new Date();
      const dateStr = format(timestamp, 'yyyy-MM-dd');
      const timeStr = format(timestamp, 'HH-mm-ss');

      // Generate filename for composite image
      const filename = `COMPOSITE-${dateStr}_${timeStr}.png`;

      // Use the same directory creation method as other captures
      const saveDir = await this.fileManager.ensureDateFolder(dateStr);
      const filepath = path.join(saveDir, filename);

      console.log(`Saving composite image to: ${filepath}`);

      // Take screenshot first
      const screenshotResult = await this.captureScreenshot({
        includeTimestamp: false, // We'll add it to the composite
        saveToDisk: false // Just get the buffer
      });

      if (!screenshotResult.success) {
        throw new Error(`Screenshot failed: ${screenshotResult.error}`);
      }

      // Create a unique temp directory for this capture
      const tempDir = app.getPath('temp');
      const tempCaptureDir = path.join(tempDir, `composite-${Date.now()}`);
      await fs.mkdir(tempCaptureDir, { recursive: true });

      // Create a unique temp file path for the camera capture
      const tempCameraPath = path.join(tempCaptureDir, `temp-camera-${Date.now()}.jpg`);
      console.log(`Using temporary camera file: ${tempCameraPath}`);

      // Take camera photo to the temporary file
      let cameraSuccess = false;

      if (process.platform === 'darwin') {
        // Use imagesnap on macOS
        try {
          // Get imagesnap path
          let imagesnapPath = 'imagesnap';

          // Try to find imagesnap with which
          try {
            const { stdout } = await execAsync('which imagesnap');
            if (stdout && stdout.trim()) {
              imagesnapPath = stdout.trim();
            }
          } catch (whichErr) {
            console.log('Could not find imagesnap with which, trying common paths');

            // Check common paths
            const possiblePaths = [
              '/usr/local/bin/imagesnap',
              '/opt/homebrew/bin/imagesnap',
              '/usr/bin/imagesnap',
              path.join(app.getPath('temp'), 'imagesnap', 'imagesnap')
            ];

            for (const possiblePath of possiblePaths) {
              try {
                await fs.access(possiblePath);
                imagesnapPath = possiblePath;
                console.log(`Found imagesnap at: ${imagesnapPath}`);
                break;
              } catch (err) {
                // Continue checking
              }
            }
          }

          // Build command
          let command = `"${imagesnapPath}"`;

          // Add device selection if specified
          if (deviceId) {
            command += ` -d "${deviceId}"`;
          }

          // Add output path
          command += ` "${tempCameraPath}"`;

          console.log(`Executing: ${command}`);
          await execAsync(command);

          // Verify file was created
          try {
            await fs.access(tempCameraPath);
            cameraSuccess = true;
            console.log(`Successfully created temp camera file: ${tempCameraPath}`);
          } catch (fileAccessErr) {
            console.error(`Temp camera file access error: ${fileAccessErr.message}`);
            throw new Error(`Camera capture completed but file not found at: ${tempCameraPath}`);
          }
        } catch (error) {
          console.error('Error capturing with imagesnap:', error);
          throw new Error(`imagesnap error: ${error.message}`);
        }
      } else {
        // Use CommandCam.exe directly on Windows to handle paths with spaces correctly
        const commandCamPath = path.join(
          path.dirname(require.resolve('node-webcam')),
          'src', 'bindings', 'CommandCam', 'CommandCam.exe'
        );

        let cmd = `"${commandCamPath}"`;
        if (deviceId && deviceId !== 'default') {
          cmd += ` /devnum ${deviceId}`;
        }
        cmd += ` /filename "${tempCameraPath}"`;

        console.log(`Executing CommandCam for composite: ${cmd}`);
        await execAsync(cmd);

        // Verify file exists
        try {
          await fs.access(tempCameraPath);
          cameraSuccess = true;
          console.log(`Successfully created temp camera file: ${tempCameraPath}`);
        } catch (fileAccessErr) {
          console.error(`Temp camera file access error: ${fileAccessErr.message}`);
          throw new Error(`Camera capture completed but file not found at: ${tempCameraPath}`);
        }
      }

      if (!cameraSuccess) {
        throw new Error('Failed to capture camera image for composite');
      }

      // Create canvas for composite image
      const { createCanvas, loadImage } = require('canvas');

      try {
        // Load the screenshot and camera images
        console.log('Loading screenshot and camera images into canvas');
        const screenshotImage = await loadImage(screenshotResult.buffer);
        const cameraImage = await loadImage(tempCameraPath);

        // Create canvas with screenshot dimensions
        const canvas = createCanvas(screenshotImage.width, screenshotImage.height);
        const ctx = canvas.getContext('2d');

        // Draw screenshot as background
        ctx.drawImage(screenshotImage, 0, 0);

        // Calculate camera overlay size and position (bottom right corner)
        const maxWidth = screenshotImage.width * 0.25; // Max 25% of screenshot width
        const maxHeight = screenshotImage.height * 0.25; // Max 25% of screenshot height

        // Calculate aspect ratio-preserving dimensions
        let cameraWidth, cameraHeight;
        if (cameraImage.width / cameraImage.height > maxWidth / maxHeight) {
          // Camera is wider than the max area
          cameraWidth = maxWidth;
          cameraHeight = (cameraImage.height / cameraImage.width) * maxWidth;
        } else {
          // Camera is taller than the max area
          cameraHeight = maxHeight;
          cameraWidth = (cameraImage.width / cameraImage.height) * maxHeight;
        }

        // Position in bottom right with padding
        const paddingX = 20;
        const paddingY = 20;
        const cameraX = screenshotImage.width - cameraWidth - paddingX;
        const cameraY = screenshotImage.height - cameraHeight - paddingY;

        // Draw camera image with a border
        ctx.fillStyle = '#FFFFFF'; // White border
        ctx.fillRect(cameraX - 5, cameraY - 5, cameraWidth + 10, cameraHeight + 10);
        ctx.drawImage(cameraImage, cameraX, cameraY, cameraWidth, cameraHeight);

        // Add timestamp text
        ctx.font = 'bold 48px Arial';
        ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';

        // Create a semi-transparent background for the text
        const timeText = format(timestamp, 'yyyy-MM-dd HH:mm:ss');
        const textMetrics = ctx.measureText(timeText);
        const textWidth = textMetrics.width;
        const textHeight = 60;
        const textX = 30;
        const textY = 80;

        ctx.fillRect(textX - 10, textY - textHeight, textWidth + 20, textHeight + 10);

        // Draw the text
        ctx.fillStyle = '#000000';
        ctx.fillText(timeText, textX, textY);

        // Save the composite image
        console.log('Saving composite image to:', filepath);
        const buffer = canvas.toBuffer('image/png');
        await fs.writeFile(filepath, buffer);

        // Clean up temporary file and directory
        try {
          await fs.unlink(tempCameraPath);
          await fs.rmdir(tempCaptureDir, { recursive: true });
        } catch (unlinkError) {
          console.warn('Failed to clean up temporary files:', unlinkError);
        }

        // Save to database
        const captureRecord = {
          filename,
          filepath,
          date_folder: dateStr,
          capture_type: 'composite',
          capture_mode: options.captureMode || 'manual',
          interval_session_id: options.sessionId || null,
          timestamp: timestamp.toISOString(),
          device_info: deviceId ? JSON.stringify({ deviceId }) : null
        };

        await this.dbManager.insertCapture(captureRecord);
        console.log('Composite capture saved to database');

        return {
          success: true,
          filepath,
          filename,
          timestamp
        };
      } catch (canvasError) {
        console.error('Error creating composite image with canvas:', canvasError);
        throw new Error(`Failed to create composite image: ${canvasError.message}`);
      }
    } catch (error) {
      console.error('Error in takeCompositeCapture:', error);

      // Check if this is a permission error
      if (error.message.includes('permission') ||
        error.message.includes('access') ||
        error.message.includes('denied')) {
        await this.handlePermissionError(error, 'composite');
      } else {
        // Generic error handling
        dialog.showMessageBox({
          type: 'error',
          title: 'Composite Capture Error',
          message: 'Failed to create composite image',
          detail: `Error: ${error.message}`,
          buttons: ['OK']
        });
      }

      return {
        success: false,
        error: error.message
      };
    }
  }

  async ensureDirectoryExists(dirPath) {
    try {
      console.log(`Ensuring directory exists: ${dirPath}`);

      // Check if directory already exists
      try {
        const stats = await fs.stat(dirPath);
        if (stats.isDirectory()) {
          console.log(`Directory already exists: ${dirPath}`);
          return true;
        } else {
          console.warn(`Path exists but is not a directory: ${dirPath}`);
          throw new Error(`Path exists but is not a directory: ${dirPath}`);
        }
      } catch (statError) {
        // Directory does not exist, create it
        if (statError.code === 'ENOENT') {
          console.log(`Creating directory: ${dirPath}`);

          // First check if parent directory exists
          const parentDir = path.dirname(dirPath);
          if (parentDir !== dirPath) { // Avoid infinite recursion
            await this.ensureDirectoryExists(parentDir);
          }

          // Now create the directory
          try {
            await fs.mkdir(dirPath, { recursive: true });

            // Verify directory was created
            try {
              const stats = await fs.stat(dirPath);
              if (stats.isDirectory()) {
                console.log(`Successfully created directory: ${dirPath}`);
                return true;
              } else {
                throw new Error(`Failed to create directory, path is not a directory: ${dirPath}`);
              }
            } catch (verifyError) {
              console.error(`Error verifying directory creation: ${verifyError.message}`);
              throw new Error(`Failed to verify directory creation: ${dirPath}`);
            }
          } catch (mkdirError) {
            console.error(`Error creating directory: ${mkdirError.message}`);

            // If directory creation failed, check if it's due to permissions
            if (mkdirError.code === 'EACCES') {
              throw new Error(`Permission denied creating directory: ${dirPath}`);
            }

            // Try alternative approach for creating date folders
            if (path.basename(dirPath).match(/^\d{4}-\d{2}-\d{2}$/)) {
              // This is a date folder, try creating in Pictures directory as fallback
              const fallbackPath = path.join(app.getPath('pictures'), path.basename(dirPath));
              console.log(`Trying fallback directory: ${fallbackPath}`);

              try {
                await fs.mkdir(fallbackPath, { recursive: true });
                // Update saveDirectory to use fallback location
                this.saveDirectory = app.getPath('pictures');
                this.store.set('saveDirectory', this.saveDirectory);
                console.log(`Using fallback save directory: ${this.saveDirectory}`);

                // Inform user of location change
                dialog.showMessageBox({
                  type: 'info',
                  title: 'Save Location Changed',
                  message: 'Using Pictures folder as fallback',
                  detail: `Could not create directory at original location. Files will be saved to ${fallbackPath} instead.`,
                  buttons: ['OK']
                });

                return true;
              } catch (fallbackError) {
                console.error(`Fallback directory creation failed: ${fallbackError.message}`);
                throw new Error(`Could not create directory at original or fallback location`);
              }
            }

            throw mkdirError;
          }
        } else {
          // Some other error occurred
          console.error(`Error checking directory: ${statError.message}`);
          throw statError;
        }
      }
    } catch (error) {
      console.error(`ensureDirectoryExists error: ${error.message}`);

      // Show error dialog with detailed information
      dialog.showMessageBox({
        type: 'error',
        title: 'Directory Error',
        message: 'Failed to create or access save directory',
        detail: `Error: ${error.message}\n\nPath: ${dirPath}\n\nPlease check app permissions and try a different save location.`,
        buttons: ['OK']
      });

      throw error;
    }
  }
}

module.exports = { CaptureManager }; 