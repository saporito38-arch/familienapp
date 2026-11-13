-- Familien-App: neue Bereiche "Geburtstage" und "Rezepte"
-- Einmal im Supabase-Dashboard ausführen: SQL Editor -> New query -> einfügen -> Run.
-- Das Skript kann gefahrlos mehrfach ausgeführt werden.
-- Zugriff: Nur angemeldete Mitglieder derselben Familie sehen und ändern die Einträge
-- (gleiche Logik wie bei den übrigen Tabellen über die Tabelle "members").

create table if not exists public.birthdays (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null,
  name text not null check (char_length(name) between 1 and 60),
  date date not null,
  no_year boolean not null default false,
  note text default '',
  created_at timestamptz not null default now()
);

create table if not exists public.recipes (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null,
  title text not null check (char_length(title) between 1 and 80),
  ingredients text default '',
  steps text default '',
  link text default '',
  created_by text,
  created_at timestamptz not null default now()
);

alter table public.birthdays enable row level security;
alter table public.recipes enable row level security;

drop policy if exists "Familie verwaltet Geburtstage" on public.birthdays;
create policy "Familie verwaltet Geburtstage" on public.birthdays
  for all to authenticated
  using (family_id in (select m.family_id from public.members m where m.user_id = auth.uid()))
  with check (family_id in (select m.family_id from public.members m where m.user_id = auth.uid()));

drop policy if exists "Familie verwaltet Rezepte" on public.recipes;
create policy "Familie verwaltet Rezepte" on public.recipes
  for all to authenticated
  using (family_id in (select m.family_id from public.members m where m.user_id = auth.uid()))
  with check (family_id in (select m.family_id from public.members m where m.user_id = auth.uid()));

-- Live-Aktualisierung auf allen Geräten
do $$
begin
  begin alter publication supabase_realtime add table public.birthdays; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.recipes;   exception when duplicate_object then null; end;
end $$;
