create extension if not exists pgcrypto;
create extension if not exists postgis;

create table if not exists fixtures (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  stage text not null,
  kickoff_at timestamptz not null,
  home_code text not null,
  home_team text not null,
  away_code text not null,
  away_team text not null,
  venue text not null,
  host_city text not null,
  highlight text not null,
  created_at timestamptz not null default now()
);

create table if not exists profiles (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid unique,
  email text,
  display_name text not null,
  age integer not null default 29,
  bio text not null default '',
  neighborhood text not null default '',
  city text not null default '',
  vibe text not null check (vibe in ('Loud', 'Chill', 'Family', 'Women-only')),
  favourite_teams text[] not null default '{}'::text[],
  verified boolean not null default false,
  rating numeric(3, 2) not null default 0,
  rating_count integer not null default 0,
  wave_back_rate integer not null default 0,
  host_wins integer not null default 0,
  is_host boolean not null default false,
  women_only boolean not null default false,
  family_friendly boolean not null default false,
  match_day_mode_fixture_id uuid references fixtures(id) on delete set null,
  setup jsonb,
  geog geography(point, 4326),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists profiles_geog_idx on profiles using gist (geog);
create index if not exists profiles_match_day_mode_idx on profiles (match_day_mode_fixture_id);

create table if not exists listings (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  fixture_id uuid not null references fixtures(id) on delete cascade,
  host_id uuid not null references profiles(id) on delete cascade,
  neighborhood text not null,
  vibe text not null check (vibe in ('Loud', 'Chill', 'Family', 'Women-only')),
  max_guests integer not null,
  approved_guests integer not null default 0,
  extras text[] not null default '{}'::text[],
  house_rules text[] not null default '{}'::text[],
  join_message text not null default '',
  price_note text not null default 'Free',
  is_open boolean not null default true,
  geog geography(point, 4326),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists listings_geog_idx on listings using gist (geog);
create index if not exists listings_fixture_idx on listings (fixture_id);

create or replace function set_updated_at_timestamp()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_updated_at on profiles;
create trigger profiles_updated_at
before update on profiles
for each row execute procedure set_updated_at_timestamp();

drop trigger if exists listings_updated_at on listings;
create trigger listings_updated_at
before update on listings
for each row execute procedure set_updated_at_timestamp();
