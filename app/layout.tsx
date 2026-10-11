import type { Metadata, Viewport } from 'next';
import './globals.css';
import PWARegister from './pwa-register';
export const metadata: Metadata = { title: 'Sinucode | Gestor de lecturas', description: 'Gestión de lecturas de campo con sincronización offline.', manifest: '/manifest.json' };
export const viewport: Viewport = { themeColor: '#101d35', width: 'device-width', initialScale: 1 };
export default function RootLayout({children}:{children:React.ReactNode}) { return <html lang="es"><body><PWARegister />{children}</body></html>; }
