-- ============================================================================
-- Esquema Supabase para o LEGION Key System
-- Rode este SQL no Editor SQL do seu projeto Supabase
-- (https://app.supabase.com/project/_/sql)
-- ============================================================================

-- Tabela de keys (substitui db.keys)
create table if not exists keys (
  id uuid default gen_random_uuid() primary key,
  key text unique not null,
  model text not null default 'private',
  duration_days integer not null default 30,
  plan text not null default 'standard',
  note text default '',
  created_by text not null default 'web',
  ip text,
  hwid text,
  created_at timestamptz not null default now(),
  activated_at timestamptz,
  expires_at timestamptz,
  last_check_at timestamptz,
  uses integer not null default 0,
  revoked boolean not null default false
);

create index if not exists keys_key_idx on keys(key);
create index if not exists keys_model_idx on keys(model);
create index if not exists keys_created_at_idx on keys(created_at desc);

-- Tabela de configuracao unica (substitui db.config). id fixo = 1.
create table if not exists config (
  id integer primary key default 1 check (id = 1),
  brand text default 'LEGION',
  public_url text default '',
  api_base text default '',
  models jsonb not null default '{"private":{"enabled":true},"headtrick":{"enabled":true},"internal":{"enabled":true}}'::jsonb,
  cooldown_seconds integer default 120,
  daily_limit integer default 5,
  default_duration_days integer default 30,
  maintenance boolean default false,
  admin_password text,
  created_at timestamptz not null default now()
);

insert into config (id) values (1)
on conflict (id) do nothing;

-- Tabela de logs (substitui db.logs, mantidos ultimos 1.000)
create table if not exists logs (
  id text primary key,
  ts timestamptz not null default now(),
  type text not null,
  ip text default '',
  key text,
  detail text default ''
);

create index if not exists logs_ts_idx on logs(ts desc);

-- Tabela de metricas por dia (substitui db.metrics.byDay, mantidos 90 dias)
create table if not exists metrics (
  day_key text primary key,
  generated integer not null default 0,
  validations integer not null default 0
);

-- (Opcional) Segurança: se quiser expor o frontend diretamente ao Supabase,
-- habilite RLS nessas tabelas. Como este servidor eh o unico cliente e usa
-- a service role key, RLS nao e estritamente necessario.
