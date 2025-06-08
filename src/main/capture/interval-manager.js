const { v4: uuidv4 } = require('uuid');
const { DatabaseManager } = require('../database/database-manager');
const { CaptureManager } = require('./capture-manager');
const { BrowserWindow } = require('electron');

class IntervalManager {
  constructor(dbManager = null) {
    this.dbManager = dbManager || new DatabaseManager();
    this.captureManager = new CaptureManager(this.dbManager);
    this.activeSessions = new Map();
    this.timers = new Map();
  }

  async initialize() {
    if (!this.dbManager.db) {
      await this.dbManager.initialize();
    }
    await this.captureManager.initialize();
    
    // Resume any active sessions from database
    await this.resumeActiveSessions();
  }

  async startSession(config) {
    try {
      const sessionId = uuidv4();
      const sessionData = {
        session_id: sessionId,
        session_name: config.session_name || `Session ${new Date().toLocaleString()}`,
        capture_type: config.capture_type, // 'screenshot' or 'camera'
        interval_seconds: config.interval_seconds,
        max_captures: config.max_captures || null,
        device_id: config.device_id || null,
        capture_settings: config.capture_settings || {}
      };

      // Save session to database
      await this.dbManager.insertSession(sessionData);

      // Start the interval timer
      this.startSessionTimer(sessionId, sessionData);

      // Add to active sessions
      this.activeSessions.set(sessionId, {
        ...sessionData,
        status: 'active',
        capture_count: 0,
        start_time: new Date()
      });

      console.log(`Started interval session: ${sessionId}`);
      return sessionId;
    } catch (error) {
      console.error('Failed to start interval session:', error);
      throw error;
    }
  }

  startSessionTimer(sessionId, sessionData) {
    const timer = setInterval(async () => {
      try {
        const session = this.activeSessions.get(sessionId);
        if (!session || session.status !== 'active') {
          this.clearTimer(sessionId);
          return;
        }

        // Check if we've reached the maximum captures
        if (sessionData.max_captures && session.capture_count >= sessionData.max_captures) {
          await this.stopSession(sessionId);
          return;
        }

        // Perform the capture
        await this.performCapture(sessionId, sessionData);
        
        // We don't need to manually update capture count here anymore
        // since performCapture now calls updateSessionCaptureCount

      } catch (error) {
        console.error(`Interval capture failed for session ${sessionId}:`, error);
        // Continue the session even if one capture fails
      }
    }, sessionData.interval_seconds * 1000);

    this.timers.set(sessionId, timer);
  }

  async performCapture(sessionId, sessionData) {
    try {
      let result;

      if (sessionData.capture_type === 'screenshot') {
        result = await this.captureManager.captureForInterval(sessionId, 'screenshot');
      } else if (sessionData.capture_type === 'camera') {
        result = await this.captureManager.captureForInterval(
          sessionId, 
          'camera', 
          sessionData.device_id
        );
      } else if (sessionData.capture_type === 'both') {
        result = await this.captureManager.captureForInterval(
          sessionId,
          'both',
          sessionData.device_id
        );
      } else if (sessionData.capture_type === 'composite') {
        result = await this.captureManager.captureForInterval(
          sessionId,
          'composite',
          sessionData.device_id
        );
      } else {
        throw new Error(`Unknown capture type: ${sessionData.capture_type}`);
      }

      // Update session capture count in memory and database
      await this.updateSessionCaptureCount(sessionId);

      console.log(`Interval capture completed for session ${sessionId}: ${result.filename}`);
      return result;
    } catch (error) {
      console.error(`Capture failed for session ${sessionId}:`, error);
      throw error;
    }
  }

  // New method to update session capture count consistently
  async updateSessionCaptureCount(sessionId) {
    try {
      // First, update the database
      await this.dbManager.incrementSessionCaptures(sessionId);
      
      // Then, get the latest session data from database
      const updatedSessionData = await this.dbManager.getSession(sessionId);
      
      if (updatedSessionData && this.activeSessions.has(sessionId)) {
        // Update the in-memory session with the correct count from database
        const session = this.activeSessions.get(sessionId);
        session.capture_count = updatedSessionData.capture_count;
        this.activeSessions.set(sessionId, session);
        
        console.log(`Updated session ${sessionId} capture count: ${session.capture_count}`);
        
        // Notify the renderer process of the updated session
        this.notifySessionUpdate(session);
      }
    } catch (error) {
      console.error(`Failed to update session capture count for ${sessionId}:`, error);
    }
  }

  // Notify the renderer process of session updates
  notifySessionUpdate(session) {
    try {
      const mainWindow = BrowserWindow.getAllWindows()[0];
      if (mainWindow) {
        mainWindow.webContents.send('session-update', session);
      }
    } catch (error) {
      console.error('Failed to send session update:', error);
    }
  }

  async pauseSession(sessionId) {
    try {
      const session = this.activeSessions.get(sessionId);
      if (!session) {
        throw new Error(`Session not found: ${sessionId}`);
      }

      // Clear the timer
      this.clearTimer(sessionId);

      // Update session status
      session.status = 'paused';
      this.activeSessions.set(sessionId, session);

      // Update database
      await this.dbManager.updateSession(sessionId, { status: 'paused' });

      console.log(`Paused interval session: ${sessionId}`);
    } catch (error) {
      console.error('Failed to pause interval session:', error);
      throw error;
    }
  }

  async resumeSession(sessionId) {
    try {
      const session = this.activeSessions.get(sessionId);
      if (!session) {
        throw new Error(`Session not found: ${sessionId}`);
      }

      if (session.status !== 'paused') {
        throw new Error(`Session is not paused: ${sessionId}`);
      }

      // Update session status
      session.status = 'active';
      this.activeSessions.set(sessionId, session);

      // Restart the timer
      this.startSessionTimer(sessionId, session);

      // Update database
      await this.dbManager.updateSession(sessionId, { status: 'active' });

      console.log(`Resumed interval session: ${sessionId}`);
    } catch (error) {
      console.error('Failed to resume interval session:', error);
      throw error;
    }
  }

  async stopSession(sessionId) {
    try {
      const session = this.activeSessions.get(sessionId);
      if (!session) {
        throw new Error(`Session not found: ${sessionId}`);
      }

      // Clear the timer
      this.clearTimer(sessionId);

      // Remove from active sessions
      this.activeSessions.delete(sessionId);

      // Update database
      await this.dbManager.updateSession(sessionId, {
        status: 'completed',
        end_time: new Date().toISOString()
      });

      console.log(`Stopped interval session: ${sessionId}`);
    } catch (error) {
      console.error('Failed to stop interval session:', error);
      throw error;
    }
  }

  clearTimer(sessionId) {
    const timer = this.timers.get(sessionId);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(sessionId);
    }
  }

  getActiveSessions() {
    return Array.from(this.activeSessions.values());
  }

  getSession(sessionId) {
    return this.activeSessions.get(sessionId);
  }

  async resumeActiveSessions() {
    try {
      const activeSessions = await this.dbManager.getActiveSessions();
      
      for (const sessionData of activeSessions) {
        // Add to active sessions map
        this.activeSessions.set(sessionData.session_id, {
          ...sessionData,
          start_time: new Date(sessionData.start_time)
        });

        // Only restart timers for active sessions (not paused ones)
        if (sessionData.status === 'active') {
          this.startSessionTimer(sessionData.session_id, sessionData);
        }
      }

      console.log(`Resumed ${activeSessions.length} active sessions`);
    } catch (error) {
      console.error('Failed to resume active sessions:', error);
    }
  }

  async getAllSessions() {
    try {
      return await this.dbManager.getAllSessions();
    } catch (error) {
      console.error('Failed to get all sessions:', error);
      return [];
    }
  }

  // Cleanup method to stop all sessions
  async stopAllSessions() {
    const sessionIds = Array.from(this.activeSessions.keys());
    
    for (const sessionId of sessionIds) {
      try {
        await this.stopSession(sessionId);
      } catch (error) {
        console.error(`Failed to stop session ${sessionId}:`, error);
      }
    }
  }

  // Get session statistics
  getSessionStats(sessionId) {
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      return null;
    }

    const now = new Date();
    const elapsed = Math.floor((now - session.start_time) / 1000);
    const estimatedTotal = session.max_captures || 'Unlimited';
    
    return {
      session_id: sessionId,
      session_name: session.session_name,
      status: session.status,
      capture_type: session.capture_type,
      interval_seconds: session.interval_seconds,
      capture_count: session.capture_count,
      max_captures: session.max_captures,
      elapsed_seconds: elapsed,
      estimated_total: estimatedTotal,
      progress_percentage: session.max_captures ? 
        Math.round((session.capture_count / session.max_captures) * 100) : null
    };
  }
}

module.exports = { IntervalManager }; 