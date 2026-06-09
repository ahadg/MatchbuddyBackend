create table if not exists waves (
  id uuid primary key default gen_random_uuid(),
  sender_profile_id uuid not null references profiles(id) on delete cascade,
  receiver_profile_id uuid not null references profiles(id) on delete cascade,
  fixture_id uuid references fixtures(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint waves_sender_receiver_unique unique (sender_profile_id, receiver_profile_id),
  constraint waves_not_self check (sender_profile_id <> receiver_profile_id)
);

create index if not exists waves_receiver_idx on waves (receiver_profile_id, created_at desc);
create index if not exists waves_sender_idx on waves (sender_profile_id, created_at desc);

create table if not exists direct_threads (
  id uuid primary key default gen_random_uuid(),
  profile_low_id uuid not null references profiles(id) on delete cascade,
  profile_high_id uuid not null references profiles(id) on delete cascade,
  fixture_id uuid references fixtures(id) on delete set null,
  unlocked_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint direct_threads_pair_unique unique (profile_low_id, profile_high_id),
  constraint direct_threads_not_self check (profile_low_id <> profile_high_id)
);

create index if not exists direct_threads_profile_low_idx on direct_threads (profile_low_id);
create index if not exists direct_threads_profile_high_idx on direct_threads (profile_high_id);

create table if not exists direct_messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references direct_threads(id) on delete cascade,
  sender_profile_id uuid not null references profiles(id) on delete cascade,
  body text not null,
  created_at timestamptz not null default now(),
  constraint direct_messages_body_not_blank check (char_length(trim(body)) > 0)
);

create index if not exists direct_messages_thread_idx on direct_messages (thread_id, created_at asc);

create table if not exists listing_join_requests (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null references listings(id) on delete cascade,
  guest_profile_id uuid not null references profiles(id) on delete cascade,
  message text not null default '',
  status text not null check (status in ('pending', 'approved', 'declined', 'cancelled')),
  responded_by_profile_id uuid references profiles(id) on delete set null,
  responded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint listing_join_requests_unique unique (listing_id, guest_profile_id)
);

create index if not exists listing_join_requests_listing_idx on listing_join_requests (listing_id, status);
create index if not exists listing_join_requests_guest_idx on listing_join_requests (guest_profile_id, status);

create table if not exists listing_messages (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null references listings(id) on delete cascade,
  sender_profile_id uuid not null references profiles(id) on delete cascade,
  body text not null,
  created_at timestamptz not null default now(),
  constraint listing_messages_body_not_blank check (char_length(trim(body)) > 0)
);

create index if not exists listing_messages_listing_idx on listing_messages (listing_id, created_at asc);

drop trigger if exists direct_threads_updated_at on direct_threads;
create trigger direct_threads_updated_at
before update on direct_threads
for each row execute procedure set_updated_at_timestamp();

drop trigger if exists listing_join_requests_updated_at on listing_join_requests;
create trigger listing_join_requests_updated_at
before update on listing_join_requests
for each row execute procedure set_updated_at_timestamp();
