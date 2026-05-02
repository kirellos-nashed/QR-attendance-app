// --- Phase 3.2: Service Worker Registration ---
// Check if the browser supports service workers
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js')
            .then(registration => {
                console.log('Service Worker registered with scope:', registration.scope);
            })
            .catch(error => {
                console.error('Service Worker registration failed:', error);
            });
    });
}


// Wait for the HTML to fully load before running the script
document.addEventListener('DOMContentLoaded', () => {

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

            // --- NEW: Camera Lifecycle Management ---
            // If we just navigated to the scan view, turn the camera on. 
            // Otherwise, turn it off.
            if (targetId === 'view-scan') {
                // Small timeout allows the CSS transition to finish before the camera blocks the thread
                setTimeout(startScanner, 100);
            } else {
                stopScanner();
            }
            // ----------------------------------------
        });
    });

    // --- Phase 2.1: Local Database Setup (IndexedDB) ---

    let db; // Global variable to hold our database connection
    const DB_NAME = 'AttendanceDB';
    const DB_VERSION = 3; // We increased this to 2 to force the browser to update our table structures

    function initDatabase() {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        // 1. Setup / Upgrade: Runs when DB is created or DB_VERSION increases
        request.onupgradeneeded = (event) => {
            db = event.target.result;

            // Clear out the old version 1 tables if they exist
            if (db.objectStoreNames.contains('scans')) {
                db.deleteObjectStore('scans');
            }
            if (db.objectStoreNames.contains('newcomers')) {
                db.deleteObjectStore('newcomers');
            }

            // Table 1: Attendance Scans
            const scanStore = db.createObjectStore('scans', { keyPath: 'id', autoIncrement: true });
            scanStore.createIndex('name', 'name', { unique: false }); // Added name tracking
            scanStore.createIndex('groupId', 'groupId', { unique: false });
            scanStore.createIndex('synced', 'synced', { unique: false });

            // Table 2: Newcomer Profiles
            // Changed keyPath to an auto-incrementing ID since groupId is not unique
            const newcomerStore = db.createObjectStore('newcomers', { keyPath: 'id', autoIncrement: true });
            newcomerStore.createIndex('name', 'name', { unique: false });
            newcomerStore.createIndex('groupId', 'groupId', { unique: false });
            newcomerStore.createIndex('synced', 'synced', { unique: false });

            console.log("Database tables upgraded and created successfully.");
        };

        // 2. Success: The database is open and ready to use
        request.onsuccess = (event) => {
            db = event.target.result;
            console.log("IndexedDB loaded and ready.");

            // Start the camera automatically now that DB is ready
            startScanner();
        };

        // 3. Error
        request.onerror = (event) => {
            console.error("IndexedDB initialization error:", event.target.errorCode);
            alert("Database error. The app may not work offline.");
        };
    }

    // Initialize the database as soon as the app loads
    initDatabase();


    // Helper function to check for duplicates in the current session
    function checkIfExists(storeName, name, groupId) {
        return new Promise((resolve) => {
            const transaction = db.transaction([storeName], 'readonly');
            const store = transaction.objectStore(storeName);
            const request = store.getAll();

            request.onsuccess = () => {
                const records = request.result;
                // Case-insensitive check to see if this person is already logged
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
    let isCameraRunning = false; // NEW: Track camera state
    const scanResultMsg = document.getElementById('scan-result-msg');

    // Helper function to display temporary success/error messages
    function showScanMessage(msg, type) {
        scanResultMsg.textContent = msg;
        scanResultMsg.className = type;
        scanResultMsg.classList.remove('hidden');

        // Auto-hide the message after 3 seconds
        setTimeout(() => {
            scanResultMsg.classList.add('hidden');
            scanResultMsg.className = '';
        }, 3000);
    }

    // The core function to save the scanned data
    async function logScanToDatabase(qrText) {

        // --- SAFELY DECODE THE URL-ENCODED ARABIC ---
        let decodedTextSafe;
        try {
            // Simply decode the URI component
            decodedTextSafe = decodeURIComponent(qrText);
        } catch (e) {
            // Fallback just in case
            decodedTextSafe = qrText;
        }

        const parts = decodedTextSafe.split('|');

        if (parts.length !== 2) {
            showScanMessage("Invalid QR Code format.", "error");
            return;
        }

        const name = parts[0];
        const groupId = parseInt(parts[1], 10);

        // --- NEW: DUPLICATE CHECK ---
        const alreadyScanned = await checkIfExists('scans', name, groupId);
        if (alreadyScanned) {
            showScanMessage(`⚠️ ${name} is already checked in!`, "error");
            // Optional: still vibrate so the organizer knows a scan happened
            if ("vibrate" in navigator) navigator.vibrate([100, 50, 100]);
            return; // Stop the function here so it doesn't save to the database
        }
        // -----------------------------

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

        request.onerror = (event) => {
            console.error("Error saving scan:", event.target.error);
            showScanMessage("❌ Failed to save scan.", "error");
        };
    }

    // This runs every time a QR code is successfully detected in the camera frame
    function onScanSuccess(decodedText, decodedResult) {
        // Debounce: If we just scanned this exact code a millisecond ago, ignore it
        if (decodedText === lastScannedText) return;

        // console.log("SUCCESSFULLY SCANNED:", decodedText);

        lastScannedText = decodedText;

        // Reset the debounce block after 3 seconds, allowing the same person to be scanned again if needed later
        clearTimeout(scanTimeout);
        scanTimeout = setTimeout(() => { lastScannedText = ""; }, 3000);

        // Process the scan
        logScanToDatabase(decodedText);
    }

    // Initialize the camera
    function startScanner() {
        if (isCameraRunning) return; // Prevent multiple instances

        if (!html5QrCode) {
            html5QrCode = new Html5Qrcode("reader");
        }

        html5QrCode.start(
            { facingMode: "environment" },
            {
                fps: 10,
                qrbox: { width: 250, height: 250 }
            },
            onScanSuccess,
            (errorMessage) => { /* Ignore background errors */ }
        ).then(() => {
            isCameraRunning = true;
        }).catch((err) => {
            console.error("Camera start error:", err);
            isCameraRunning = false;

            // Inject a friendly error message and a retry button directly into the scanner box
            const readerDiv = document.getElementById('reader');
            readerDiv.innerHTML = `
                <div style="text-align:center; padding: 20px; display:flex; flex-direction:column; justify-content:center; align-items:center; height:100%;">
                    <span style="font-size: 2.5rem;">📷</span>
                    <h3 style="margin: 8px 0; color: var(--text-main);">Camera Error</h3>
                    <p style="font-size:0.9rem; color:var(--text-muted);">Please allow camera permissions in your browser settings to scan QR codes.</p>
                    <button id="retry-camera-btn" class="btn secondary" style="margin-top:16px; width: auto; padding: 10px 20px;">Retry Camera</button>
                </div>
            `;

            // Make the retry button work
            document.getElementById('retry-camera-btn').addEventListener('click', () => {
                readerDiv.innerHTML = ''; // Clear the error UI
                startScanner(); // Try booting the camera again
            });
        });
    }

    // NEW: Stop the camera
    function stopScanner() {
        if (html5QrCode && isCameraRunning) {
            html5QrCode.stop().then(() => {
                isCameraRunning = false;
                console.log("Camera paused to save battery.");
            }).catch((err) => {
                console.error("Failed to stop camera:", err);
            });
        }
    }


    // --- Phase 2.3: The Generator (Register Newcomer) ---

    const registerForm = document.getElementById('register-form');
    const qrContainer = document.getElementById('generated-qr-container');
    const qrDisplay = document.getElementById('qrcode-display');
    const clearBtn = document.getElementById('btn-clear-qr');

    registerForm.addEventListener('submit', async (e) => {
        e.preventDefault();

        const nameInput = document.getElementById('full-name').value.trim();

        // --- NEW: Double-check for Arabic Only ---
        // (This acts as a backup in case the HTML pattern fails on some older browsers)
        const arabicRegex = /^[\u0600-\u06FF\s]+$/;
        if (!arabicRegex.test(nameInput)) {
            alert("Please enter the name in Arabic only.");
            return;
        }

        const groupIdInput = document.getElementById('group-number').value;
        const groupId = parseInt(groupIdInput, 10);
        const qrString = `${nameInput}|${groupIdInput}`;

        // --- NEW: UTF-8 Encoding Fix for Arabic ---
        // Converts the string into raw UTF-8 bytes so qrcode.js doesn't scramble it
        const safeQrString = encodeURIComponent(qrString);

        // Generate the visual QR Code using the SAFE string
        qrDisplay.innerHTML = "";
        new QRCode(qrDisplay, {
            text: safeQrString, // <-- Using the safe encoded string
            width: 220,
            height: 220,
            colorDark: "#0f172a",
            colorLight: "#ffffff",
            // Change this line from .H to .L
            correctLevel: QRCode.CorrectLevel.L
        });

        // Show the QR code on screen
        registerForm.classList.add('hidden');
        qrContainer.classList.remove('hidden');

        // --- DUPLICATE CHECK (From our previous fix) ---
        const alreadyRegistered = await checkIfExists('newcomers', nameInput, groupId);
        if (alreadyRegistered) {
            alert(`Note: ${nameInput} is already registered. Generating QR code without duplicating data.`);
            return;
        }
        // -----------------------------

        // 3. Save the Newcomer to IndexedDB
        const transaction = db.transaction(['newcomers'], 'readwrite');
        const store = transaction.objectStore('newcomers');


        const newcomerData = {
            name: nameInput,
            groupId: parseInt(groupIdInput, 10),
            timestamp: new Date().toISOString(),
            synced: 0 // Flag for Phase 4 cloud sync
        };

        const request = store.add(newcomerData);

        request.onsuccess = () => {
            console.log(`Newcomer ${nameInput} saved to local database.`);

            // 4. Update the UI to show the QR code and hide the form
            registerForm.classList.add('hidden');
            qrContainer.classList.remove('hidden');
            updateUnsyncedCount();

            // Optional Haptic feedback
            if ("vibrate" in navigator) navigator.vibrate(100);
        };

        request.onerror = (err) => {
            console.error("Failed to save newcomer:", err.target.error);
            alert("Error saving newcomer to database.");
        };
    });

    // Reset the UI so the organizer can register the next person
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

    // IMPORTANT: We will replace this in Phase 4.1
    const GOOGLE_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbwAuWEBU1CV9IBF2bpTrCAnU82WtKJ57qcHemmBnm49SX3GJu-wyq4-SFFyV2vhof3G/exec';

    // 1. Network Status Monitoring
    function updateNetworkStatus() {
        if (navigator.onLine) {
            syncStatusBadge.textContent = 'Online';
            syncStatusBadge.classList.remove('offline');
            syncStatusBadge.classList.add('online');
        } else {
            syncStatusBadge.textContent = 'Offline';
            syncStatusBadge.classList.remove('online');
            syncStatusBadge.classList.add('offline');
        }
    }

    window.addEventListener('online', updateNetworkStatus);
    window.addEventListener('offline', updateNetworkStatus);
    updateNetworkStatus(); // Run once on load

    // 2. Count Unsynced Records
    function updateUnsyncedCount() {
        if (!db) return; // DB not ready yet

        let count = 0;
        const transaction = db.transaction(['scans', 'newcomers'], 'readonly');

        const countRequest = (storeName) => {
            return new Promise((resolve) => {
                const store = transaction.objectStore(storeName);
                const index = store.index('synced');
                const request = index.count(IDBKeyRange.only(0)); // Count only where synced === 0

                request.onsuccess = () => {
                    count += request.result;
                    resolve();
                };
            });
        };

        // Wait for both tables to be counted
        Promise.all([countRequest('scans'), countRequest('newcomers')]).then(() => {
            unsyncedCountEl.textContent = count;

            // Disable the sync button if there is nothing to sync or we are offline
            syncBtn.disabled = (count === 0 || !navigator.onLine);
            if (count === 0) {
                syncBtn.classList.replace('primary', 'secondary');
            } else {
                syncBtn.classList.replace('secondary', 'primary');
            }
        });
    }

    // Update the count whenever we switch to the Sync tab
    document.querySelector('[data-target="view-sync"]').addEventListener('click', updateUnsyncedCount);

    // Helper function to get unsynced records
    function getUnsyncedRecords(storeName) {
        return new Promise((resolve) => {
            const transaction = db.transaction([storeName], 'readonly');
            const store = transaction.objectStore(storeName);
            const index = store.index('synced');
            const request = index.getAll(IDBKeyRange.only(0));

            request.onsuccess = () => resolve(request.result);
        });
    }

    // Helper function to REMOVE records after successful sync
    function clearSyncedRecords(storeName, records) {
        return new Promise((resolve) => {
            const transaction = db.transaction([storeName], 'readwrite');
            const store = transaction.objectStore(storeName);

            records.forEach(record => {
                store.delete(record.id); // Completely wipe it from the phone
            });

            transaction.oncomplete = () => resolve();
        });
    }

    // 3. The Sync Execution
    syncBtn.addEventListener('click', async () => {
        if (!navigator.onLine) {
            syncLog.innerHTML = `<p style="color: #b91c1c;">Cannot sync while offline.</p>`;
            return;
        }

        syncBtn.textContent = "Syncing...";
        syncBtn.disabled = true;
        syncLog.innerHTML = `<p>Packaging data...</p>`;

        try {
            const unsyncedScans = await getUnsyncedRecords('scans');
            const unsyncedNewcomers = await getUnsyncedRecords('newcomers');

            const payload = { scans: unsyncedScans, newcomers: unsyncedNewcomers };
            syncLog.innerHTML += `<p>Sending ${unsyncedScans.length} scans and ${unsyncedNewcomers.length} newcomers...</p>`;

            // 1. Add a timeout mechanism (Google Script can sometimes hang)
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 15000); // 15-second timeout

            const response = await fetch(GOOGLE_SCRIPT_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'text/plain;charset=utf-8' },
                body: JSON.stringify(payload),
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            // 2. Check for severe HTTP errors (like a 404 Not Found if the URL is wrong)
            if (!response.ok) {
                throw new Error(`Server returned status ${response.status}`);
            }

            // 3. Read the actual JSON response from our Google Apps Script
            const result = await response.json();

            // 4. Check if Google successfully processed it
            if (result.status === "success") {
                await clearSyncedRecords('scans', unsyncedScans);
                await clearSyncedRecords('newcomers', unsyncedNewcomers);

                syncLog.innerHTML += `<p style="color: #047857; font-weight: bold; margin-top: 8px;">✅ Sync Complete!</p>`;
                updateUnsyncedCount();
            } else {
                // This catches errors thrown from inside our Google Script (e.g., sheet deleted)
                throw new Error(result.message || "Unknown Google Script Error");
            }

        } catch (error) {
            console.error("Sync failed:", error);

            // 5. Provide human-readable fallback messages
            let humanMessage = "Check your internet connection and try again.";
            if (error.name === 'AbortError') {
                humanMessage = "The connection timed out. The network might be too slow.";
            } else if (error.message.includes("Unexpected token") || error.message.includes("JSON")) {
                humanMessage = "Invalid response. Ensure the Google Script URL is completely correct and deployed to 'Anyone'.";
            }

            syncLog.innerHTML += `
                <div style="background-color: #fee2e2; border: 1px solid #ef4444; border-radius: 8px; padding: 12px; margin-top: 12px;">
                    <p style="color: #b91c1c; font-weight: bold; margin-bottom: 4px;">❌ Sync Failed</p>
                    <p style="color: #b91c1c; font-size: 0.85rem;">${error.message}</p>
                    <p style="color: #991b1b; font-size: 0.85rem; margin-top: 4px;">💡 ${humanMessage}</p>
                </div>
            `;
        } finally {
            syncBtn.textContent = "Sync Now";
            syncBtn.disabled = false;
        }
    });

    // Make sure we count once when the app boots up
    setTimeout(updateUnsyncedCount, 500);

});