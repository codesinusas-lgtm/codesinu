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
        console.error('Supabase worker directory load failed', cause);
        setError(`No se pudo cargar la lista de Supabase${code ? ` (${code})` : ''}. Revisa la conexión y las políticas RLS.`);
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
      console.error('Supabase admin sign-in failed', cause);
      setError(code === 'invalid_credentials'
        ? 'Supabase rechazó el correo o la contraseña. Crea la cuenta del administrador en Authentication → Users.'
        : `No se pudo iniciar sesión como administrador${code ? ` (${code})` : ''}. Comprueba las credenciales y el proyecto Supabase.`);
    } finally {
      setLoading(false);
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
      {mode === 'admin' ? <form onSubmit={submitAdmin}>
        <div className="stat-icon" style={{ marginBottom: 16 }}><LockKeyhole size={20} /></div>
        <p className="small muted" style={{ marginBottom: 14 }}>Acceso reservado para la cuenta administradora.</p>
        <label className="field" style={{ marginBottom: 15 }}>Correo electrónico
          <input className="input" type="email" required value={email} readOnly aria-label="Correo administrador" />
        </label>
        <label className="field" style={{ marginBottom: 22 }}>Contraseña
          <input className="input" type="password" required value={password} onChange={event => setPassword(event.target.value)} placeholder="Contraseña del administrador" />
        </label>
        <button className="btn" disabled={loading || !supabaseConfigured} style={{ width: '100%', padding: 13 }}>{loading ? 'Ingresando…' : 'Ingresar como administrador'}</button>
      </form> : <form onSubmit={enterAsWorker}>
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
