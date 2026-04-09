-- ═══════════════════════════════════════════════════════════════════
-- KMs Inteligentes — Supabase Schema v1
-- Ejecutar en: Supabase Dashboard > SQL Editor
-- ═══════════════════════════════════════════════════════════════════

-- ── Habilitar extensiones ────────────────────────────────────────
create extension if not exists "pgcrypto";

-- ── Perfiles de usuario ───────────────────────────────────────────
create table if not exists profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  role        text not null default 'athlete' check (role in ('athlete','coach')),
  created_at  timestamptz not null default now()
);

-- Crear perfil automáticamente al registrarse
create or replace function handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into profiles (id, display_name, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)),
    coalesce(new.raw_user_meta_data->>'role', 'athlete')
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure handle_new_user();

-- ── Equipos ───────────────────────────────────────────────────────
create table if not exists teams (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  coach_id   uuid not null references profiles(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists team_members (
  team_id    uuid not null references teams(id) on delete cascade,
  athlete_id uuid not null references profiles(id) on delete cascade,
  joined_at  timestamptz not null default now(),
  primary key (team_id, athlete_id)
);

-- ── Tokens de plataformas (cifrados en JSONB) ─────────────────────
create table if not exists garmin_sessions (
  user_id     uuid primary key references profiles(id) on delete cascade,
  session_data jsonb not null,
  updated_at  timestamptz not null default now()
);

create table if not exists strava_tokens (
  user_id     uuid primary key references profiles(id) on delete cascade,
  token_data  jsonb not null,
  updated_at  timestamptz not null default now()
);

create table if not exists coros_tokens (
  user_id     uuid primary key references profiles(id) on delete cascade,
  token_data  jsonb not null,
  updated_at  timestamptz not null default now()
);

-- ── Planes de entrenamiento ───────────────────────────────────────
create table if not exists daily_plans (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references profiles(id) on delete cascade,
  plan_date  date not null,
  plan_data  jsonb not null,
  created_at timestamptz not null default now(),
  unique (user_id, plan_date)
);

create table if not exists annual_plans (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references profiles(id) on delete cascade,
  year       int not null,
  plan_data  jsonb not null,
  created_at timestamptz not null default now(),
  unique (user_id, year)
);

-- ── Row Level Security ────────────────────────────────────────────
alter table profiles        enable row level security;
alter table teams           enable row level security;
alter table team_members    enable row level security;
alter table garmin_sessions enable row level security;
alter table strava_tokens   enable row level security;
alter table coros_tokens    enable row level security;
alter table daily_plans     enable row level security;
alter table annual_plans    enable row level security;

-- profiles: cada usuario ve/edita solo el suyo; coaches ven atletas de su equipo
create policy "profiles_own"        on profiles for all using (auth.uid() = id);
create policy "profiles_coach_read" on profiles for select
  using (
    exists (
      select 1 from team_members tm
      join teams t on t.id = tm.team_id
      where tm.athlete_id = profiles.id
        and t.coach_id = auth.uid()
    )
  );

-- teams: coaches gestionan sus equipos
create policy "teams_coach"  on teams for all using (coach_id = auth.uid());
create policy "teams_member" on teams for select
  using (exists (select 1 from team_members where team_id = teams.id and athlete_id = auth.uid()));

-- team_members: coaches gestionan, atletas se ven a sí mismos
create policy "tm_coach"   on team_members for all
  using (exists (select 1 from teams where id = team_members.team_id and coach_id = auth.uid()));
create policy "tm_athlete" on team_members for select using (athlete_id = auth.uid());

-- tokens: solo el propietario
create policy "garmin_own"  on garmin_sessions for all using (user_id = auth.uid());
create policy "strava_own"  on strava_tokens   for all using (user_id = auth.uid());
create policy "coros_own"   on coros_tokens    for all using (user_id = auth.uid());

-- coaches pueden ver tokens de sus atletas (para operaciones delegadas)
create policy "garmin_coach" on garmin_sessions for select
  using (exists (
    select 1 from team_members tm join teams t on t.id = tm.team_id
    where tm.athlete_id = garmin_sessions.user_id and t.coach_id = auth.uid()
  ));
create policy "strava_coach" on strava_tokens for select
  using (exists (
    select 1 from team_members tm join teams t on t.id = tm.team_id
    where tm.athlete_id = strava_tokens.user_id and t.coach_id = auth.uid()
  ));
create policy "coros_coach" on coros_tokens for select
  using (exists (
    select 1 from team_members tm join teams t on t.id = tm.team_id
    where tm.athlete_id = coros_tokens.user_id and t.coach_id = auth.uid()
  ));

-- daily_plans: propietario + coach de su equipo (solo lectura)
create policy "daily_own"   on daily_plans for all using (user_id = auth.uid());
create policy "daily_coach" on daily_plans for select
  using (exists (
    select 1 from team_members tm join teams t on t.id = tm.team_id
    where tm.athlete_id = daily_plans.user_id and t.coach_id = auth.uid()
  ));

-- annual_plans: propietario + coach (lectura) + coach puede asignar (insert con user_id del atleta)
create policy "annual_own"          on annual_plans for all    using (user_id = auth.uid());
create policy "annual_coach_read"   on annual_plans for select
  using (exists (
    select 1 from team_members tm join teams t on t.id = tm.team_id
    where tm.athlete_id = annual_plans.user_id and t.coach_id = auth.uid()
  ));
create policy "annual_coach_write"  on annual_plans for insert
  with check (exists (
    select 1 from team_members tm join teams t on t.id = tm.team_id
    where tm.athlete_id = annual_plans.user_id and t.coach_id = auth.uid()
  ));
create policy "annual_coach_update" on annual_plans for update
  using (exists (
    select 1 from team_members tm join teams t on t.id = tm.team_id
    where tm.athlete_id = annual_plans.user_id and t.coach_id = auth.uid()
  ));

-- ── Índices de rendimiento ────────────────────────────────────────
create index if not exists idx_daily_plans_user_date    on daily_plans  (user_id, plan_date desc);
create index if not exists idx_annual_plans_user_year   on annual_plans (user_id, year desc);
create index if not exists idx_team_members_athlete     on team_members (athlete_id);
create index if not exists idx_team_members_team        on team_members (team_id);
