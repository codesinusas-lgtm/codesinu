-- Sinucode worker readings schema for Supabase/Postgres.
-- Run once in Supabase SQL Editor before configuring the app.

create table if not exists public.workers (
  uid text primary key,
  name text not null,
  email text not null default '',
  role text not null default 'worker' check (role in ('worker', 'lector')),
  active boolean not null default true,
  created_at bigint not null default (extract(epoch from now()) * 1000)::bigint,
  created_by text
);

create table if not exists public.cycles (
  id text primary key,
  name text not null,
  status text not null default 'active' check (status in ('draft', 'active', 'closed')),
  import_status text check (import_status in ('importing', 'active', 'failed')),
  sheet_names text[] not null default '{}',
  data_sheet_names text[] not null default '{}',
  record_count integer not null default 0,
  source_file_name text not null default '',
  source_fingerprint text not null default '',
  created_at bigint not null default (extract(epoch from now()) * 1000)::bigint,
  created_by text,
  imported_at bigint,
  import_error text
);

create table if not exists public.assignments (
  id text primary key,
  cycle_id text not null references public.cycles(id) on delete cascade,
  worker_uid text not null references public.workers(uid),
  worker_name text not null default '',
  sheet_name text not null,
  mode text not null check (mode in ('sheet', 'range')),
  start_row integer,
  end_row integer,
  record_count integer not null default 0,
  status text not null default 'assigning' check (status in ('assigning', 'active', 'failed')),
  created_at bigint not null default (extract(epoch from now()) * 1000)::bigint,
  created_by text,
  assigned_at bigint
);

create table if not exists public.readings (
  id text primary key,
  cycle_id text not null references public.cycles(id) on delete cascade,
  sheet_name text not null,
  row_number integer not null,
  worker_uid text references public.workers(uid),
  assignment_id text references public.assignments(id) on delete set null,
  assigned_at bigint,
  base jsonb not null default '{}'::jsonb,
  reading text not null default '',
  observation text not null default '',
  novelty text not null default '',
  updated_at bigint not null default (extract(epoch from now()) * 1000)::bigint,
  version integer not null default 0,
  unique (cycle_id, sheet_name, row_number)
);

create table if not exists public.presence (
  uid text primary key,
  email text not null default '',
  online boolean not null default false,
  last_seen bigint not null default (extract(epoch from now()) * 1000)::bigint
);

create index if not exists readings_cycle_sheet_row_idx on public.readings(cycle_id, sheet_name, row_number);
create index if not exists readings_worker_sheet_row_idx on public.readings(worker_uid, sheet_name, row_number);
create index if not exists assignments_worker_cycle_idx on public.assignments(worker_uid, cycle_id);

create or replace function public.is_sinucode_admin()
returns boolean
language sql
stable
as $$
  select lower(coalesce(auth.jwt() ->> 'email', '')) = 'anpa23co@gmail.com'
$$;

create or replace function public.is_sinucode_worker(target_uid text)
returns boolean
language sql
stable
as $$
  select coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false)
    and coalesce(auth.jwt() -> 'user_metadata' ->> 'worker_uid', '') = target_uid
$$;

create or replace function public.guard_worker_reading_update()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if not public.is_sinucode_admin() and public.is_sinucode_worker(old.worker_uid) then
    if new.id is distinct from old.id
      or new.cycle_id is distinct from old.cycle_id
      or new.sheet_name is distinct from old.sheet_name
      or new.row_number is distinct from old.row_number
      or new.worker_uid is distinct from old.worker_uid
      or new.assignment_id is distinct from old.assignment_id
      or new.assigned_at is distinct from old.assigned_at
      or new.base is distinct from old.base then
      raise exception 'Worker sessions may only edit reading, novelty, observation and version.';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists guard_worker_reading_update on public.readings;
create trigger guard_worker_reading_update
before update on public.readings
for each row execute function public.guard_worker_reading_update();

alter table public.workers enable row level security;
alter table public.cycles enable row level security;
alter table public.assignments enable row level security;
alter table public.readings enable row level security;
alter table public.presence enable row level security;

drop policy if exists workers_public_directory on public.workers;
create policy workers_public_directory on public.workers
  for select to anon using (active = true);
drop policy if exists workers_admin_all on public.workers;
create policy workers_admin_all on public.workers
  for all to authenticated using (public.is_sinucode_admin()) with check (public.is_sinucode_admin());

drop policy if exists cycles_admin_all on public.cycles;
create policy cycles_admin_all on public.cycles
  for all to authenticated using (public.is_sinucode_admin()) with check (public.is_sinucode_admin());

drop policy if exists assignments_admin_all on public.assignments;
create policy assignments_admin_all on public.assignments
  for all to authenticated using (public.is_sinucode_admin()) with check (public.is_sinucode_admin());
drop policy if exists assignments_worker_read on public.assignments;
create policy assignments_worker_read on public.assignments
  for select to authenticated using (public.is_sinucode_worker(worker_uid));

drop policy if exists readings_admin_all on public.readings;
create policy readings_admin_all on public.readings
  for all to authenticated using (public.is_sinucode_admin()) with check (public.is_sinucode_admin());
drop policy if exists readings_worker_read on public.readings;
create policy readings_worker_read on public.readings
  for select to authenticated using (public.is_sinucode_worker(worker_uid));
drop policy if exists readings_worker_update on public.readings;
create policy readings_worker_update on public.readings
  for update to authenticated using (public.is_sinucode_worker(worker_uid))
  with check (public.is_sinucode_worker(worker_uid));

drop policy if exists presence_admin_read on public.presence;
create policy presence_admin_read on public.presence
  for select to authenticated using (public.is_sinucode_admin());
drop policy if exists presence_own_write on public.presence;
create policy presence_own_write on public.presence
  for all to authenticated using (uid = auth.uid()::text)
  with check (uid = auth.uid()::text);

grant usage on schema public to anon, authenticated;
grant select (uid, name, active) on public.workers to anon;
grant select, insert, update, delete on public.workers, public.cycles, public.assignments,
  public.readings, public.presence to authenticated;

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'workers') then
    execute 'alter publication supabase_realtime add table public.workers';
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'cycles') then
    execute 'alter publication supabase_realtime add table public.cycles';
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'assignments') then
    execute 'alter publication supabase_realtime add table public.assignments';
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'readings') then
    execute 'alter publication supabase_realtime add table public.readings';
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'presence') then
    execute 'alter publication supabase_realtime add table public.presence';
  end if;
end;
$$;
