create table if not exists app_notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_profile_id uuid not null references profiles(id) on delete cascade,
  actor_profile_id uuid references profiles(id) on delete set null,
  type text not null,
  title text not null,
  body text not null,
  thread_id uuid references direct_threads(id) on delete set null,
  listing_id uuid references listings(id) on delete set null,
  fan_id uuid references profiles(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists app_notifications_recipient_created_idx
  on app_notifications (recipient_profile_id, created_at desc);

create index if not exists app_notifications_recipient_unread_idx
  on app_notifications (recipient_profile_id, read_at, created_at desc);
