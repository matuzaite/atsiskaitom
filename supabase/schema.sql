-- Atsiskaitom schema. Run this once in the Supabase SQL editor.
--
-- The server talks to Supabase with the service-role key, so Row Level Security
-- is bypassed; RLS is left enabled with no policies (no direct client access).

create table if not exists groups (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  created_at timestamptz not null default now()
);

create table if not exists members (
  id       uuid primary key default gen_random_uuid(),
  group_id uuid not null references groups(id) on delete cascade,
  name     text not null
);

create table if not exists expenses (
  id         uuid primary key default gen_random_uuid(),
  group_id   uuid not null references groups(id) on delete cascade,
  paid_by    uuid not null,
  amount     integer not null,           -- integer cents
  currency   text not null default 'EUR',
  date       text not null,              -- YYYY-MM-DD
  category   text not null default 'other',
  split_type text not null default 'equal',
  splits     jsonb not null default '[]'::jsonb, -- [{ memberId, amount }]
  created_at timestamptz not null default now()
);

create table if not exists settlements (
  id             uuid primary key default gen_random_uuid(),
  group_id       uuid not null references groups(id) on delete cascade,
  from_member_id uuid not null,
  to_member_id   uuid not null,
  amount         integer not null,       -- integer cents
  currency       text not null default 'EUR',
  date           text not null,
  status         text not null default 'paid',
  created_at     timestamptz not null default now()
);

create index if not exists idx_members_group on members(group_id);
create index if not exists idx_expenses_group on expenses(group_id);
create index if not exists idx_settlements_group on settlements(group_id);

alter table groups      enable row level security;
alter table members     enable row level security;
alter table expenses    enable row level security;
alter table settlements enable row level security;
