const CACHE_NAME = 'motivation-app-v2'; // Поменяли на v2 для обновления
const urlsToCache = [
  './',
  './index.html',
  './styles.css',     // НОВОЕ: кэшируем стили
  './app.js',         // НОВОЕ: кэшируем логику
  './manifest.json',
  './icon.png'        // Добавил иконку, чтобы она тоже была в памяти
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

// Активация и удаление старых кэшей (очистит старый motivation-app-v1)
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

// Перехват запросов (возвращаем кэш, если нет интернета)
self.addEventListener('fetch', event => {
  // Мы не кэшируем POST-запросы к Google Apps Script и Supabase API
  if (event.request.method !== 'GET') return;
  
  event.respondWith(
    caches.match(event.request)
      .then(response => {
        if (response) return response; // Отдаем из кэша
        return fetch(event.request).catch(() => {
            // Если нет сети, запрос просто тихо умрет (мы это обрабатываем в app.js)
        });
      })
  );
});
