import Link from 'next/link';
import { ArrowRight, Cloud, ShieldCheck, Smartphone } from 'lucide-react';
import SupabaseConnectionPanel from './supabase-connection-panel';

export default function Home() {
  return <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24, background: 'radial-gradient(circle at 75% 15%,#d9e9ff,transparent 30%),#f4f7fb' }}>
    <div style={{ maxWidth: 1050, width: '100%', display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(300px,1fr))', gap: 50, alignItems: 'center' }}>
      <div>
        <div className="brand" style={{ color: '#14213a', marginBottom: 28 }}><span className="brand-mark">S</span> sinucode <span style={{ fontWeight: 500, color: '#6b7890' }}>lecturas</span></div>
        <div className="eyebrow">OPERACIÓN DE CAMPO · OFFLINE FIRST</div>
        <h1 style={{ fontSize: 'clamp(38px,5vw,58px)', lineHeight: 1.07, marginBottom: 20 }}>Cada lectura cuenta. <span style={{ color: '#1769e0' }}>Incluso sin señal.</span></h1>
        <p style={{ fontSize: 17, lineHeight: 1.7, color: '#68758b', maxWidth: 520, marginBottom: 28 }}>Administra ciclos, asigna rutas y trabajadores, captura lecturas sin internet y sincroniza los resultados con tu equipo en tiempo real.</p>
        <div className="row" style={{ flexWrap: 'wrap' }}><Link className="btn" href="/login">Ingresar al sistema <ArrowRight size={16} /></Link></div>
        <div className="row" style={{ gap: 20, marginTop: 30, flexWrap: 'wrap', color: '#68758b', fontSize: 12 }}>
          <span className="row"><ShieldCheck size={16} /> Roles y permisos</span>
          <span className="row"><Cloud size={16} /> Sincronización</span>
          <span className="row"><Smartphone size={16} /> PWA móvil</span>
        </div>
      </div>
      <SupabaseConnectionPanel />
    </div>
  </main>;
}
