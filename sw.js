const CACHE_NAME = 'motivation-app-v1';
const urlsToCache = [
  './',
  './index.html',
  './manifest.json'
];

// Установка Service Worker и кэширование основных файлов
self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('Opened cache');
        return cache.addAll(urlsToCache);
      })
  );
});

// Активация и удаление старых кэшей
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
});

// Перехват запросов (возвращаем кэш, если нет интернета)
self.addEventListener('fetch', event => {
  // Мы не кэшируем POST-запросы к Google Apps Script
  if (event.request.method !== 'GET') return;
  
  event.respondWith(
    caches.match(event.request)
      .then(response => {
        if (response) return response; // Отдаем из кэша
        return fetch(event.request).catch(() => {
            // Если нет сети, можно вернуть заглушку
        });
      })
  );
});
