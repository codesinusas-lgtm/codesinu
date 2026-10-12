# Sinucode Gestor de Lecturas

Aplicación Next.js para importar ciclos de lecturas desde Excel, asignar hojas a trabajadores y capturar lecturas. Supabase guarda los datos compartidos en PostgreSQL, gestiona las sesiones y sincroniza cambios en tiempo real. IndexedDB mantiene cambios pendientes sin conexión y la plantilla Excel original en el navegador del administrador que la importó.

## Configuración de Supabase

1. Crea un proyecto Supabase.
2. En **SQL Editor**, ejecuta `supabase/migrations/20261011000000_initial_schema.sql`.
3. En **Authentication → Providers**, habilita **Anonymous Sign-Ins** para el acceso de trabajadores.
4. Copia la URL del proyecto y la **publishable key** desde **Project Settings → API**.

En Windows, copia `.env.supabase.example` a `.env.local` y completa:

```dotenv
NEXT_PUBLIC_SUPABASE_URL=https://tu-proyecto.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...

# Solo para configurar por primera vez la contraseña del administrador.
# SUPABASE_SECRET_KEY nunca debe comenzar con NEXT_PUBLIC_.
SUPABASE_SECRET_KEY=sb_secret_...
ADMIN_SETUP_TOKEN=token_aleatorio_base64url_de_43_caracteres
```

Genera el token en PowerShell con `node -p "require('crypto').randomBytes(32).toString('base64url')"`. Usa el mismo valor en `.env.local` y en Vercel; no lo publiques ni lo compartas.

Instala dependencias y arranca el servidor:

```powershell
npm install
npm run dev
```

Después de cambiar variables de entorno, reinicia `npm run dev`. La clave publishable es de cliente y depende de que RLS esté configurado; nunca pongas una `service_role` o `sb_secret_` key en una variable `NEXT_PUBLIC_*` ni en el navegador.

En la pantalla de ingreso, **Configurar administrador por primera vez** crea `admin@code.sinu` o establece su contraseña si el usuario ya existe. El código usa `SUPABASE_SECRET_KEY` solo en el servidor y requiere `ADMIN_SETUP_TOKEN`. Después de completar la configuración y comprobar el ingreso, elimina ambas variables de Vercel para retirar ese acceso privilegiado temporal. El flujo solo se puede completar una vez por cuenta.

## Importación, asignaciones y exportación

Entra como administradora, importa el `.xlsx` desde el panel y asigna hojas o rangos a trabajadores. La app normaliza las filas a registros de `readings` y guarda ciclos, trabajadores, asignaciones, presencia y capturas en Supabase. Los trabajadores entran eligiendo su nombre; ese método identifica el trabajador mediante una sesión anónima y las políticas limitan la escritura a sus lecturas asignadas. Cualquier persona con acceso a la lista de nombres podría suplantar a un trabajador; usa credenciales individuales si necesitas identidad fuerte.

Durante la vista previa, la importación detecta trabajadores en las columnas `TRABAJADOR`, `LECTOR` o `ASIGNADO_A`. También reconoce libros con una pestaña maestra y pestañas de trabajadores cuyas filas coinciden por un identificador único (`PRODUCTO`, `CONTRATO`, `MEDIDOR` o `CONSEC`). Las filas de las pestañas individuales se asignan desde la pestaña maestra y no se duplican en la base de datos. Revisa el resumen de trabajadores y lecturas asignadas antes de confirmar.

Si un ciclo anterior ya contiene copias en Supabase, el panel muestra **Unificar duplicados**. La herramienta conserva la fila de la pestaña principal, incorpora la lectura y asignación encontradas en las copias y elimina solo los grupos sin conflictos. Los grupos con lecturas o trabajadores distintos quedan intactos para revisión.

La exportación consulta las lecturas actuales en Supabase y las vuelve a colocar en la estructura del Excel importado, manteniendo hojas y celdas de datos compatibles. El archivo original se conserva localmente en IndexedDB del navegador que lo importó. Para exportar desde otro dispositivo, vincula allí el mismo `.xlsx` original.

La migración comienza reimportando el Excel desde cero. Los datos del proveedor anterior no se copian automáticamente; importa cada libro de nuevo en Supabase.

## Uso sin internet

El modo offline de página completa requiere una URL HTTPS (Vercel cumple este requisito; en desarrollo solo `localhost` permite service workers). Abre la app con internet al menos una vez en cada dispositivo y deja que cargue por completo para guardar la interfaz. Luego inicia sesión y abre **Mis lecturas** conectado para descargar las asignaciones a IndexedDB. Si se pierde la conexión, recarga o vuelve a abrir la app: el trabajador podrá consultar y editar esas lecturas; se sincronizan cuando vuelva internet. El directorio de trabajadores también se guarda localmente para permitir el acceso por nombre en ese mismo dispositivo.

Para probar el modo offline local, usa `npm run build` y luego `npm start`; el service worker se desactiva durante `npm run dev` para evitar que el caché interfiera con HMR. En el celular, prueba desde el dominio HTTPS publicado o instala la PWA desde el navegador. Las lecturas no descargadas previamente y las operaciones de administración que escriben en Supabase necesitan conexión.

## Vercel

Importa el repositorio en Vercel y configura `NEXT_PUBLIC_SUPABASE_URL` y `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` en **Settings → Environment Variables**, copiándolas del mismo proyecto en Supabase → **Project Settings → API Keys**. Vercel incorpora las variables públicas al compilar; después de cambiarlas, crea un nuevo deployment de Production. Si el panel muestra `Invalid API key`, la key configurada no es válida para esa URL: reemplázala con la publishable key actual del proyecto correcto. Un cambio en Git por sí solo no actualiza las variables de Vercel. Para la configuración inicial del administrador, añade también `SUPABASE_SECRET_KEY` y `ADMIN_SETUP_TOKEN` como variables de servidor, despliega, completa el formulario inicial y luego elimina las dos variables privilegiadas. No pongas secretos de servidor en variables `NEXT_PUBLIC_*`. La configuración de Authentication y el esquema/RLS deben estar aplicados en Supabase antes de probar el dominio publicado.

## Comandos

- `npm run dev`: servidor local de desarrollo.
- `npm run typecheck`: comprobación TypeScript.
- `npm run build`: compilación de producción.
- `npm start`: servidor compilado.
