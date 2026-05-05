// --- Phase 3.2: Service Worker Registration ---
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js')
            .then(registration => { console.log('Service Worker registered'); })
            .catch(error => { console.error('Service Worker registration failed:', error); });
    });
}

document.addEventListener('DOMContentLoaded', () => {

    // 1. DECLARE GLOBALS AND CONSTANTS FIRST
    const SECRET_HASH = "2e215efc1d00ed91a0852851e3feba33edfc1109f77fb43ae4fdbbae583bcda0";
    let db;
    const DB_NAME = 'AttendanceDB';
    const DB_VERSION = 5;

    // 2. DOM ELEMENTS
    const authScreen = document.getElementById('auth-screen');
    const appContainer = document.getElementById('app-container');
    const pinInput = document.getElementById('organizer-pin');
    const btnSubmitPin = document.getElementById('btn-submit-pin');
    const pinError = document.getElementById('pin-error');

    // Helper function: Converts a plain text PIN into a secure SHA-256 hash using the browser's native cryptography
    async function hashPIN(pin) {
        const encoder = new TextEncoder();
        const data = encoder.encode(pin);
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    }

    // 1. Check if the phone is already authorized from a previous session
    if (localStorage.getItem('isOrganizerUnlocked') === 'true') {
        unlockApp();
    }

    // 2. Handle PIN submission securely
    btnSubmitPin.addEventListener('click', async () => { // Note the 'async' added here

        // Hash whatever the user just typed into the box
        const enteredHash = await hashPIN(pinInput.value);

        // Compare the hashes, not the plain text!
        if (enteredHash === SECRET_HASH) {
            localStorage.setItem('isOrganizerUnlocked', 'true');
            unlockApp();
        } else {
            pinError.classList.remove('hidden');
            pinInput.value = ''; // Clear the input
        }
    });

    // Function to hide the lock screen and boot up the core app
    function unlockApp() {
        authScreen.style.display = 'none';
        appContainer.style.display = 'block';

        // NOW we boot up the database and camera, not before!
        initDatabase();
    }

    // --- Phase 1.3: Navigation Logic ---
    const navButtons = document.querySelectorAll('.nav-btn');
    const views = document.querySelectorAll('.view');

    navButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            navButtons.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');

            views.forEach(view => {
                view.classList.add('hidden');
                view.classList.remove('active');
            });

            const targetId = btn.getAttribute('data-target');
            const targetView = document.getElementById(targetId);

            if (targetView) {
                targetView.classList.remove('hidden');
                targetView.classList.add('active');
            }

            // Camera Lifecycle Management
            if (targetId === 'view-scan') {
                setTimeout(startScanner, 100);
            } else {
                stopScanner();
            }
        });
    });

    // --- Phase 2.1: Local Database Setup (IndexedDB) ---

    function initDatabase() {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = (event) => {
            db = event.target.result;

            // We no longer need the newcomers table, so we delete it if it exists
            if (db.objectStoreNames.contains('newcomers')) {
                db.deleteObjectStore('newcomers');
            }

            // Create or update the scans table
            if (!db.objectStoreNames.contains('scans')) {
                const scanStore = db.createObjectStore('scans', { keyPath: 'id', autoIncrement: true });
                scanStore.createIndex('name', 'name', { unique: false });
                scanStore.createIndex('groupId', 'groupId', { unique: false });
                scanStore.createIndex('synced', 'synced', { unique: false });
            }
            console.log("Database upgraded (Removed newcomers table).");
        };

        request.onsuccess = (event) => {
            db = event.target.result;
            startScanner();
        };

        request.onerror = (event) => {
            console.error("IndexedDB initialization error:", event.target.errorCode);
            alert("Database error. The app may not work offline.");
        };
    }

    // initDatabase();

    // Helper function to check for duplicates in the current session
    function checkIfExists(storeName, name, groupId) {
        return new Promise((resolve) => {
            const transaction = db.transaction([storeName], 'readonly');
            const store = transaction.objectStore(storeName);
            const request = store.getAll();

            request.onsuccess = () => {
                const records = request.result;
                const exists = records.some(r =>
                    r.name.toLowerCase() === name.toLowerCase() &&
                    r.groupId === groupId
                );
                resolve(exists);
            };
        });
    }

    // --- Phase 2.2: The Scanner & Logging ---
    let html5QrCode;
    let lastScannedText = "";
    let scanTimeout;
    let isCameraRunning = false;
    const scanResultMsg = document.getElementById('scan-result-msg');

    function showScanMessage(msg, type) {
        scanResultMsg.textContent = msg;
        scanResultMsg.className = type;
        scanResultMsg.classList.remove('hidden');

        setTimeout(() => {
            scanResultMsg.classList.add('hidden');
            scanResultMsg.className = '';
        }, 3000);
    }

    async function logScanToDatabase(qrText) {
        let decodedTextSafe;
        try {
            decodedTextSafe = decodeURIComponent(qrText);
        } catch (e) {
            decodedTextSafe = qrText;
        }

        const parts = decodedTextSafe.split('|');
        if (parts.length !== 2) {
            showScanMessage("Invalid QR Code format.", "error");
            return;
        }

        const name = parts[0];
        const groupId = parseInt(parts[1], 10);

        const alreadyScanned = await checkIfExists('scans', name, groupId);
        if (alreadyScanned) {
            showScanMessage(`⚠️ ${name} is already checked in!`, "error");
            if ("vibrate" in navigator) navigator.vibrate([100, 50, 100]);
            return;
        }

        const timestamp = new Date().toISOString();
        const transaction = db.transaction(['scans'], 'readwrite');
        const store = transaction.objectStore('scans');

        const scanData = { name: name, groupId: groupId, timestamp: timestamp, synced: 0 };
        const request = store.add(scanData);

        request.onsuccess = () => {
            showScanMessage(`✅ Logged: ${name}`, "success");
            if ("vibrate" in navigator) navigator.vibrate(200);
            updateUnsyncedCount();
        };
    }

    function onScanSuccess(decodedText) {
        if (decodedText === lastScannedText) return;
        lastScannedText = decodedText;
        clearTimeout(scanTimeout);
        scanTimeout = setTimeout(() => { lastScannedText = ""; }, 3000);
        logScanToDatabase(decodedText);
    }

    function startScanner() {
        if (isCameraRunning) return;
        if (!html5QrCode) html5QrCode = new Html5Qrcode("reader");

        html5QrCode.start(
            { facingMode: "environment" },
            { fps: 10, qrbox: { width: 250, height: 250 } },
            onScanSuccess,
            (errorMessage) => { }
        ).then(() => {
            isCameraRunning = true;
        }).catch((err) => {
            isCameraRunning = false;
            const readerDiv = document.getElementById('reader');
            readerDiv.innerHTML = `
                <div style="text-align:center; padding: 20px; display:flex; flex-direction:column; justify-content:center; align-items:center; height:100%;">
                    <span style="font-size: 2.5rem;">📷</span>
                    <h3 style="margin: 8px 0; color: var(--text-main);">Camera Error</h3>
                    <p style="font-size:0.9rem; color:var(--text-muted);">Please allow camera access to scan QR codes.</p>
                    <button id="retry-camera-btn" class="btn secondary" style="margin-top:16px; width: auto; padding: 10px 20px;">Retry Camera</button>
                </div>
            `;
            document.getElementById('retry-camera-btn').addEventListener('click', () => {
                readerDiv.innerHTML = '';
                startScanner();
            });
        });
    }

    function stopScanner() {
        if (html5QrCode && isCameraRunning) {
            html5QrCode.stop().then(() => { isCameraRunning = false; });
        }
    }

    // --- Phase 2.3: The Generator (Register & Log Attendance) ---
    const registerForm = document.getElementById('register-form');
    const qrContainer = document.getElementById('generated-qr-container');
    const qrDisplay = document.getElementById('qrcode-display');
    const clearBtn = document.getElementById('btn-clear-qr');

    registerForm.addEventListener('submit', async (e) => {
        e.preventDefault();

        const nameInput = document.getElementById('full-name').value.trim();
        const arabicRegex = /^[\u0600-\u06FF\s]+$/;
        if (!arabicRegex.test(nameInput)) {
            alert("Please enter the name in Arabic only.");
            return;
        }

        const groupIdInput = document.getElementById('group-number').value;
        const groupId = parseInt(groupIdInput, 10);
        const qrString = `${nameInput}|${groupIdInput}`;
        const safeQrString = encodeURIComponent(qrString);

        // Generate QR
        qrDisplay.innerHTML = "";
        new QRCode(qrDisplay, {
            text: safeQrString,
            width: 220, height: 220,
            colorDark: "#0f172a", colorLight: "#ffffff",
            correctLevel: QRCode.CorrectLevel.L
        });

        registerForm.classList.add('hidden');
        qrContainer.classList.remove('hidden');

        // NEW LOGIC: Check 'scans' table instead of 'newcomers'
        const alreadyRegistered = await checkIfExists('scans', nameInput, groupId);
        if (alreadyRegistered) {
            alert(`Note: ${nameInput} is already checked in today! Generating QR code without adding duplicate attendance.`);
            return;
        }

        // NEW LOGIC: Save directly to the 'scans' table as an attendee!
        const transaction = db.transaction(['scans'], 'readwrite');
        const store = transaction.objectStore('scans');

        const scanData = {
            name: nameInput,
            groupId: groupId,
            timestamp: new Date().toISOString(),
            synced: 0
        };

        const request = store.add(scanData);

        request.onsuccess = () => {
            console.log(`Generated QR and logged attendance for ${nameInput}.`);
            updateUnsyncedCount();
            if ("vibrate" in navigator) navigator.vibrate(100);
        };
    });

    clearBtn.addEventListener('click', () => {
        registerForm.reset();
        qrContainer.classList.add('hidden');
        registerForm.classList.remove('hidden');
    });

    // --- Phase 4.2: Cloud Synchronization ---
    const syncBtn = document.getElementById('btn-sync');
    const syncStatusBadge = document.getElementById('sync-status');
    const unsyncedCountEl = document.getElementById('unsynced-count');
    const syncLog = document.getElementById('sync-log');

    // Make sure this is your active Google Script URL!
    const GOOGLE_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbwAuWEBU1CV9IBF2bpTrCAnU82WtKJ57qcHemmBnm49SX3GJu-wyq4-SFFyV2vhof3G/exec';

    function updateNetworkStatus() {
        if (navigator.onLine) {
            syncStatusBadge.textContent = 'Online';
            syncStatusBadge.classList.replace('offline', 'online');
        } else {
            syncStatusBadge.textContent = 'Offline';
            syncStatusBadge.classList.replace('online', 'offline');
        }
    }

    window.addEventListener('online', updateNetworkStatus);
    window.addEventListener('offline', updateNetworkStatus);
    updateNetworkStatus();

    // Simplified Counter: We only count the 'scans' table now
    function updateUnsyncedCount() {
        if (!db) return;

        const transaction = db.transaction(['scans'], 'readonly');
        const store = transaction.objectStore('scans');
        const index = store.index('synced');
        const request = index.count(IDBKeyRange.only(0));

        request.onsuccess = () => {
            const count = request.result;
            unsyncedCountEl.textContent = count;
            syncBtn.disabled = (count === 0 || !navigator.onLine);
            if (count === 0) syncBtn.classList.replace('primary', 'secondary');
            else syncBtn.classList.replace('secondary', 'primary');
        };
    }

    document.querySelector('[data-target="view-sync"]').addEventListener('click', updateUnsyncedCount);

    function getUnsyncedRecords(storeName) {
        return new Promise((resolve) => {
            const transaction = db.transaction([storeName], 'readonly');
            const store = transaction.objectStore(storeName);
            const index = store.index('synced');
            const request = index.getAll(IDBKeyRange.only(0));
            request.onsuccess = () => resolve(request.result);
        });
    }

    function clearSyncedRecords(storeName, records) {
        return new Promise((resolve) => {
            const transaction = db.transaction([storeName], 'readwrite');
            const store = transaction.objectStore(storeName);
            records.forEach(record => { store.delete(record.id); });
            transaction.oncomplete = () => resolve();
        });
    }

    syncBtn.addEventListener('click', async () => {
        if (!navigator.onLine) return;

        syncBtn.textContent = "Syncing...";
        syncBtn.disabled = true;
        syncLog.innerHTML = `<p>Packaging data...</p>`;

        try {
            // Only fetching and sending 'scans' now
            const unsyncedScans = await getUnsyncedRecords('scans');
            const payload = { scans: unsyncedScans };

            syncLog.innerHTML += `<p>Sending ${unsyncedScans.length} attendance records...</p>`;

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 15000);

            const response = await fetch(GOOGLE_SCRIPT_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'text/plain;charset=utf-8' },
                body: JSON.stringify(payload),
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            if (!response.ok) throw new Error(`Server returned status ${response.status}`);
            const result = await response.json();

            if (result.status === "success") {
                await clearSyncedRecords('scans', unsyncedScans);
                syncLog.innerHTML += `<p style="color: #047857; font-weight: bold; margin-top: 8px;">✅ Sync Complete!</p>`;
                updateUnsyncedCount();
            } else {
                throw new Error(result.message || "Unknown Google Script Error");
            }

        } catch (error) {
            console.error("Sync failed:", error);
            syncLog.innerHTML += `
                <div style="background-color: #fee2e2; border: 1px solid #ef4444; border-radius: 8px; padding: 12px; margin-top: 12px;">
                    <p style="color: #b91c1c; font-weight: bold; margin-bottom: 4px;">❌ Sync Failed</p>
                    <p style="color: #b91c1c; font-size: 0.85rem;">${error.message}</p>
                </div>
            `;
        } finally {
            syncBtn.textContent = "Sync Now";
            syncBtn.disabled = false;
        }
    });

    setTimeout(updateUnsyncedCount, 500);
});