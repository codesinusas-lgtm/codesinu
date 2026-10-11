'use client';
import { useEffect } from 'react';
export default function PWARegister() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;

    if (process.env.NODE_ENV !== 'production') {
      let cancelled = false;
      const clearDevelopmentWorker = async () => {
        try {
          const registrations = await navigator.serviceWorker.getRegistrations();
          await Promise.all(registrations.map(registration => registration.unregister()));
          const cacheNames = await caches.keys();
          await Promise.all(cacheNames
            .filter(name => name.startsWith('sinucode-shell-'))
            .map(name => caches.delete(name)));

          const resetKey = 'sinucode-dev-service-worker-reset';
          if (!cancelled && navigator.serviceWorker.controller && sessionStorage.getItem(resetKey) !== '1') {
            sessionStorage.setItem(resetKey, '1');
            window.location.reload();
          }
        } catch (error) {
          console.warn('No se pudo limpiar el service worker de desarrollo', error);
        }
      };

      void clearDevelopmentWorker();
      return () => { cancelled = true; };
    }

    navigator.serviceWorker.register('/sw.js')
      .catch(error => console.warn('No se pudo registrar service worker', error));
  }, []);

  return null;
}
