document.addEventListener('DOMContentLoaded', async () => {
    const statusElements = {
        screen: document.getElementById('screen-status'),
        camera: document.getElementById('camera-status'),
        mic: document.getElementById('mic-status')
    };

    const wrapperElements = {
        screen: document.getElementById('screen-permission'),
        camera: document.getElementById('camera-permission'),
        mic: document.getElementById('mic-permission')
    };

    const btnElements = {
        screenRequest: document.getElementById('btn-request-screen'),
        screenCheck: document.getElementById('btn-check-screen'),
        cameraRequest: document.getElementById('btn-request-camera'),
        micRequest: document.getElementById('btn-request-mic'),
        continue: document.getElementById('btn-continue'),
        relaunch: document.getElementById('btn-relaunch')
    };

    // Use the exposed API from preload.js
    const api = window.electronAPI;

    if (!api) {
        console.error('electronAPI not exposed');
        return;
    }

    // Check initial status
    await checkAllPermissions();

    // Event Listeners
    btnElements.screenRequest.addEventListener('click', () => {
        api.openPrivacySettings('screen');
        // Screen recording permission usually requires restart, or at least a re-check
        btnElements.screenRequest.classList.add('hidden');
        btnElements.screenCheck.classList.remove('hidden');
        btnElements.relaunch.classList.remove('hidden');
    });

    btnElements.screenCheck.addEventListener('click', async () => {
        const preCheck = await api.checkPermissions();

        // Force a check
        await checkAllPermissions();

        // If still denied after checking, suggest relaunch
        const postCheck = await api.checkPermissions();
        const isGranted = postCheck.screen === 'granted' || postCheck.screen === true;

        if (!isGranted) {
            const shouldRelaunch = confirm(
                "Screen Recording permission usually requires an app restart to take effect.\n\n" +
                "If you have already granted permission in System Settings but it's still showing as Denied, please relaunch the app.\n\n" +
                "Relaunch now?"
            );

            if (shouldRelaunch) {
                api.relaunchApp();
            }
        }
    });

    btnElements.cameraRequest.addEventListener('click', async () => {
        const granted = await api.requestPermission('camera');
        // Note: requestPermission returns boolean or status string depending on implementation
        // Our main process handler returns result of askForMediaAccess (boolean)
        updateStatus('camera', granted ? 'granted' : 'denied');
        checkAllDone();
    });

    btnElements.micRequest.addEventListener('click', async () => {
        const granted = await api.requestPermission('microphone');
        updateStatus('mic', granted ? 'granted' : 'denied');
        checkAllDone();
    });

    btnElements.relaunch.addEventListener('click', () => {
        api.relaunchApp();
    });

    btnElements.continue.addEventListener('click', () => {
        api.permissionsCompleted();
    });

    async function checkAllPermissions() {
        if (!api) return;

        try {
            const status = await api.checkPermissions();
            console.log('Permission status:', status);

            updateStatus('screen', status.screen);
            updateStatus('camera', status.camera);
            updateStatus('mic', status.microphone);

            checkAllDone();
        } catch (error) {
            console.error('Error checking permissions:', error);
        }
    }

    function updateStatus(type, status) {
        const el = statusElements[type];
        const wrapper = wrapperElements[type];

        // Normalize status strings if needed
        const isGranted = status === 'granted' || status === true;

        el.className = `status-badge ${isGranted ? 'granted' : 'denied'}`;
        el.textContent = isGranted ? 'Granted' : 'Denied / Not Determined';

        if (isGranted) {
            wrapper.classList.add('granted');
            // Hide request buttons
            if (type === 'screen') {
                btnElements.screenRequest.classList.add('hidden');
                btnElements.screenCheck.classList.add('hidden');
                btnElements.relaunch.classList.add('hidden'); // Hide relaunch if granted
            } else if (type === 'camera') {
                btnElements.cameraRequest.classList.add('hidden');
            } else if (type === 'mic') {
                btnElements.micRequest.classList.add('hidden');
            }
        } else {
            wrapper.classList.remove('granted');
            if (type === 'screen') {
                // Screen recording permission often requires manual check or restart
                btnElements.screenCheck.classList.remove('hidden');
            }
        }
    }

    function checkAllDone() {
        const allGranted =
            wrapperElements.screen.classList.contains('granted') &&
            wrapperElements.camera.classList.contains('granted') &&
            wrapperElements.mic.classList.contains('granted');

        btnElements.continue.disabled = !allGranted;
    }

    // Poll for status updates every few seconds if visible
    setInterval(() => {
        if (document.visibilityState === 'visible') {
            checkAllPermissions();
        }
    }, 3000);
});
