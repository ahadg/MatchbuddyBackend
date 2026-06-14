create table if not exists blocked_profiles (
  id uuid primary key default gen_random_uuid(),
  blocker_profile_id uuid not null references profiles(id) on delete cascade,
  blocked_profile_id uuid not null references profiles(id) on delete cascade,
  reason text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint blocked_profiles_unique unique (blocker_profile_id, blocked_profile_id),
  constraint blocked_profiles_not_self check (blocker_profile_id <> blocked_profile_id)
);

create index if not exists blocked_profiles_blocker_idx
  on blocked_profiles (blocker_profile_id, created_at desc);

create index if not exists blocked_profiles_blocked_idx
  on blocked_profiles (blocked_profile_id, created_at desc);

drop trigger if exists blocked_profiles_updated_at on blocked_profiles;
create trigger blocked_profiles_updated_at
before update on blocked_profiles
for each row execute procedure set_updated_at_timestamp();

create table if not exists safety_reports (
  id uuid primary key default gen_random_uuid(),
  reporter_profile_id uuid not null references profiles(id) on delete cascade,
  target_profile_id uuid references profiles(id) on delete set null,
  target_listing_id uuid references listings(id) on delete set null,
  target_direct_message_id uuid references direct_messages(id) on delete set null,
  target_listing_message_id uuid references listing_messages(id) on delete set null,
  category text not null check (
    category in ('harassment', 'spam', 'hate', 'sexual', 'violence', 'scam', 'unsafe', 'other')
  ),
  details text not null default '',
  status text not null default 'open' check (status in ('open', 'reviewed', 'resolved', 'dismissed')),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  constraint safety_reports_target_required check (
    (case when target_profile_id is not null then 1 else 0 end) +
    (case when target_listing_id is not null then 1 else 0 end) +
    (case when target_direct_message_id is not null then 1 else 0 end) +
    (case when target_listing_message_id is not null then 1 else 0 end) >= 1
  )
);

create index if not exists safety_reports_reporter_idx
  on safety_reports (reporter_profile_id, created_at desc);

create index if not exists safety_reports_status_idx
  on safety_reports (status, created_at desc);
