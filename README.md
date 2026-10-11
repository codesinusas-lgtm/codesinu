# Sinucode Gestor de Lecturas

Aplicación Next.js para importar ciclos de lecturas desde Excel, asignar hojas a trabajadores y capturar lecturas. Supabase guarda los datos compartidos en PostgreSQL, gestiona las sesiones y sincroniza cambios en tiempo real. IndexedDB mantiene cambios pendientes sin conexión y la plantilla Excel original en el navegador del administrador que la importó.

## Configuración de Supabase

1. Crea un proyecto Supabase.
2. En **SQL Editor**, ejecuta `supabase/migrations/20261011000000_initial_schema.sql`.
3. En **Authentication → Providers**, habilita **Anonymous Sign-Ins** para el acceso de trabajadores.
4. En **Authentication → Users**, crea la cuenta administradora `anpa23co@gmail.com` y establece una contraseña. Las políticas RLS reconocen esa dirección.
5. Copia la URL del proyecto y la **publishable key** desde **Project Settings → API**.

En Windows, copia `.env.example` a `.env.local` y completa:

```dotenv
NEXT_PUBLIC_SUPABASE_URL=https://tu-proyecto.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
```

Instala dependencias y arranca el servidor:

```powershell
npm install
npm run dev
```

Después de cambiar variables de entorno, reinicia `npm run dev`. La clave publishable es de cliente y depende de que RLS esté configurado; nunca pongas una `service_role` key en una variable `NEXT_PUBLIC_*` ni en el navegador.

## Importación, asignaciones y exportación

Entra como administradora, importa el `.xlsx` desde el panel y asigna hojas o rangos a trabajadores. La app normaliza las filas a registros de `readings` y guarda ciclos, trabajadores, asignaciones, presencia y capturas en Supabase. Los trabajadores entran eligiendo su nombre; ese método identifica el trabajador mediante una sesión anónima y las políticas limitan la escritura a sus lecturas asignadas. Cualquier persona con acceso a la lista de nombres podría suplantar a un trabajador; usa credenciales individuales si necesitas identidad fuerte.

La exportación consulta las lecturas actuales en Supabase y las vuelve a colocar en la estructura del Excel importado, manteniendo hojas y celdas de datos compatibles. El archivo original se conserva localmente en IndexedDB del navegador que lo importó. Para exportar desde otro dispositivo, vincula allí el mismo `.xlsx` original.

La decisión de esta migración es reimportar Excel desde cero. Los registros que ya estén en Firebase no se copian automáticamente y permanecen en ese proyecto hasta que los elimines allí. Importa de nuevo cada libro en Supabase.

## Uso sin internet

El modo offline de página completa requiere una URL HTTPS (Vercel cumple este requisito; en desarrollo solo `localhost` permite service workers). Abre la app con internet al menos una vez en cada dispositivo y deja que cargue por completo para guardar la interfaz. Luego inicia sesión y abre **Mis lecturas** conectado para descargar las asignaciones a IndexedDB. Si se pierde la conexión, recarga o vuelve a abrir la app: el trabajador podrá consultar y editar esas lecturas; se sincronizan cuando vuelva internet. El directorio de trabajadores también se guarda localmente para permitir el acceso por nombre en ese mismo dispositivo.

Para probar el modo offline local, usa `npm run build` y luego `npm start`; el service worker se desactiva durante `npm run dev` para evitar que el caché interfiera con HMR. En el celular, prueba desde el dominio HTTPS publicado o instala la PWA desde el navegador. Las lecturas no descargadas previamente y las operaciones de administración que escriben en Supabase necesitan conexión.

## Vercel

Importa el repositorio en Vercel y configura `NEXT_PUBLIC_SUPABASE_URL` y `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` en las variables del proyecto. Despliega. No necesitas poner secretos de servidor en el cliente. La configuración de Authentication y el esquema/RLS deben estar aplicados en Supabase antes de probar el dominio publicado.

## Comandos

- `npm run dev`: servidor local de desarrollo.
- `npm run typecheck`: comprobación TypeScript.
- `npm run build`: compilación de producción.
- `npm start`: servidor compilado.
