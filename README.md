### Phase 1: The Foundation & UI Shell
In this phase, we will set up the basic web structure. No complex logic yet, just getting the skeleton ready.
*   **1.1 Structure:** Create the base HTML file.
*   **1.2 Styling:** Write the CSS to make it look like a clean, mobile-friendly app (large buttons, clear text, easy to use with one hand).
*   **1.3 Navigation:** Set up the logic to switch between our three main views: "Scan Attendee", "Register Newcomer", and "Sync Data".

### Phase 2: The Offline Engine (QR & Database)
This is the core of the app. We will implement the ability to read and generate codes, and securely save that data to the phone's memory.
*   **2.1 Local Storage Setup:** Initialize IndexedDB to create our local database tables (one for storing scanned attendance logs, another for caching newcomer profiles).
*   **2.2 The Scanner:** Integrate the `html5-qrcode` library to access the rear camera and read QR codes, logging the result and a timestamp into our database.
*   **2.3 The Generator:** Build the form that takes a Full Name and 3-digit Group Number, generates a QR code on the screen, and saves the newcomer to the database.

### Phase 3: The PWA Conversion (Making it "Installable")
Here, we turn our web page into a true offline app that lives on the phone's home screen.
*   **3.1 The Manifest:** Create the `manifest.json` file so the phone recognizes it as an app (defining the name, icons, and theme colors).
*   **3.2 The Service Worker:** Write the script that caches all our HTML, CSS, and JavaScript files directly onto the phone, ensuring the app boots instantly even in your dead-zone meeting hall.

### Phase 4: Cloud Synchronization (The Google Bridge)
Once the offline system is bulletproof, we will build the bridge to your master database.
*   **4.1 Google Apps Script API:** Set up a Google Sheet and write a small serverless script (API endpoint) that can receive data.
*   **4.2 The Sync Logic:** Write the JavaScript function in our app that checks for an internet connection, reads all unsynced records from IndexedDB, packages them, and pushes them to the Google Sheet.
*   **4.3 State Management:** Add logic to successfully clear the local queue only after the Google Sheet confirms receipt.

### Phase 5: Polish & Deployment
The final wrap-up to ensure it is ready for the real world.
*   **5.1 Edge Cases:** Adding error messages (e.g., "Camera permission denied", "Network failed during sync").
*   **5.2 Free Hosting:** Deploying the finalized code to a free host like GitHub Pages so organizers can install it.
