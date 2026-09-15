-- ============================================================
--  2137 Rent Book — database schema (Supabase / Postgres)
--  Run this in the Supabase SQL editor on a fresh project.
--  Creates tables, computed totals, a status view, and
--  row-level security so only signed-in members can read/write.
-- ============================================================

-- ---------- extensions ----------
create extension if not exists "pgcrypto";      -- for gen_random_uuid()

-- ============================================================
--  MEMBERS  (the allow-list: who is allowed into this rent book)
--  You add a row here for each person after they sign up.
--  Two rows to start: you (owner) and your bookkeeper.
-- ============================================================
create table if not exists members (
  user_id  uuid primary key references auth.users(id) on delete cascade,
  email    text,
  role     text not null default 'staff' check (role in ('owner','staff')),
  added_at timestamptz not null default now()
);

-- Helper: is the current signed-in user a member?
create or replace function is_member() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from members where user_id = auth.uid());
$$;

-- ============================================================
--  TENANTS
-- ============================================================
create table if not exists tenants (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  unit          text not null,
  beds          text default '2BR',
  lease_rent    numeric(10,2) not null default 0,
  deposit       numeric(10,2) default 0,
  lease_start   date,
  lease_end     date,
  program       text default 'Section 8',
  govt_default  numeric(10,2) default 0,     -- usual govt share
  portion_default numeric(10,2) default 0,   -- usual tenant share
  phone         text,
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);

-- ============================================================
--  PARKING SPOTS
-- ============================================================
create table if not exists parking_spots (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  spot         text not null,
  amount       numeric(10,2) not null default 0,
  method       text default 'Zelle',
  plate        text,          -- vehicle license plate
  make         text,
  model        text,
  vehicle_year int,
  active       boolean not null default true, -- false once they stop parking with us
  archived_at  timestamptz                    -- when the spot was deactivated
);

-- ============================================================
--  PAYMENTS  (one row per tenant per month)
--  total is computed automatically. Confirmed / variance are
--  derived in the payment_status view below (they need lease_rent).
-- ============================================================
create table if not exists payments (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  month        text not null,                       -- 'YYYY-MM'
  govt         numeric(10,2) not null default 0,
  portion      numeric(10,2) not null default 0,
  assistance   numeric(10,2) not null default 0,
  extra        numeric(10,2) not null default 0,   -- extra / other payment collected
  check_num    text,
  bank_confirm boolean not null default false,
  notes        text,
  total        numeric(10,2) generated always as (govt + portion + assistance + extra) stored,
  updated_at   timestamptz not null default now(),
  updated_by   uuid references auth.users(id),
  unique (tenant_id, month)
);
create index if not exists payments_month_idx on payments(month);

-- ============================================================
--  PARKING PAYMENTS  (one row per spot per month)
-- ============================================================
create table if not exists parking_payments (
  id        uuid primary key default gen_random_uuid(),
  spot_id   uuid not null references parking_spots(id) on delete cascade,
  month     text not null,
  paid      boolean not null default false,
  amount    numeric(10,2) not null default 0,   -- dollars actually received (reconciled)
  notes     text,                                -- free-text note for this spot's month
  updated_at timestamptz not null default now(),
  unique (spot_id, month)
);

-- ============================================================
--  RENT TERMS  (effective-dated govt/tenant split per tenant)
--  Each dated term sets the expected split from that date forward;
--  the arrears ledger uses the earliest term as the tenant's start,
--  so a tenant contributes no history before their lease begins.
-- ============================================================
create table if not exists rent_terms (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  effective_from  date not null,
  lease_rent      numeric(10,2) not null default 0,
  govt_expected   numeric(10,2) not null default 0,
  tenant_expected numeric(10,2) not null default 0,
  note            text,
  created_at      timestamptz not null default now()
);
create index if not exists rent_terms_tenant_idx on rent_terms(tenant_id, effective_from);

-- ============================================================
--  EXPENSES  (building- or unit-level spend)
-- ============================================================
create table if not exists expenses (
  id         uuid primary key default gen_random_uuid(),
  spent_on   date not null,
  amount     numeric(10,2) not null default 0,
  category   text,
  vendor     text,
  unit       text,
  note       text,
  created_at timestamptz not null default now()
);
create index if not exists expenses_spent_on_idx on expenses(spent_on);

-- ============================================================
--  NOTES / LOG  (shared building + per-tenant notes)
--  tenant_id null = building-wide log entry.
-- ============================================================
create table if not exists notes (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid references tenants(id) on delete cascade,
  body         text not null,
  author_email text,
  created_at   timestamptz not null default now()
);
create index if not exists notes_tenant_idx on notes(tenant_id);

-- ============================================================
--  VIEW: payment_status
--  Joins payments to their tenant and computes the same logic
--  your spreadsheet did: variance and paid/partial/owed status.
-- ============================================================
create or replace view payment_status as
select
  p.id, p.tenant_id, t.name, t.unit, t.program, p.month,
  p.govt, p.portion, p.assistance, p.extra, p.total,
  t.lease_rent,
  (p.total - t.lease_rent)                         as variance,
  p.check_num, p.bank_confirm, p.notes,
  case
    when p.total <= 0.001                    then 'owed'
    when p.total - t.lease_rent >= -0.5      then 'paid'
    else 'partial'
  end as status
from payments p
join tenants t on t.id = p.tenant_id;

-- ============================================================
--  Keep updated_at / updated_by fresh on every write
-- ============================================================
create or replace function touch_payment() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end $$;
drop trigger if exists trg_touch_payment on payments;
create trigger trg_touch_payment before insert or update on payments
  for each row execute function touch_payment();

-- ============================================================
--  AUTO-MARK "IN RENT" PARKING
--  When a tenant's rent is fully paid for a month, their parking spots whose
--  method is 'In rent' are auto-marked paid for that month (and un-marked if
--  the rent later drops below full) — no manual entry needed.
-- ============================================================
create or replace function sync_in_rent_parking() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_rent numeric;
  v_paid boolean;
begin
  select lease_rent into v_rent from tenants where id = new.tenant_id;
  v_paid := (new.total > 0.001) and (new.total - coalesce(v_rent, 0) >= -0.5);
  insert into parking_payments (spot_id, month, paid, amount)
  select s.id, new.month, v_paid, case when v_paid then s.amount else 0 end
  from parking_spots s
  where s.tenant_id = new.tenant_id and s.method = 'In rent'
  on conflict (spot_id, month) do update set paid = excluded.paid, amount = excluded.amount;
  return new;
end $$;
drop trigger if exists trg_sync_in_rent on payments;
create trigger trg_sync_in_rent after insert or update on payments
  for each row execute function sync_in_rent_parking();

-- ============================================================
--  ROW-LEVEL SECURITY
--  Nobody touches anything unless they are in the members table.
-- ============================================================
alter table members          enable row level security;
alter table tenants          enable row level security;
alter table parking_spots    enable row level security;
alter table payments         enable row level security;
alter table parking_payments enable row level security;
alter table rent_terms       enable row level security;
alter table expenses         enable row level security;
alter table notes            enable row level security;

-- members: a signed-in user may see ONLY their own membership row (so the
-- app's single-row membership check works with any number of members);
-- only an owner may add / change / remove members.
create policy members_self_read on members
  for select using (user_id = auth.uid());
create policy members_owner_insert on members
  for insert with check (exists (select 1 from members m where m.user_id = auth.uid() and m.role = 'owner'));
create policy members_owner_update on members
  for update using (exists (select 1 from members m where m.user_id = auth.uid() and m.role = 'owner'))
             with check (exists (select 1 from members m where m.user_id = auth.uid() and m.role = 'owner'));
create policy members_owner_delete on members
  for delete using (exists (select 1 from members m where m.user_id = auth.uid() and m.role = 'owner'));

-- all data tables: full read/write for any member.
create policy tenants_rw on tenants
  for all using (is_member()) with check (is_member());
create policy parking_rw on parking_spots
  for all using (is_member()) with check (is_member());
create policy payments_rw on payments
  for all using (is_member()) with check (is_member());
create policy parking_pay_rw on parking_payments
  for all using (is_member()) with check (is_member());
create policy rent_terms_rw on rent_terms
  for all using (is_member()) with check (is_member());
create policy expenses_rw on expenses
  for all using (is_member()) with check (is_member());
create policy notes_rw on notes
  for all using (is_member()) with check (is_member());

-- ============================================================
--  REALTIME  (live sync)
--  Add the data tables to Supabase's realtime publication so the
--  app receives insert/update/delete events over the websocket and
--  every signed-in device stays in sync without a refresh. RLS still
--  applies to the stream, so non-members receive nothing.
--  Idempotent and safe if some tables (rent_terms/expenses/notes)
--  live in a separate migration.
-- ============================================================
do $$
declare tbl text;
begin
  foreach tbl in array array[
    'tenants','parking_spots','payments','parking_payments','rent_terms','expenses','notes','properties','audit_log'
  ] loop
    if to_regclass('public.' || tbl) is not null
       and not exists (
         select 1 from pg_publication_tables
         where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = tbl
       ) then
      execute format('alter publication supabase_realtime add table public.%I', tbl);
    end if;
  end loop;
end $$;

-- ============================================================
--  PHASE 1 FOUNDATION  (additive; safe to re-run)
--  Properties + scoping · parking-on-tenant · richer tenant
--  fields · audit_log (change log by user) with triggers.
-- ============================================================

-- ---------- PROPERTIES ----------
create table if not exists properties (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  code       text,
  address    text,
  created_at timestamptz not null default now()
);
alter table properties enable row level security;
drop policy if exists properties_rw on properties;
create policy properties_rw on properties for all using (is_member()) with check (is_member());

-- one property to start (the 2137 building)
insert into properties (name, code, address)
select '2137 Building', '2137', null
where not exists (select 1 from properties);

-- scope entities to a property
alter table tenants       add column if not exists property_id uuid references properties(id) on delete restrict;
alter table parking_spots add column if not exists property_id uuid references properties(id) on delete restrict;
alter table expenses      add column if not exists property_id uuid references properties(id) on delete restrict;
alter table notes         add column if not exists property_id uuid references properties(id) on delete restrict;
create index if not exists tenants_property_idx       on tenants(property_id);
create index if not exists parking_spots_property_idx on parking_spots(property_id);

-- ---------- PARKING belongs to a tenant (nullable → parking-only renters allowed) ----------
alter table parking_spots add column if not exists tenant_id uuid references tenants(id) on delete set null;
create index if not exists parking_spots_tenant_idx on parking_spots(tenant_id);

-- ---------- Richer tenant fields ----------
alter table tenants add column if not exists email              text;
alter table tenants add column if not exists alt_phone          text;
alter table tenants add column if not exists emergency_name     text;
alter table tenants add column if not exists emergency_phone    text;
alter table tenants add column if not exists household_size     int;
alter table tenants add column if not exists move_in_date       date;
alter table tenants add column if not exists mailing_address    text;
alter table tenants add column if not exists voucher_number     text;
alter table tenants add column if not exists pha_name           text;
alter table tenants add column if not exists pha_contact        text;
alter table tenants add column if not exists hap_contract_start date;
alter table tenants add column if not exists hap_contract_end   date;
alter table tenants add column if not exists recert_due         date;
alter table tenants add column if not exists archived_at        timestamptz;

-- backfill scoping to the first property (no-ops on a fresh, empty DB)
update tenants       set property_id = (select id from properties order by created_at limit 1) where property_id is null;
update parking_spots set property_id = (select id from properties order by created_at limit 1) where property_id is null;
update expenses      set property_id = (select id from properties order by created_at limit 1) where property_id is null;
update notes         set property_id = (select id from properties order by created_at limit 1) where property_id is null;

-- ============================================================
--  AUDIT LOG  (the change log by user)
--  Append-only. Written only by the SECURITY DEFINER trigger.
--  Members may read; nobody may edit or delete.
-- ============================================================
create table if not exists audit_log (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  actor_id    uuid,
  actor_email text,
  action      text not null,            -- INSERT | UPDATE | DELETE
  table_name  text not null,
  row_id      uuid,
  property_id uuid,
  old_data    jsonb,
  new_data    jsonb
);
create index if not exists audit_log_at_idx   on audit_log(at desc);
create index if not exists audit_log_row_idx  on audit_log(table_name, row_id);
create index if not exists audit_log_prop_idx on audit_log(property_id, at desc);

alter table audit_log enable row level security;
drop policy if exists audit_read on audit_log;
create policy audit_read on audit_log for select using (is_member());
-- (no write policies — clients can never insert/update/delete audit rows)

create or replace function audit_capture() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_old jsonb := case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) else null end;
  v_new jsonb := case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) else null end;
  v_email text := coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email',
    (select email from members where user_id = auth.uid())
  );
begin
  insert into audit_log(actor_id, actor_email, action, table_name, row_id, property_id, old_data, new_data)
  values (
    auth.uid(), v_email, tg_op, tg_table_name,
    coalesce((v_new->>'id')::uuid, (v_old->>'id')::uuid),
    coalesce((v_new->>'property_id')::uuid, (v_old->>'property_id')::uuid),
    v_old, v_new
  );
  return coalesce(new, old);
end $$;

do $$
declare t text;
begin
  foreach t in array array['tenants','payments','parking_spots','parking_payments','rent_terms','expenses','notes','properties'] loop
    execute format('drop trigger if exists trg_audit on public.%I', t);
    execute format('create trigger trg_audit after insert or update or delete on public.%I for each row execute function audit_capture()', t);
  end loop;
end $$;

-- Done. Next: run seed.sql to load the 2137 roster.
