const screenshot = require('screenshot-desktop');
const NodeWebcam = require('node-webcam');
const sharp = require('sharp');
const path = require('path');
const fs = require('fs').promises;
const { DatabaseManager } = require('../database/database-manager');
const { FileManager } = require('../file-manager/file-manager');
const { systemPreferences, dialog, BrowserWindow } = require('electron');
const macPermissions = require('mac-screen-capture-permissions');
const { createCanvas, loadImage, registerFont } = require('canvas');

class CaptureManager {
  constructor(dbManager = null) {
    this.dbManager = dbManager || new DatabaseManager();
    this.fileManager = new FileManager();
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
  }

  async initialize() {
    if (!this.dbManager.db) {
      await this.dbManager.initialize();
    }
    
    // Check screen recording permission on macOS
    if (process.platform === 'darwin') {
      await this.checkMacOSScreenRecordingPermission();
    }
  }

  // Check if screen recording permission is granted on macOS
  async checkMacOSScreenRecordingPermission() {
    if (process.platform === 'darwin') {
      console.log('Checking macOS screen recording permission...');
      
      // Use the mac-screen-capture-permissions module to check permissions
      const hasPermission = macPermissions.hasScreenCapturePermission();
      console.log('Has screen capture permission:', hasPermission);
      
      if (!hasPermission) {
        console.warn('Screen recording permission not granted on macOS');
        
        const response = await dialog.showMessageBox({
          type: 'warning',
          title: 'Screen Recording Permission Required',
          message: 'This app needs screen recording permission to capture screenshots.',
          detail: 'Please follow these steps:\n\n1. Click "Request Permission" below\n2. In the System Preferences dialog, check the box next to this app\n3. Restart the app after granting permission',
          buttons: ['Request Permission', 'Cancel'],
          defaultId: 0,
          cancelId: 1
        });
        
        if (response.response === 0) {
          // Request permission using the module
          macPermissions.askForScreenCaptureAccess();
        }
        
        return false;
      }
      return true;
    }
    return true; // Not macOS, so no special permission needed
  }

  // Screenshot operations
  async captureFullScreen() {
    try {
      console.log('Attempting full screen capture...');
      
      // For macOS, we need to ensure screen recording permission is granted
      if (process.platform === 'darwin') {
        const hasPermission = macPermissions.hasScreenCapturePermission();
        if (!hasPermission) {
          throw new Error('Screen recording permission is required. Please restart the app after granting permission in System Preferences.');
        }
      }
      
      // On macOS, we need to specify different capture options
      let options = { format: 'png' };
      
      if (process.platform === 'darwin') {
        // Use specific macOS configuration
        // The key is to specify a display ID rather than using the default
        const displays = await screenshot.listDisplays();
        console.log('Available displays:', displays);
        
        if (displays && displays.length > 0) {
          // Capture the primary display
          options.screen = displays[0].id;
        }
      }
      
      console.log('Using screenshot options:', options);
      const img = await screenshot(options);
      console.log('Screenshot captured, buffer size:', img.length);
      
      return await this.saveScreenshot(img, 'fullscreen');
    } catch (error) {
      console.error('Full screen capture failed:', error);
      console.error('Error details:', error.message);
      throw new Error(`Screenshot failed: ${error.message}`);
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
    const { type = 'fullscreen' } = options;
    
    switch (type) {
      case 'fullscreen':
        return await this.captureFullScreen();
      case 'window':
        return await this.captureActiveWindow();
      default:
        throw new Error(`Unknown screenshot type: ${type}`);
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
      
      // Get image metadata
      const metadata = await sharp(imageBuffer).metadata();
      
      // Save to database
      const captureData = {
        filename,
        filepath,
        date_folder: dateFolder,
        capture_type: captureType === 'composite' ? 'composite' : 'screenshot',
        capture_mode: 'manual',
        file_size: imageBuffer.length,
        width: metadata.width,
        height: metadata.height,
        thumbnail_path: null // No longer generating thumbnails
      };
      
      const dbResult = await this.dbManager.insertCapture(captureData);
      
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
      console.error('Screenshot save failed:', error);
      throw error;
    }
  }

  // Camera operations
  async enumerateCameras() {
    try {
      if (process.platform === 'darwin') {
        // On macOS, we'll use the imagesnap tool to list available devices
        const { exec } = require('child_process');
        
        return new Promise((resolve, reject) => {
          exec('imagesnap -l', (error, stdout, stderr) => {
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
      } else {
        // For non-macOS platforms, return a default camera for now
        return [{
          device_id: '0',
          device_name: 'Default Camera',
          device_type: 'camera'
        }];
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
      
      const timestamp = new Date();
      const dateFolder = this.formatDate(timestamp);
      const filename = this.generateFilename('CAMERA', timestamp, 'jpg');
      
      const saveDir = await this.fileManager.ensureDateFolder(dateFolder);
      const filepath = path.join(saveDir, filename);
      
      const webcamOptions = {
        ...this.webcamOptions,
        device: deviceId || false
      };
      
      // On macOS, we need different settings
      if (process.platform === 'darwin') {
        if (deviceId === 'default') {
          // Use no specific device for default
          webcamOptions.device = false;
        } else if (deviceId) {
          // Use the specific device ID
          webcamOptions.device = deviceId;
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
      
      // Get image metadata
      const metadata = await sharp(imageBuffer).metadata();
      
      // Save to database
      const captureData = {
        filename,
        filepath,
        date_folder: dateFolder,
        capture_type: 'camera',
        capture_mode: 'manual',
        file_size: imageBuffer.length,
        width: metadata.width,
        height: metadata.height,
        device_info: { device_id: deviceId || 'default' },
        thumbnail_path: null // No longer generating thumbnails
      };
      
      const dbResult = await this.dbManager.insertCapture(captureData);
      
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
        result = await this.captureComposite(deviceId);
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
      
      const webcamOptions = {
        ...this.webcamOptions,
        device: deviceId || false,
        output: 'buffer'
      };
      
      // On macOS, we need different settings
      if (process.platform === 'darwin') {
        if (deviceId === 'default') {
          // Use no specific device for default
          webcamOptions.device = false;
        } else if (deviceId) {
          // Use the specific device ID
          webcamOptions.device = deviceId;
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
      throw error;
    }
  }

  async createCompositeImage(screenshotBuffer, cameraBuffer) {
    try {
      const timestamp = new Date();
      const dateTime = timestamp.toLocaleString();
      
      // Get dimensions of the screenshot
      const metadata = await sharp(screenshotBuffer).metadata();
      const { width, height } = metadata;
      
      // Resize camera image to be 1/5 of the screenshot width
      const cameraWidth = Math.floor(width / 5);
      const cameraHeight = Math.floor(cameraWidth * 3 / 4); // 4:3 aspect ratio
      
      // Resize and position camera image at the bottom right corner
      const resizedCamera = await sharp(cameraBuffer)
        .resize(cameraWidth, cameraHeight, { fit: 'cover' })
        .toBuffer();
      
      // Load screenshot into canvas
      const screenshotImage = await loadImage(screenshotBuffer);
      const canvas = createCanvas(width, height);
      const ctx = canvas.getContext('2d');
      
      // Draw the screenshot
      ctx.drawImage(screenshotImage, 0, 0, width, height);
      
      // Draw a semi-transparent background for the timestamp
      ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
      ctx.fillRect(10, 10, 400, 50);
      
      // Draw the timestamp text
      ctx.fillStyle = 'white';
      ctx.font = 'bold 28px Arial';
      ctx.fillText(dateTime, 25, 45);
      
      // Convert canvas to buffer
      const canvasBuffer = canvas.toBuffer('image/png');
      
      // Overlay the camera image
      return await sharp(canvasBuffer)
        .composite([
          {
            input: resizedCamera,
            top: height - cameraHeight - 20,
            left: width - cameraWidth - 20
          }
        ])
        .png()
        .toBuffer();
    } catch (error) {
      console.error('Failed to create composite image:', error);
      throw error;
    }
  }

  async captureComposite(deviceId = null) {
    try {
      // Capture screenshot
      const screenshotBuffer = await screenshot({ format: 'png' });
      
      // Capture camera photo
      const cameraBuffer = await this.capturePhotoBuffer(deviceId);
      
      // Create composite image
      const compositeBuffer = await this.createCompositeImage(screenshotBuffer, cameraBuffer);
      
      // Save composite image
      return await this.saveScreenshot(compositeBuffer, 'composite');
    } catch (error) {
      console.error('Composite capture failed:', error);
      throw error;
    }
  }
}

module.exports = { CaptureManager }; 