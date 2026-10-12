'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, LockKeyhole, UserRound } from 'lucide-react';
import { getSupabase, supabaseConfigured } from '@/lib/supabase/client';
import { ADMIN_EMAIL, hasAdminAccess } from '@/lib/auth-roles';
import { localDB } from '@/lib/localdb';

type WorkerOption = { uid: string; name: string; active: boolean };

export default function LoginPage() {
  const [mode, setMode] = useState<'admin' | 'worker'>('admin');
  const [email, setEmail] = useState(ADMIN_EMAIL);
  const [password, setPassword] = useState('');
  const [showAdminSetup, setShowAdminSetup] = useState(false);
  const [setupToken, setSetupToken] = useState('');
  const [setupPassword, setSetupPassword] = useState('');
  const [setupPasswordConfirm, setSetupPasswordConfirm] = useState('');
  const [setupLoading, setSetupLoading] = useState(false);
  const [workers, setWorkers] = useState<WorkerOption[]>([]);
  const [workerUid, setWorkerUid] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadingWorkers, setLoadingWorkers] = useState(true);
  const [online, setOnline] = useState(true);
  const router = useRouter();

  useEffect(() => {
    const updateOnline = () => setOnline(navigator.onLine);
    updateOnline();
    window.addEventListener('online', updateOnline);
    window.addEventListener('offline', updateOnline);
    return () => {
      window.removeEventListener('online', updateOnline);
      window.removeEventListener('offline', updateOnline);
    };
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const cached = (await localDB.workers.toArray()).filter(worker => worker.active).sort((a, b) => a.name.localeCompare(b.name, 'es'));
        if (cached.length) setWorkers(cached);
        if (!supabaseConfigured || !navigator.onLine) return;
        const { data, error: queryError } = await getSupabase().from('workers').select('uid,name,active').eq('active', true).order('name');
        if (queryError) throw queryError;
        const loadedWorkers = (data || []).filter(worker => worker.name?.trim()) as WorkerOption[];
        setWorkers(loadedWorkers);
        await localDB.workers.bulkPut(loadedWorkers);
      } catch (cause) {
        if (!navigator.onLine) return;
        const code = typeof cause === 'object' && cause && 'code' in cause ? String(cause.code) : '';
        const errorMessage = cause instanceof Error ? cause.message : '';
        console.error('Supabase worker directory load failed', cause);
        const normalizedMessage = errorMessage.toLowerCase();
        setError(normalizedMessage.includes('invalid api key')
          ? 'Supabase rechazó la publishable key (Invalid API key). En Vercel → Settings → Environment Variables, copia la key actual de Project Settings → API Keys del mismo proyecto que NEXT_PUBLIC_SUPABASE_URL y vuelve a desplegar.'
          : code === '42501' || code === 'PGRST301'
            ? 'Supabase rechazó la lectura de trabajadores por permisos. Aplica la migración SQL para habilitar la política pública de lectura de trabajadores activos.'
            : code === 'PGRST205'
              ? 'No se encuentra la tabla public.workers en Supabase. Ejecuta la migración del proyecto en SQL Editor.'
              : `No se pudo cargar la lista de Supabase${code ? ` (${code})` : ''}${errorMessage ? `: ${errorMessage}` : '. Comprueba la conexión.'}`);
      } finally {
        setLoadingWorkers(false);
      }
    })();
  }, []);

  async function submitAdmin(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    if (!supabaseConfigured) {
      setError('Supabase aún no está configurado. Agrega la URL y la publishable key en .env.local.');
      return;
    }
    setLoading(true);
    try {
      const supabase = getSupabase();
      if ((await supabase.auth.getSession()).data.session) await supabase.auth.signOut();
      const { data, error: authError } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
      if (authError) throw authError;
      if (!hasAdminAccess(data.user.email, Boolean(data.user.email_confirmed_at), data.user.app_metadata?.role)) {
        await supabase.auth.signOut();
        setError(`Esta cuenta no es administradora. Usa la cuenta ${ADMIN_EMAIL}.`);
        return;
      }
      router.replace('/admin');
    } catch (cause) {
      const code = typeof cause === 'object' && cause && 'code' in cause ? String(cause.code) : '';
      const errorMessage = cause instanceof Error ? cause.message : '';
      console.error('Supabase admin sign-in failed', cause);
      setError(errorMessage.toLowerCase().includes('invalid api key')
        ? 'Supabase rechazó la API key. Copia la URL y la publishable key del mismo proyecto en Supabase; en Vercel, vuelve a desplegar después de actualizarlas.'
        : code === 'invalid_credentials'
        ? 'El correo o la contraseña no coinciden. Si no recuerdas la clave, usa “Configurar administrador por primera vez” para definirla desde la app.'
        : `No se pudo iniciar sesión como administrador${code ? ` (${code})` : ''}. Comprueba las credenciales y el proyecto Supabase.`);
    } finally {
      setLoading(false);
    }
  }

  async function setupAdmin(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    if (!navigator.onLine) {
      setError('La configuración del administrador requiere internet.');
      return;
    }
    if (setupPassword !== setupPasswordConfirm) {
      setError('Las contraseñas no coinciden.');
      return;
    }
    setSetupLoading(true);
    try {
      const response = await fetch('/api/admin/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({ token: setupToken, password: setupPassword }),
      });
      const result = await response.json() as { message?: string; error?: string };
      if (!response.ok) throw new Error(result.error || 'No se pudo configurar el administrador.');

      const newPassword = setupPassword;
      setPassword(newPassword);
      setShowAdminSetup(false);
      setSetupToken('');
      setSetupPassword('');
      setSetupPasswordConfirm('');
      const { error: authError } = await getSupabase().auth.signInWithPassword({ email: ADMIN_EMAIL, password: newPassword });
      if (authError) {
        setError('La cuenta se configuró, pero no se pudo iniciar sesión automáticamente. Usa el correo y la contraseña nuevos en el formulario de administrador.');
        return;
      }
      router.replace('/admin');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'No se pudo configurar el administrador.');
    } finally {
      setSetupLoading(false);
    }
  }

  async function enterAsWorker(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    if (!supabaseConfigured) {
      setError('Supabase aún no está configurado. Agrega la URL y la publishable key en .env.local.');
      return;
    }
    if (!workerUid) {
      setError('Selecciona tu nombre para continuar.');
      return;
    }
    if (!navigator.onLine) {
      const selectedWorker = workers.find(worker => worker.uid === workerUid);
      if (!selectedWorker) {
        setError('Conéctate a internet una vez para cargar y guardar el directorio de trabajadores en este dispositivo.');
        return;
      }
      sessionStorage.setItem('sinucode-offline-worker', JSON.stringify({ uid: selectedWorker.uid, name: selectedWorker.name }));
      router.replace('/trabajador');
      return;
    }
    setLoading(true);
    try {
      const supabase = getSupabase();
      if ((await supabase.auth.getSession()).data.session) await supabase.auth.signOut();
      const workerName = workers.find(worker => worker.uid === workerUid)?.name || 'Trabajador';
      const { error: authError } = await supabase.auth.signInAnonymously({
        options: { data: { worker_uid: workerUid, worker_name: workerName } },
      });
      if (authError) throw authError;
      router.replace('/trabajador');
    } catch (cause) {
      const code = typeof cause === 'object' && cause && 'code' in cause ? String(cause.code) : '';
      console.error('Supabase worker sign-in failed', cause);
      setError(code === 'anonymous_provider_disabled'
        ? 'Activa Anonymous Sign-Ins en Supabase → Authentication → Providers.'
        : `No se pudo iniciar la sesión de trabajador${code ? ` (${code})` : ''}. Revisa Supabase Auth, internet y las políticas RLS.`);
    } finally {
      setLoading(false);
    }
  }

  return <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 20 }}>
    <section className="panel" style={{ width: '100%', maxWidth: 440, padding: 30 }}>
      <Link href="/" className="row muted" style={{ textDecoration: 'none', fontSize: 13, marginBottom: 28 }}><ArrowLeft size={15} /> Volver al inicio</Link>
      <div className="brand" style={{ color: '#14213a', marginBottom: 25 }}><span className="brand-mark">S</span> sinucode</div>
      <h1 style={{ fontSize: 27, marginBottom: 8 }}>Ingresar</h1>
      <p className="muted" style={{ fontSize: 14, marginBottom: 22 }}>Elige cómo ingresar al sistema.</p>
      <div className="row" style={{ marginBottom: 22 }}>
        <button type="button" className={`btn ${mode === 'admin' ? '' : 'secondary'}`} onClick={() => { setMode('admin'); setError(''); }}>Administrador</button>
        <button type="button" className={`btn ${mode === 'worker' ? '' : 'secondary'}`} onClick={() => { setMode('worker'); setError(''); }}>Trabajador</button>
      </div>
      {!supabaseConfigured && <div className="notice warn" role="alert" style={{ marginBottom: 16 }}>Configura NEXT_PUBLIC_SUPABASE_URL y NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY para conectar Supabase.</div>}
      {error && <div className="notice warn" role="alert" style={{ marginBottom: 16 }}>{error}</div>}
      {mode === 'admin' ? <>
        <form onSubmit={submitAdmin}>
          <div className="stat-icon" style={{ marginBottom: 16 }}><LockKeyhole size={20} /></div>
          <p className="small muted" style={{ marginBottom: 14 }}>Acceso reservado para la cuenta administradora.</p>
          <label className="field" style={{ marginBottom: 15 }}>Correo electrónico
            <input className="input" type="email" required value={email} readOnly aria-label="Correo administrador" />
          </label>
          <label className="field" style={{ marginBottom: 22 }}>Contraseña
            <input className="input" type="password" required value={password} onChange={event => setPassword(event.target.value)} placeholder="Contraseña del administrador" />
          </label>
          <button className="btn" disabled={loading || setupLoading || !supabaseConfigured} style={{ width: '100%', padding: 13 }}>{loading ? 'Ingresando…' : 'Ingresar como administrador'}</button>
        </form>
        <button type="button" className="btn secondary" disabled={loading || setupLoading} onClick={() => { setShowAdminSetup(open => !open); setError(''); }} style={{ width: '100%', marginTop: 12 }}>
          {showAdminSetup ? 'Volver al ingreso' : 'Configurar administrador por primera vez'}
        </button>
        {showAdminSetup && <form onSubmit={setupAdmin} style={{ marginTop: 18, paddingTop: 18, borderTop: '1px solid #e7ebf1' }}>
          <h2 style={{ fontSize: 16, marginBottom: 8 }}>Configurar acceso sin correo</h2>
          <p className="small muted" style={{ lineHeight: 1.6, marginBottom: 15 }}>Usa el código privado de 43 caracteres configurado en el servidor. Este proceso crea el usuario o fija la contraseña de la cuenta administradora existente y solo se permite una vez.</p>
          <label className="field" style={{ marginBottom: 14 }}>Código de configuración
            <input className="input" type="password" autoComplete="off" required minLength={43} maxLength={43} value={setupToken} onChange={event => setSetupToken(event.target.value)} />
          </label>
          <label className="field" style={{ marginBottom: 14 }}>Nueva contraseña (mínimo 12 caracteres)
            <input className="input" type="password" autoComplete="new-password" required minLength={12} maxLength={128} value={setupPassword} onChange={event => setSetupPassword(event.target.value)} />
          </label>
          <label className="field" style={{ marginBottom: 18 }}>Confirma la contraseña
            <input className="input" type="password" autoComplete="new-password" required minLength={12} maxLength={128} value={setupPasswordConfirm} onChange={event => setSetupPasswordConfirm(event.target.value)} />
          </label>
          <button className="btn" disabled={setupLoading || !supabaseConfigured} style={{ width: '100%', padding: 13 }}>{setupLoading ? 'Configurando cuenta…' : 'Crear y entrar como administrador'}</button>
        </form>}
      </> : <form onSubmit={enterAsWorker}>
        <div className="stat-icon" style={{ marginBottom: 16 }}><UserRound size={20} /></div>
        <label className="field" style={{ marginBottom: 18 }}>Selecciona tu nombre
          <select className="input" required value={workerUid} onChange={event => setWorkerUid(event.target.value)}>
            <option value="">{loadingWorkers ? 'Cargando trabajadores…' : 'Seleccionar trabajador'}</option>
            {workers.map(worker => <option key={worker.uid} value={worker.uid}>{worker.name}</option>)}
          </select>
        </label>
        {!loadingWorkers && workers.length === 0 && <p className="small muted" style={{ marginBottom: 16 }}>Aún no hay trabajadores activos en Supabase. El administrador debe crearlos primero.</p>}
        <button className="btn" disabled={loading || loadingWorkers || !supabaseConfigured || workers.length === 0} style={{ width: '100%', padding: 13 }}>{loading ? 'Ingresando…' : 'Ingresar a mis lecturas'}</button>
        <p className="small muted" style={{ lineHeight: 1.6, marginTop: 16 }}>El acceso por nombre no verifica la identidad de quien ingresa.</p>
        {!online && workers.length > 0 && <p className="small muted" style={{ lineHeight: 1.6, marginTop: 8 }}>Sin conexión: puedes entrar con los trabajadores cargados previamente en este dispositivo. Los cambios se sincronizan al reconectar.</p>}
      </form>}
    </section>
  </main>;
}
