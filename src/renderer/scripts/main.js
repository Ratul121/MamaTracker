console.log("Capture App Loaded");

// Main application logic for the renderer process
class CaptureApp {
  constructor() {
    this.activeSessions = [];
    this.cameras = [];
    this.sessionRefreshInterval = null;
    this.defaultIntervalSettings = null;
    this.autoStartTimeout = null;
    this.init();
  }

  async init() {
    try {
      await this.loadCameras();
      await this.loadActiveSessions();
      await this.loadSettings();
      this.setupEventListeners();
      this.startSessionRefreshTimer();
      this.setupIpcListeners();
      this.updateStatusBar();
      
      // Set a timeout to auto-start interval capture if enabled
      if (this.defaultIntervalSettings && this.defaultIntervalSettings.autoStart) {
        this.scheduleAutoStart();
      }
    } catch (error) {
      console.error('Initialization failed:', error);
    }
  }

  // Load default interval settings
  async loadSettings() {
    try {
      // Load default save location
      const saveLocation = await window.electronAPI.getSetting('defaultSaveLocation');
      
      // Load default interval settings
      const defaultIntervalSettings = await window.electronAPI.getSetting('defaultIntervalSettings');
      
      if (defaultIntervalSettings) {
        this.defaultIntervalSettings = defaultIntervalSettings;
        console.log('Loaded default interval settings:', this.defaultIntervalSettings);
        
        // Populate settings form if it exists
        this.populateSettingsForm();
      } else {
        console.log('No default interval settings found');
      }
    } catch (error) {
      console.error('Failed to load settings:', error);
    }
  }
  
  // Update status bar with current settings
  updateStatusBar() {
    // Update directory status
    this.updateDirectoryStatus();
    
    // Update default interval status
    this.updateDefaultIntervalStatus();
  }
  
  // Update directory status display
  async updateDirectoryStatus() {
    const statusElement = document.getElementById('directoryStatusText');
    if (!statusElement) return;
    
    try {
      const saveLocation = await window.electronAPI.getSetting('defaultSaveLocation');
      if (saveLocation) {
        statusElement.textContent = `Save location: ${saveLocation}`;
      } else {
        statusElement.textContent = 'No directory set';
      }
    } catch (error) {
      console.error('Failed to get directory status:', error);
      statusElement.textContent = 'Error checking directory';
    }
  }
  
  // Update default interval status display
  updateDefaultIntervalStatus() {
    const statusElement = document.getElementById('defaultIntervalStatusText');
    if (!statusElement) return;
    
    if (this.defaultIntervalSettings) {
      const type = this.defaultIntervalSettings.captureType;
      const interval = this.defaultIntervalSettings.intervalSeconds;
      statusElement.textContent = `Default: ${type} every ${interval}s`;
    } else {
      statusElement.textContent = 'No default interval set';
    }
  }
  
  // Schedule auto-start of interval capture
  scheduleAutoStart() {
    // Clear any existing timeout
    if (this.autoStartTimeout) {
      clearTimeout(this.autoStartTimeout);
    }
    
    // Set 10-second timeout
    this.autoStartTimeout = setTimeout(() => {
      this.startDefaultIntervalCapture();
    }, 10000);
    
    console.log('Auto-start scheduled in 10 seconds');
    this.showToast('Auto-start scheduled in 10 seconds', 'info');
  }
  
  // Start interval capture with default settings
  async startDefaultIntervalCapture() {
    try {
      // Check if we have default settings
      if (!this.defaultIntervalSettings) {
        this.showToast('No default interval settings configured', 'error');
        return;
      }
      
      // Check if we have a save location
      const saveLocation = await window.electronAPI.getSetting('defaultSaveLocation');
      if (!saveLocation) {
        this.showToast('No save directory set. Please set a directory first.', 'error');
        return;
      }
      
      // Create config from default settings
      const needsCamera = this.defaultIntervalSettings.captureType === 'camera' 
                          || this.defaultIntervalSettings.captureType === 'both';
                          
      const config = {
        session_name: this.defaultIntervalSettings.sessionName || 'Auto Capture Session',
        capture_type: this.defaultIntervalSettings.captureType,
        interval_seconds: this.defaultIntervalSettings.intervalSeconds,
        max_captures: this.defaultIntervalSettings.maxCaptures || null,
        device_id: needsCamera && this.cameras.length > 0 ? this.cameras[0].device_id : null
      };

      console.log('Starting default interval session with config:', config);
      const sessionId = await window.electronAPI.startIntervalCapture(config);
      
      this.showToast('Auto interval session started successfully!', 'success');
      
      // Refresh active sessions
      await this.loadActiveSessions();
      
    } catch (error) {
      console.error('Default interval session error:', error);
      this.showToast('Failed to start default interval session: ' + error.message, 'error');
    }
  }

  setupEventListeners() {
    // Quick action buttons
    document.getElementById('screenshotBtn').addEventListener('click', () => this.takeScreenshot());
    document.getElementById('cameraBtn').addEventListener('click', () => this.takePhoto());
    document.getElementById('compositeBtn').addEventListener('click', () => this.takeComposite());
    document.getElementById('intervalBtn').addEventListener('click', () => this.showIntervalModal());
    document.getElementById('directoryBtn').addEventListener('click', () => this.selectDirectory());

    // Header buttons
    document.getElementById('minimizeBtn').addEventListener('click', () => this.minimizeToTray());
    document.getElementById('settingsBtn').addEventListener('click', () => this.showSettingsModal());

    // Modal controls
    this.setupModalControls();

    // Interval form
    document.getElementById('intervalForm').addEventListener('submit', (e) => this.startIntervalSession(e));
    document.getElementById('captureType').addEventListener('change', (e) => this.toggleCameraGroup(e));
    
    // Settings form
    document.getElementById('settingsForm').addEventListener('submit', (e) => this.saveSettings(e));
    document.getElementById('cancelSettings').addEventListener('click', () => {
      this.closeModal(document.getElementById('settingsModal'));
    });
    document.getElementById('defaultCaptureType').addEventListener('change', (e) => {
      const cameraGroupExists = document.getElementById('defaultCameraGroup');
      if (cameraGroupExists) {
        if (e.target.value === 'camera' || e.target.value === 'both') {
          cameraGroupExists.style.display = 'block';
        } else {
          cameraGroupExists.style.display = 'none';
        }
      }
    });
  }

  setupModalControls() {
    // Close modals when clicking close button
    document.querySelectorAll('.modal-close').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const modal = e.target.closest('.modal');
        this.closeModal(modal);
      });
    });

    // Cancel buttons
    document.getElementById('cancelInterval').addEventListener('click', () => {
      this.closeModal(document.getElementById('intervalModal'));
    });
  }

  async takeScreenshot() {
    try {
      console.log('Taking screenshot...');
      const result = await window.electronAPI.captureScreenshot({ type: 'fullscreen' });
      this.showToast('Screenshot captured successfully!', 'success');
      console.log('Screenshot result:', result);
    } catch (error) {
      console.error('Screenshot error:', error);
      this.showToast('Failed to capture screenshot: ' + error.message, 'error');
    }
  }

  async takePhoto() {
    try {
      console.log('Taking photo...');
      const result = await window.electronAPI.capturePhoto();
      this.showToast('Photo captured successfully!', 'success');
      console.log('Photo result:', result);
    } catch (error) {
      console.error('Photo error:', error);
      this.showToast('Failed to capture photo: ' + error.message, 'error');
    }
  }

  async takeComposite() {
    try {
      console.log('Taking composite capture...');
      const result = await window.electronAPI.captureComposite();
      this.showToast('Composite image captured successfully!', 'success');
      console.log('Composite result:', result);
    } catch (error) {
      console.error('Composite capture error:', error);
      this.showToast('Failed to capture composite: ' + error.message, 'error');
    }
  }

  async selectDirectory() {
    try {
      console.log('Selecting directory...');
      const result = await window.electronAPI.selectDirectory();
      if (!result.canceled && result.filePaths.length > 0) {
        await window.electronAPI.setSetting('defaultSaveLocation', result.filePaths[0]);
        this.updateDirectoryStatus();
        this.showToast('Save location updated successfully!', 'success');
      }
    } catch (error) {
      console.error('Directory selection error:', error);
      this.showToast('Failed to select directory: ' + error.message, 'error');
    }
  }

  async minimizeToTray() {
    try {
      await window.electronAPI.minimizeToTray();
    } catch (error) {
      this.showToast('Failed to minimize to tray: ' + error.message, 'error');
    }
  }

  showIntervalModal() {
    const modal = document.getElementById('intervalModal');
    modal.classList.add('active');
  }

  closeModal(modal) {
    modal.classList.remove('active');
  }

  toggleCameraGroup(e) {
    const cameraGroup = document.getElementById('cameraGroup');
    if (e.target.value === 'camera' || e.target.value === 'both') {
      cameraGroup.style.display = 'block';
    } else {
      cameraGroup.style.display = 'none';
    }
  }

  async startIntervalSession(e) {
    e.preventDefault();
    
    try {
      const captureType = document.getElementById('captureType').value;
      const needsCamera = captureType === 'camera' || captureType === 'both';
      
      const config = {
        session_name: document.getElementById('sessionName').value || null,
        capture_type: captureType,
        interval_seconds: parseInt(document.getElementById('intervalSeconds').value),
        max_captures: document.getElementById('maxCaptures').value ? 
          parseInt(document.getElementById('maxCaptures').value) : null,
        device_id: needsCamera ? document.getElementById('cameraDevice').value : null
      };

      console.log('Starting interval session with config:', config);
      const sessionId = await window.electronAPI.startIntervalCapture(config);
      
      this.closeModal(document.getElementById('intervalModal'));
      this.showToast('Interval session started successfully!', 'success');
      
      // Reset form
      e.target.reset();
      
      // Refresh active sessions
      await this.loadActiveSessions();
      
    } catch (error) {
      console.error('Interval session error:', error);
      this.showToast('Failed to start interval session: ' + error.message, 'error');
    }
  }

  async loadCameras() {
    try {
      this.cameras = await window.electronAPI.enumerateCameras();
      const cameraSelect = document.getElementById('cameraDevice');
      cameraSelect.innerHTML = '';
      
      this.cameras.forEach(camera => {
        const option = document.createElement('option');
        option.value = camera.device_id;
        option.textContent = camera.device_name;
        cameraSelect.appendChild(option);
      });
    } catch (error) {
      console.error('Failed to load cameras:', error);
    }
  }

  async loadActiveSessions() {
    try {
      this.activeSessions = await window.electronAPI.getActiveSessions();
      this.renderActiveSessions();
    } catch (error) {
      console.error('Failed to load active sessions:', error);
    }
  }

  renderActiveSessions() {
    const container = document.getElementById('sessionsContainer');
    
    if (this.activeSessions.length === 0) {
      container.innerHTML = `
        <div class="no-sessions">
          <i class="fas fa-info-circle"></i>
          <p>No active capture sessions</p>
        </div>
      `;
      return;
    }

    container.innerHTML = this.activeSessions.map(session => `
      <div class="session-card">
        <div class="session-info">
          <h4>${session.session_name || session.session_id}</h4>
          <p>${session.capture_type} • ${session.interval_seconds}s interval • ${session.capture_count} captures</p>
          <p>Status: ${session.status}</p>
        </div>
        <div class="session-controls">
          ${session.status === 'active' ? 
            `<button class="btn btn-secondary" onclick="app.pauseSession('${session.session_id}')">Pause</button>` :
            `<button class="btn btn-primary" onclick="app.resumeSession('${session.session_id}')">Resume</button>`
          }
          <button class="btn btn-warning" onclick="app.stopSession('${session.session_id}')">Stop</button>
        </div>
      </div>
    `).join('');
  }

  async pauseSession(sessionId) {
    try {
      await window.electronAPI.pauseIntervalCapture(sessionId);
      this.showToast('Session paused', 'success');
      await this.loadActiveSessions();
    } catch (error) {
      this.showToast('Failed to pause session: ' + error.message, 'error');
    }
  }

  async resumeSession(sessionId) {
    try {
      await window.electronAPI.resumeIntervalCapture(sessionId);
      this.showToast('Session resumed', 'success');
      await this.loadActiveSessions();
    } catch (error) {
      this.showToast('Failed to resume session: ' + error.message, 'error');
    }
  }

  async stopSession(sessionId) {
    try {
      await window.electronAPI.stopIntervalCapture(sessionId);
      this.showToast('Session stopped', 'success');
      await this.loadActiveSessions();
    } catch (error) {
      this.showToast('Failed to stop session: ' + error.message, 'error');
    }
  }

  showToast(message, type = 'info') {
    console.log(`${type.toUpperCase()}: ${message}`);
    
    // Create a simple toast notification
    const toast = document.createElement('div');
    toast.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      background: ${type === 'error' ? '#f56565' : type === 'success' ? '#48bb78' : '#4299e1'};
      color: white;
      padding: 12px 20px;
      border-radius: 8px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      z-index: 10000;
      max-width: 300px;
      font-size: 14px;
      animation: slideIn 0.3s ease;
    `;
    toast.textContent = message;
    
    // Add animation keyframes
    if (!document.getElementById('toast-styles')) {
      const style = document.createElement('style');
      style.id = 'toast-styles';
      style.textContent = `
        @keyframes slideIn {
          from { transform: translateX(100%); opacity: 0; }
          to { transform: translateX(0); opacity: 1; }
        }
      `;
      document.head.appendChild(style);
    }
    
    document.body.appendChild(toast);
    
    // Remove after 3 seconds
    setTimeout(() => {
      if (toast.parentNode) {
        toast.parentNode.removeChild(toast);
      }
    }, 3000);
  }

  // Add a method to refresh active sessions periodically
  startSessionRefreshTimer() {
    // Clear any existing timer
    if (this.sessionRefreshInterval) {
      clearInterval(this.sessionRefreshInterval);
    }
    
    // Set a new timer to refresh sessions every 2 seconds
    this.sessionRefreshInterval = setInterval(async () => {
      await this.loadActiveSessions();
    }, 2000);
    
    console.log('Session refresh timer started');
  }

  // Stop the refresh timer when no longer needed
  stopSessionRefreshTimer() {
    if (this.sessionRefreshInterval) {
      clearInterval(this.sessionRefreshInterval);
      this.sessionRefreshInterval = null;
      console.log('Session refresh timer stopped');
    }
  }

  // Add IPC event listeners
  setupIpcListeners() {
    // Listen for session updates from the main process
    window.electronAPI.onSessionUpdate((event, updatedSession) => {
      console.log('Received session update:', updatedSession);
      
      // Update our local sessions array
      this.updateSessionInList(updatedSession);
      
      // Re-render the sessions UI
      this.renderActiveSessions();
    });
  }

  // Update a specific session in the active sessions array
  updateSessionInList(updatedSession) {
    const index = this.activeSessions.findIndex(
      session => session.session_id === updatedSession.session_id
    );
    
    if (index !== -1) {
      this.activeSessions[index] = updatedSession;
    } else {
      // Session not in list, might be a new one
      this.activeSessions.push(updatedSession);
    }
  }

  // Show the settings modal
  showSettingsModal() {
    // Populate settings form with current values
    this.populateSettingsForm();
    
    // Show the modal
    const modal = document.getElementById('settingsModal');
    modal.classList.add('active');
  }
  
  // Populate settings form with current values
  populateSettingsForm() {
    if (!this.defaultIntervalSettings) return;
    
    const form = document.getElementById('settingsForm');
    if (!form) return;
    
    // Set form values from saved settings
    document.getElementById('defaultSessionName').value = 
      this.defaultIntervalSettings.sessionName || '';
      
    document.getElementById('defaultCaptureType').value = 
      this.defaultIntervalSettings.captureType || 'screenshot';
      
    document.getElementById('defaultIntervalSeconds').value = 
      this.defaultIntervalSettings.intervalSeconds || 30;
      
    document.getElementById('defaultMaxCaptures').value = 
      this.defaultIntervalSettings.maxCaptures || '';
      
    document.getElementById('autoStartInterval').checked = 
      this.defaultIntervalSettings.autoStart || false;
  }
  
  // Save settings
  async saveSettings(e) {
    e.preventDefault();
    
    try {
      // Get values from form
      const settings = {
        sessionName: document.getElementById('defaultSessionName').value,
        captureType: document.getElementById('defaultCaptureType').value,
        intervalSeconds: parseInt(document.getElementById('defaultIntervalSeconds').value),
        maxCaptures: document.getElementById('defaultMaxCaptures').value ? 
          parseInt(document.getElementById('defaultMaxCaptures').value) : null,
        autoStart: document.getElementById('autoStartInterval').checked
      };
      
      // Save to electron store
      await window.electronAPI.setSetting('defaultIntervalSettings', settings);
      
      // Update local settings
      this.defaultIntervalSettings = settings;
      
      // Close modal
      this.closeModal(document.getElementById('settingsModal'));
      
      // Update status bar
      this.updateDefaultIntervalStatus();
      
      // Schedule auto-start if enabled
      if (settings.autoStart) {
        this.scheduleAutoStart();
      } else if (this.autoStartTimeout) {
        clearTimeout(this.autoStartTimeout);
        this.autoStartTimeout = null;
      }
      
      this.showToast('Settings saved successfully!', 'success');
    } catch (error) {
      console.error('Failed to save settings:', error);
      this.showToast('Failed to save settings: ' + error.message, 'error');
    }
  }
}

// Initialize the app when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
  console.log('DOM loaded, initializing Capture App...');
  
  // Check if electronAPI is available
  if (typeof window.electronAPI === 'undefined') {
    console.error('electronAPI not available - app may not work correctly');
    return;
  }
  
  window.app = new CaptureApp();
  console.log('Capture App initialized successfully');
  
  // Clean up on page unload
  window.addEventListener('beforeunload', () => {
    if (window.app) {
      window.app.stopSessionRefreshTimer();
      window.electronAPI.removeAllListeners('session-update');
      window.electronAPI.removeAllListeners('capture-complete');
      window.electronAPI.removeAllListeners('error');
    }
  });
});
 