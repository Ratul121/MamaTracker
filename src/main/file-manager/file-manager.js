const fs = require('fs').promises;
const path = require('path');
const { app } = require('electron');
const Store = require('electron-store');

class FileManager {
  constructor() {
    this.store = new Store();
    this.defaultSaveLocation = this.getDefaultSaveLocation();
  }

  getDefaultSaveLocation() {
    // Try to get user-configured location first
    const userLocation = this.store.get('defaultSaveLocation');
    if (userLocation) {
      return userLocation;
    }

    // Default to Documents/CaptureApp
    const documentsPath = app.getPath('documents');
    return path.join(documentsPath, 'CaptureApp');
  }

  async ensureDateFolder(dateString) {
    try {
      const baseDir = this.getDefaultSaveLocation();
      const dateFolder = path.join(baseDir, dateString);
      
      // Create the directory if it doesn't exist
      await fs.mkdir(dateFolder, { recursive: true });
      
      return dateFolder;
    } catch (error) {
      console.error('Failed to create date folder:', error);
      throw error;
    }
  }

  async ensureDirectory(dirPath) {
    try {
      await fs.mkdir(dirPath, { recursive: true });
      return dirPath;
    } catch (error) {
      console.error('Failed to create directory:', error);
      throw error;
    }
  }

  async deleteCapture(captureId) {
    try {
      // This would typically involve:
      // 1. Getting capture info from database
      // 2. Deleting the actual file
      // 3. Removing from database
      
      // For now, just return success
      return { success: true };
    } catch (error) {
      console.error('Failed to delete capture:', error);
      throw error;
    }
  }

  async getDirectorySize(dirPath) {
    try {
      const stats = await fs.stat(dirPath);
      if (stats.isFile()) {
        return stats.size;
      }

      let totalSize = 0;
      const files = await fs.readdir(dirPath);
      
      for (const file of files) {
        const filePath = path.join(dirPath, file);
        const fileStats = await fs.stat(filePath);
        
        if (fileStats.isDirectory()) {
          totalSize += await this.getDirectorySize(filePath);
        } else {
          totalSize += fileStats.size;
        }
      }
      
      return totalSize;
    } catch (error) {
      console.error('Failed to get directory size:', error);
      return 0;
    }
  }

  async listCaptureFiles(dateString = null) {
    try {
      const baseDir = this.getDefaultSaveLocation();
      let searchDir = baseDir;
      
      if (dateString) {
        searchDir = path.join(baseDir, dateString);
      }

      const files = await fs.readdir(searchDir);
      const captureFiles = [];

      for (const file of files) {
        const filePath = path.join(searchDir, file);
        const stats = await fs.stat(filePath);
        
        if (stats.isFile() && this.isCaptureFile(file)) {
          captureFiles.push({
            filename: file,
            filepath: filePath,
            size: stats.size,
            modified: stats.mtime,
            created: stats.birthtime
          });
        }
      }

      return captureFiles;
    } catch (error) {
      console.error('Failed to list capture files:', error);
      return [];
    }
  }

  isCaptureFile(filename) {
    const capturePatterns = [
      /^CAMERA-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.(jpg|jpeg)$/i,
      /^SCREEN-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.png$/i
    ];

    return capturePatterns.some(pattern => pattern.test(filename));
  }

  async cleanupOldFiles(days = 90) {
    try {
      const baseDir = this.getDefaultSaveLocation();
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - days);

      const folders = await fs.readdir(baseDir);
      let deletedCount = 0;

      for (const folder of folders) {
        const folderPath = path.join(baseDir, folder);
        const stats = await fs.stat(folderPath);
        
        if (stats.isDirectory() && this.isDateFolder(folder)) {
          const folderDate = this.parseDateFolder(folder);
          
          if (folderDate < cutoffDate) {
            await fs.rmdir(folderPath, { recursive: true });
            deletedCount++;
          }
        }
      }

      return { deletedFolders: deletedCount };
    } catch (error) {
      console.error('Failed to cleanup old files:', error);
      throw error;
    }
  }

  isDateFolder(folderName) {
    return /^\d{4}-\d{2}-\d{2}$/.test(folderName);
  }

  parseDateFolder(folderName) {
    const [year, month, day] = folderName.split('-').map(Number);
    return new Date(year, month - 1, day);
  }

  async exportCaptures(exportPath, filters = {}) {
    try {
      // This would export captures based on filters
      // For now, just return success
      return { success: true, exportPath };
    } catch (error) {
      console.error('Failed to export captures:', error);
      throw error;
    }
  }

  async getStorageStats() {
    try {
      const baseDir = this.getDefaultSaveLocation();
      const totalSize = await this.getDirectorySize(baseDir);
      
      // Get folder count
      const folders = await fs.readdir(baseDir);
      const dateFolders = folders.filter(folder => this.isDateFolder(folder));
      
      // Get file count (approximate)
      let totalFiles = 0;
      for (const folder of dateFolders) {
        const folderPath = path.join(baseDir, folder);
        const files = await fs.readdir(folderPath);
        totalFiles += files.filter(file => this.isCaptureFile(file)).length;
      }

      return {
        totalSize,
        totalFiles,
        dateFolders: dateFolders.length,
        baseDirectory: baseDir
      };
    } catch (error) {
      console.error('Failed to get storage stats:', error);
      return {
        totalSize: 0,
        totalFiles: 0,
        dateFolders: 0,
        baseDirectory: this.getDefaultSaveLocation()
      };
    }
  }

  // Settings management
  setSaveLocation(newPath) {
    this.store.set('defaultSaveLocation', newPath);
    this.defaultSaveLocation = newPath;
  }

  getSaveLocation() {
    return this.getDefaultSaveLocation();
  }

  async validateSaveLocation(dirPath) {
    try {
      await fs.access(dirPath, fs.constants.W_OK);
      return true;
    } catch (error) {
      return false;
    }
  }
}

module.exports = { FileManager }; 