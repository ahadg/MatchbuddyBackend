create table if not exists fan_ratings (
  id uuid primary key default gen_random_uuid(),
  rater_profile_id uuid not null references profiles(id) on delete cascade,
  target_profile_id uuid not null references profiles(id) on delete cascade,
  score integer not null check (score between 1 and 5),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint fan_ratings_unique unique (rater_profile_id, target_profile_id),
  constraint fan_ratings_not_self check (rater_profile_id <> target_profile_id)
);

create index if not exists fan_ratings_target_idx on fan_ratings (target_profile_id);
create index if not exists fan_ratings_rater_idx on fan_ratings (rater_profile_id);

drop trigger if exists fan_ratings_updated_at on fan_ratings;
create trigger fan_ratings_updated_at
before update on fan_ratings
for each row execute procedure set_updated_at_timestamp();
