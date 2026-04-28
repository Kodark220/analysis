create table if not exists public.sent_alerts (
    id text primary key,
    project_name text not null default '',
    keyword text not null default '',
    source text not null default '',
    alert_url text not null default '',
    channel_mode text not null default 'alerts',
    delivered_at timestamptz not null default now()
);

create index if not exists sent_alerts_delivered_at_idx
    on public.sent_alerts (delivered_at desc);