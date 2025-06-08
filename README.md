# Electron Screenshot & Camera Capture App

A cross-platform desktop application built with Electron for capturing screenshots and camera photos with advanced interval capture capabilities and system tray integration.

## Features

### Core Functionality
- **Screenshot Capture**: Full screen and window-specific screenshot capture
- **Camera Integration**: Access webcam/external cameras for photo capture
- **Directory Selection**: User-configurable save location with folder picker
- **Metadata Management**: SQLite database storing comprehensive file and capture metadata
- **Cross-Platform Support**: Windows, macOS, and Linux compatibility

### Advanced Features
- **Interval Capture**: Automated time-lapse and periodic captures with session management
- **System Tray Integration**: Complete background operation with tray controls
- **Background Operation**: Silent captures with no UI interruption
- **Session Management**: Pause/resume capabilities for interval sessions

- **Organized File Structure**: Date-based folder organization with consistent naming

## File Organization

The app automatically organizes captures in the following structure:

```
Selected Directory/
└── CaptureApp/
    └── 2025-01-09/                    # DATE folder (YYYY-MM-DD)
        ├── CAMERA-2025-01-09_14-30-15.jpg
        ├── CAMERA-2025-01-09_14-30-45.jpg
        ├── SCREEN-2025-01-09_14-31-20.png
        └── SCREEN-2025-01-09_14-31-50.png
```

### Naming Convention
- **Camera Images**: `CAMERA-YYYY-MM-DD_HH-MM-SS.jpg`
- **Screenshots**: `SCREEN-YYYY-MM-DD_HH-MM-SS.png`
- **Date Folders**: `YYYY-MM-DD` format
- **Time Format**: 24-hour format with hyphens (HH-MM-SS)

## Installation & Setup

### Prerequisites
- Node.js (v18 or higher)
- npm or yarn package manager
- Operating system with camera and screen access permissions

### Development Setup

1. **Clone and Install Dependencies**
   ```bash
   git clone <repository-url>
   cd electron-capture-app
   npm install
   ```

2. **Development Mode**
   ```bash
   npm run dev
   ```

3. **Build for Production**
   ```bash
   # Build for current platform
   npm run build
   
   # Build for specific platforms
   npm run build:win    # Windows
   npm run build:mac    # macOS
   npm run build:linux  # Linux
   ```

### First Launch Setup

1. **Permissions**: The app will request permissions for camera and screen recording
2. **Directory Selection**: Choose your preferred save location via the folder picker
3. **Camera Configuration**: Available cameras will be automatically detected
4. **Preferences**: Configure naming conventions, quality settings, and shortcuts

## Usage

### Quick Capture
- **Screenshot**: Click the Screenshot button or use `Ctrl+Shift+F`
- **Camera**: Click the Camera button or use `Ctrl+Shift+C`
- **Directory**: Click Select Directory to change save location

### Interval Capture Sessions

1. **Start Session**: Click "Interval Capture" or use `Ctrl+Shift+I`
2. **Configure Settings**:
   - Session name (optional)
   - Capture type (screenshot or camera)
   - Interval time (5 seconds to 1 hour)
   - Maximum captures (optional limit)
   - Camera device (for camera sessions)
3. **Background Operation**: App automatically minimizes to system tray
4. **Session Controls**: Access pause/resume/stop via system tray menu

### System Tray Features
- **Status Indicator**: Tray icon shows active capture sessions
- **Quick Controls**: Right-click menu for session management
- **Progress Display**: Hover tooltip shows current session progress
- **Silent Operation**: Minimal notifications during background captures

### Keyboard Shortcuts
- `Ctrl+Shift+F`: Full Screen Screenshot
- `Ctrl+Shift+C`: Camera Capture
- `Ctrl+Shift+I`: Start Interval Capture
- `Ctrl+Shift+T`: Show App from Tray

## Technical Architecture

### Project Structure
```
electron-capture-app/
├── src/
│   ├── main/                 # Main process files
│   │   ├── index.js         # Application entry point
│   │   ├── capture/         # Screenshot/camera modules
│   │   │   ├── capture-manager.js
│   │   │   └── interval-manager.js
│   │   ├── database/        # Database management
│   │   │   └── database-manager.js
│   │   └── file-manager/    # File operations
│   │       └── file-manager.js
│   └── renderer/            # Renderer process files
│       ├── index.html       # Main UI
│       ├── preload.js       # Secure API bridge
│       ├── styles/          # CSS stylesheets
│       │   └── main.css
│       └── scripts/         # Frontend JavaScript
│           └── main.js
├── assets/                  # Static resources
├── package.json            # Dependencies and scripts
└── README.md              # This file
```

### Database Schema

The app uses SQLite with the following main tables:

- **captures**: Store capture metadata and file information
- **interval_sessions**: Track interval capture sessions
- **settings**: User preferences and configuration
- **devices**: Camera and display device information

### Dependencies

#### Core Dependencies
- **Electron**: Desktop app framework
- **sqlite3**: Database management
- **sharp**: Image processing and manipulation
- **screenshot-desktop**: Cross-platform screenshot capture
- **node-webcam**: Camera access and control
- **electron-store**: Settings persistence
- **uuid**: Session ID generation

## Configuration

### Default Settings
```json
{
  "defaultSaveLocation": "/Users/username/Documents/CaptureApp",
  "fileNaming": {
    "cameraPrefix": "CAMERA",
    "screenshotPrefix": "SCREEN",
    "dateFormat": "YYYY-MM-DD",
    "timeFormat": "HH-MM-SS",
    "createDateFolders": true
  },
  "screenshotFormat": "png",
  "cameraFormat": "jpg",
  "compressionQuality": 95,

  "backgroundOperation": {
    "minimizeToTray": true,
    "runSilently": true,
    "showNotifications": true
  },
  "intervalSettings": {
    "defaultInterval": 30,
    "minInterval": 5,
    "maxInterval": 3600,
    "defaultMaxCaptures": 100
  }
}
```

## Security & Privacy

- **Local Storage**: All data stored locally, no cloud transmission
- **Permissions**: Requests camera and screen recording permissions
- **Privacy**: No telemetry or external data transmission
- **File System**: Write access only to selected directories

## Troubleshooting

### Common Issues

1. **Camera Not Detected**
   - Check camera permissions in system settings
   - Ensure camera is not being used by another application
   - Restart the application

2. **Screenshot Fails**
   - Check screen recording permissions (macOS)
   - Ensure sufficient disk space
   - Verify write permissions to save directory

3. **Interval Sessions Not Working**
   - Check if app is running in background
   - Verify system tray functionality
   - Ensure sufficient system resources

### Performance Tips

- **Long Sessions**: For extended interval captures, ensure adequate disk space
- **Resource Usage**: Monitor system resources during intensive capture sessions
- **File Management**: Regularly clean up old captures to maintain performance

## Development

### Building from Source

1. **Install Dependencies**
   ```bash
   npm install
   ```

2. **Development Mode**
   ```bash
   npm run dev
   ```

3. **Build Distribution**
   ```bash
   npm run build
   ```

### Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## License

MIT License - see LICENSE file for details.

## Support

For issues, feature requests, or questions:
1. Check the troubleshooting section
2. Search existing issues
3. Create a new issue with detailed information

---

**Note**: This application requires appropriate system permissions for camera and screen access. Please ensure you trust the source before granting these permissions. 