-- Familien-App: neue Bereiche "Geburtstage" und "Rezepte"
-- Einmal im Supabase-Dashboard ausführen: SQL Editor -> New query -> alles einfügen -> Run.
-- Das Skript kann gefahrlos mehrfach ausgeführt werden.
-- Falls Supabase vor "destructive operations" warnt: Das betrifft nur das Neu-Anlegen
-- der Zugriffsregeln dieser beiden Tabellen, es werden keine Daten gelöscht.
--
-- Die Spalte family_id bekommt automatisch denselben Datentyp wie in der Tabelle "members".

do $$
declare
  t text;
begin
  select format_type(a.atttypid, a.atttypmod) into t
  from pg_attribute a
  where a.attrelid = 'public.members'::regclass and a.attname = 'family_id' and not a.attisdropped;
  if t is null then
    raise exception 'Spalte family_id in der Tabelle members nicht gefunden';
  end if;

  execute format('create table if not exists public.birthdays (
      id uuid primary key default gen_random_uuid(),
      family_id %s not null,
      name text not null,
      date date not null,
      no_year boolean not null default false,
      note text default '''',
      created_at timestamptz not null default now()
    )', t);

  execute format('create table if not exists public.recipes (
      id uuid primary key default gen_random_uuid(),
      family_id %s not null,
      title text not null,
      ingredients text default '''',
      steps text default '''',
      link text default '''',
      created_by text,
      created_at timestamptz not null default now()
    )', t);

  -- Falls ein früherer Versuch die Tabellen mit falschem Typ angelegt hat: angleichen
  execute format('alter table public.birthdays alter column family_id type %1$s using family_id::text::%1$s', t);
  execute format('alter table public.recipes alter column family_id type %1$s using family_id::text::%1$s', t);
end $$;

alter table public.birthdays enable row level security;
alter table public.recipes enable row level security;

drop policy if exists "Familie verwaltet Geburtstage" on public.birthdays;
create policy "Familie verwaltet Geburtstage" on public.birthdays
  for all to authenticated
  using (exists (select 1 from public.members m where m.user_id = auth.uid() and m.family_id = birthdays.family_id))
  with check (exists (select 1 from public.members m where m.user_id = auth.uid() and m.family_id = birthdays.family_id));

drop policy if exists "Familie verwaltet Rezepte" on public.recipes;
create policy "Familie verwaltet Rezepte" on public.recipes
  for all to authenticated
  using (exists (select 1 from public.members m where m.user_id = auth.uid() and m.family_id = recipes.family_id))
  with check (exists (select 1 from public.members m where m.user_id = auth.uid() and m.family_id = recipes.family_id));

grant select, insert, update, delete on public.birthdays, public.recipes to authenticated;

-- Live-Aktualisierung auf allen Geräten
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'birthdays') then
      execute 'alter publication supabase_realtime add table public.birthdays';
    end if;
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'recipes') then
      execute 'alter publication supabase_realtime add table public.recipes';
    end if;
  end if;
end $$;
