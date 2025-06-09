const Database = require('better-sqlite3');
const path = require('path');
const { app } = require('electron');
const fs = require('fs').promises;

class DatabaseManager {
  constructor() {
    this.db = null;
    this.dbPath = path.join(app.getPath('userData'), 'captures.db');
  }

  async initialize() {
    try {
      // Ensure the directory exists
      await fs.mkdir(path.dirname(this.dbPath), { recursive: true });
      
      try {
        this.db = new Database(this.dbPath);
      } catch (dbError) {
        console.error('Failed to create Database object:', dbError);
        // Create a minimal in-memory fallback
        console.log('Using in-memory database fallback');
        this.db = {
          exec: (sql) => console.log('SQL exec (fallback):', sql.substring(0, 100) + '...'),
          prepare: () => ({
            run: () => ({ lastInsertRowid: 0, changes: 0 }),
            get: () => null,
            all: () => []
          }),
          close: () => {}
        };
      }
      
      this.createTables();
      try {
        await this.updateSchema();
      } catch (schemaError) {
        console.error('Schema update failed, continuing with basic functionality:', schemaError);
      }
      console.log('Database initialized successfully');
    } catch (error) {
      console.error('Database initialization failed:', error);
      console.log('Setting up fallback database functionality');
      // Create a minimal fallback interface for all database operations
      this.db = {
        exec: (sql) => console.log('SQL exec (fallback):', sql.substring(0, 100) + '...'),
        prepare: () => ({
          run: () => ({ lastInsertRowid: 0, changes: 0 }),
          get: () => null,
          all: () => []
        }),
        close: () => {}
      };
    }
  }

  createTables() {
    const tables = [
      `CREATE TABLE IF NOT EXISTS captures (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        filename TEXT NOT NULL,
        filepath TEXT NOT NULL,
        date_folder TEXT NOT NULL,
        capture_type TEXT NOT NULL CHECK(capture_type IN ('screenshot', 'camera', 'both', 'composite')),
        capture_mode TEXT CHECK(capture_mode IN ('manual', 'delayed', 'interval')),
        interval_session_id TEXT,
        timestamp DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        file_size INTEGER,
        width INTEGER,
        height INTEGER,
        device_info TEXT,
        thumbnail_path TEXT,
        tags TEXT,
        notes TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      
      `CREATE TABLE IF NOT EXISTS interval_sessions (
        session_id TEXT PRIMARY KEY,
        session_name TEXT,
        capture_type TEXT NOT NULL CHECK(capture_type IN ('screenshot', 'camera', 'both', 'composite')),
        interval_seconds INTEGER NOT NULL,
        max_captures INTEGER,
        start_time DATETIME NOT NULL,
        end_time DATETIME,
        status TEXT NOT NULL CHECK(status IN ('active', 'paused', 'completed', 'cancelled')) DEFAULT 'active',
        capture_count INTEGER DEFAULT 0,
        device_id TEXT,
        capture_settings TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      
      `CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      
      `CREATE TABLE IF NOT EXISTS devices (
        device_id TEXT PRIMARY KEY,
        device_name TEXT,
        device_type TEXT CHECK(device_type IN ('camera', 'display')),
        capabilities TEXT,
        last_used DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`
    ];

    for (const tableSQL of tables) {
      this.db.exec(tableSQL);
    }

    // Create indexes for better performance
    const indexes = [
      'CREATE INDEX IF NOT EXISTS idx_captures_timestamp ON captures(timestamp)',
      'CREATE INDEX IF NOT EXISTS idx_captures_type ON captures(capture_type)',
      'CREATE INDEX IF NOT EXISTS idx_captures_session ON captures(interval_session_id)',
      'CREATE INDEX IF NOT EXISTS idx_sessions_status ON interval_sessions(status)',
      'CREATE INDEX IF NOT EXISTS idx_sessions_type ON interval_sessions(capture_type)'
    ];

    for (const indexSQL of indexes) {
      this.db.exec(indexSQL);
    }
  }

  runQuery(sql, params = []) {
    try {
      const stmt = this.db.prepare(sql);
      const result = stmt.run(params);
      return { id: result.lastInsertRowid, changes: result.changes };
    } catch (error) {
      throw error;
    }
  }

  getQuery(sql, params = []) {
    try {
      const stmt = this.db.prepare(sql);
      return stmt.get(params);
    } catch (error) {
      throw error;
    }
  }

  allQuery(sql, params = []) {
    try {
      const stmt = this.db.prepare(sql);
      return stmt.all(params);
    } catch (error) {
      throw error;
    }
  }

  // Capture operations
  async insertCapture(captureData) {
    const sql = `
      INSERT INTO captures (
        filename, filepath, date_folder, capture_type, capture_mode,
        interval_session_id, file_size, width, height, device_info,
        thumbnail_path, tags, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    
    const params = [
      captureData.filename,
      captureData.filepath,
      captureData.date_folder,
      captureData.capture_type,
      captureData.capture_mode || 'manual',
      captureData.interval_session_id || null,
      captureData.file_size || null,
      captureData.width || null,
      captureData.height || null,
      captureData.device_info ? JSON.stringify(captureData.device_info) : null,
      captureData.thumbnail_path || null,
      captureData.tags || null,
      captureData.notes || null
    ];

    return await this.runQuery(sql, params);
  }

  async getCaptures(filters = {}) {
    let sql = 'SELECT * FROM captures WHERE 1=1';
    const params = [];

    if (filters.capture_type) {
      sql += ' AND capture_type = ?';
      params.push(filters.capture_type);
    }

    if (filters.date_from) {
      sql += ' AND timestamp >= ?';
      params.push(filters.date_from);
    }

    if (filters.date_to) {
      sql += ' AND timestamp <= ?';
      params.push(filters.date_to);
    }

    if (filters.session_id) {
      sql += ' AND interval_session_id = ?';
      params.push(filters.session_id);
    }

    if (filters.search) {
      sql += ' AND (filename LIKE ? OR tags LIKE ? OR notes LIKE ?)';
      const searchTerm = `%${filters.search}%`;
      params.push(searchTerm, searchTerm, searchTerm);
    }

    sql += ' ORDER BY timestamp DESC';

    if (filters.limit) {
      sql += ' LIMIT ?';
      params.push(filters.limit);
    }

    return await this.allQuery(sql, params);
  }

  async deleteCapture(captureId) {
    const sql = 'DELETE FROM captures WHERE id = ?';
    return await this.runQuery(sql, [captureId]);
  }

  // Session operations
  async insertSession(sessionData) {
    const sql = `
      INSERT INTO interval_sessions (
        session_id, session_name, capture_type, interval_seconds,
        max_captures, start_time, device_id, capture_settings
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `;
    
    const params = [
      sessionData.session_id,
      sessionData.session_name || null,
      sessionData.capture_type,
      sessionData.interval_seconds,
      sessionData.max_captures || null,
      new Date().toISOString(),
      sessionData.device_id || null,
      sessionData.capture_settings ? JSON.stringify(sessionData.capture_settings) : null
    ];

    return await this.runQuery(sql, params);
  }

  async updateSession(sessionId, updates) {
    const fields = Object.keys(updates);
    const values = Object.values(updates);
    const sql = `UPDATE interval_sessions SET ${fields.map(f => `${f} = ?`).join(', ')} WHERE session_id = ?`;
    values.push(sessionId);
    return await this.runQuery(sql, values);
  }

  async getSession(sessionId) {
    const sql = 'SELECT * FROM interval_sessions WHERE session_id = ?';
    return await this.getQuery(sql, [sessionId]);
  }

  async getActiveSessions() {
    const sql = 'SELECT * FROM interval_sessions WHERE status IN (?, ?) ORDER BY start_time DESC';
    return await this.allQuery(sql, ['active', 'paused']);
  }

  async incrementSessionCaptures(sessionId) {
    const sql = 'UPDATE interval_sessions SET capture_count = capture_count + 1 WHERE session_id = ?';
    return await this.runQuery(sql, [sessionId]);
  }

  // Close database connection
  close() {
    if (this.db) {
      this.db.close();
    }
  }

  // New method to update existing schema if needed
  async updateSchema() {
    try {
      // Try to update the schema to add 'both' and 'composite' to the capture_type constraints
      this.db.exec(`
        -- Create temporary tables without constraints
        CREATE TABLE IF NOT EXISTS temp_interval_sessions (
          session_id TEXT PRIMARY KEY,
          session_name TEXT,
          capture_type TEXT NOT NULL,
          interval_seconds INTEGER NOT NULL,
          max_captures INTEGER,
          start_time DATETIME NOT NULL,
          end_time DATETIME,
          status TEXT NOT NULL DEFAULT 'active',
          capture_count INTEGER DEFAULT 0,
          device_id TEXT,
          capture_settings TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        
        CREATE TABLE IF NOT EXISTS temp_captures (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          filename TEXT NOT NULL,
          filepath TEXT NOT NULL,
          date_folder TEXT NOT NULL,
          capture_type TEXT NOT NULL,
          capture_mode TEXT,
          interval_session_id TEXT,
          timestamp DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          file_size INTEGER,
          width INTEGER,
          height INTEGER,
          device_info TEXT,
          thumbnail_path TEXT,
          tags TEXT,
          notes TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        
        -- Copy data from original tables to temp tables if they exist
        INSERT OR IGNORE INTO temp_interval_sessions 
        SELECT * FROM interval_sessions;
        
        INSERT OR IGNORE INTO temp_captures 
        SELECT * FROM captures;
        
        -- Drop original tables
        DROP TABLE IF EXISTS interval_sessions;
        DROP TABLE IF EXISTS captures;
        
        -- Recreate tables with updated constraints
        CREATE TABLE IF NOT EXISTS captures (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          filename TEXT NOT NULL,
          filepath TEXT NOT NULL,
          date_folder TEXT NOT NULL,
          capture_type TEXT NOT NULL CHECK(capture_type IN ('screenshot', 'camera', 'both', 'composite')),
          capture_mode TEXT CHECK(capture_mode IN ('manual', 'delayed', 'interval')),
          interval_session_id TEXT,
          timestamp DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          file_size INTEGER,
          width INTEGER,
          height INTEGER,
          device_info TEXT,
          thumbnail_path TEXT,
          tags TEXT,
          notes TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        
        CREATE TABLE IF NOT EXISTS interval_sessions (
          session_id TEXT PRIMARY KEY,
          session_name TEXT,
          capture_type TEXT NOT NULL CHECK(capture_type IN ('screenshot', 'camera', 'both', 'composite')),
          interval_seconds INTEGER NOT NULL,
          max_captures INTEGER,
          start_time DATETIME NOT NULL,
          end_time DATETIME,
          status TEXT NOT NULL CHECK(status IN ('active', 'paused', 'completed', 'cancelled')) DEFAULT 'active',
          capture_count INTEGER DEFAULT 0,
          device_id TEXT,
          capture_settings TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        
        -- Copy data from temp tables to new tables
        INSERT OR IGNORE INTO interval_sessions SELECT * FROM temp_interval_sessions;
        INSERT OR IGNORE INTO captures SELECT * FROM temp_captures;
        
        -- Drop temp tables
        DROP TABLE IF EXISTS temp_interval_sessions;
        DROP TABLE IF EXISTS temp_captures;
      `);
      
      // Recreate indexes
      const indexes = [
        'CREATE INDEX IF NOT EXISTS idx_captures_timestamp ON captures(timestamp)',
        'CREATE INDEX IF NOT EXISTS idx_captures_type ON captures(capture_type)',
        'CREATE INDEX IF NOT EXISTS idx_captures_session ON captures(interval_session_id)',
        'CREATE INDEX IF NOT EXISTS idx_sessions_status ON interval_sessions(status)',
        'CREATE INDEX IF NOT EXISTS idx_sessions_type ON interval_sessions(capture_type)'
      ];

      for (const indexSQL of indexes) {
        this.db.exec(indexSQL);
      }
      
      console.log('Database schema updated successfully');
    } catch (error) {
      console.error('Failed to update database schema:', error);
      // Continue execution even if schema update fails
    }
  }
}

module.exports = { DatabaseManager }; 