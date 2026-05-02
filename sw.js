// A unique name for our cache. 
// If you ever update your CSS or JS in the future, change this to 'v2' so phones know to download the new files.
const CACHE_NAME = 'attendance-app-v11';

// Every single file the app needs to run completely offline
const ASSETS_TO_CACHE = [
    './', // The root directory
    './index.html',
    './style.css',
    './app.js',
    './manifest.json',
    './icon-192.png', // The icons you added in Phase 3.1
    './icon-512.png',
    // We also cache the external QR code library from the CDN!
    'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js'
];

// 1. INSTALL EVENT: This happens the very first time the organizer opens the app at home.
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => {
                console.log('Caching all vital assets...');
                return cache.addAll(ASSETS_TO_CACHE);
            })
    );
});

// 2. ACTIVATE EVENT: This cleans up old caches if you ever change the CACHE_NAME version.
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(cacheNames => {
            return Promise.all(
                cacheNames.map(cacheName => {
                    if (cacheName !== CACHE_NAME) {
                        console.log('Deleting old cache:', cacheName);
                        return caches.delete(cacheName);
                    }
                })
            );
        })
    );
});

// 3. FETCH EVENT: The "Bouncer". This runs every time the app asks for a file.
self.addEventListener('fetch', event => {
    event.respondWith(
        caches.match(event.request)
            .then(response => {
                // If the file is in our local cache, return it instantly.
                if (response) {
                    return response;
                }
                // If not, try to fetch it from the internet.
                return fetch(event.request);
            })
    );
});