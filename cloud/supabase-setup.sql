-- =========================================================================
-- Rails POS — cloud database setup for Supabase
--
-- How to use: Supabase dashboard → SQL Editor → New query → paste ALL of
-- this → Run. It is safe to run again (it only adds what is missing).
--
-- Model
--   shops    one row per shop. The shop's login (Supabase Auth user) owns it.
--   records  every product, sale, stock movement, cash-up and shared setting
--            of the shop, one row each, stored as JSON exactly as the app
--            keeps it on the device. "seq" increases on every change, so a
--            device asks "everything after seq N" to catch up.
--
-- Security: row-level security means a login can only ever read or change
-- rows of the shop it owns — the public "anon" key in the app can't see
-- anything without signing in.
-- =========================================================================

create table if not exists public.shops (
  id           uuid primary key default gen_random_uuid(),
  owner        uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name         text not null default 'My shop',
  generation   int  not null default 1,   -- bumped by "Start fresh" / "Restore": devices re-download
  next_device  int  not null default 1,   -- next till letter: 1 = A, 2 = B …
  active_until date,                      -- subscription paid until (null = no end date)
  created_at   timestamptz not null default now()
);

-- Licences: a new shop gets a 30-day free trial. Only YOU (in the Supabase
-- dashboard / SQL editor) can change active_until — shops cannot.
alter table public.shops alter column active_until set default (current_date + 30);
create unique index if not exists shops_one_per_owner on public.shops (owner); -- one shop per login

create sequence if not exists public.records_seq;

create table if not exists public.records (
  shop_id    uuid not null references public.shops(id) on delete cascade,
  kind       text not null,
  id         text not null,
  data       jsonb,
  deleted    boolean not null default false,
  device     text,
  seq        bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key (shop_id, kind, id)
);
create index if not exists records_shop_seq on public.records (shop_id, seq);

-- Record types the app may store (v2 adds clients and lay-bys). Safe to run again.
alter table public.records drop constraint if exists records_kind_check;
alter table public.records add constraint records_kind_check
  check (kind in ('products', 'sales', 'movements', 'cashups', 'kv', 'customers', 'laybys'));

-- Every insert / update gets the next seq number and a fresh timestamp.
create or replace function public.records_stamp() returns trigger
language plpgsql as $$
begin
  new.seq := nextval('public.records_seq');
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists records_stamp on public.records;
create trigger records_stamp before insert or update on public.records
  for each row execute function public.records_stamp();

-- Row-level security: a login only sees its own shop.
alter table public.shops   enable row level security;
alter table public.records enable row level security;

drop policy if exists "own shop" on public.shops;
create policy "own shop" on public.shops for all to authenticated
  using (owner = auth.uid()) with check (owner = auth.uid());

drop policy if exists "own records" on public.records;
create policy "own records" on public.records for all to authenticated
  using (exists (select 1 from public.shops s where s.id = shop_id and s.owner = auth.uid()))
  with check (exists (select 1 from public.shops s where s.id = shop_id and s.owner = auth.uid()));

grant usage on sequence public.records_seq to authenticated;
revoke all on public.shops, public.records from anon;
grant select, insert, update, delete on public.records to authenticated;
-- Shops may only set their name when creating, and change only name / generation / till counter.
-- They can never set or change active_until, and can't delete the shop (no "free new trial").
revoke all on public.shops from authenticated;
grant select on public.shops to authenticated;
grant insert (name) on public.shops to authenticated;
grant update (name, generation, next_device) on public.shops to authenticated;

-- =========================================================================
-- MANAGING SUBSCRIPTIONS (run these yourself in the SQL editor)
--
--   See every shop, its login email and when it is paid until:
--     select s.name, u.email, s.active_until, s.created_at
--     from public.shops s join auth.users u on u.id = s.owner order by s.created_at;
--
--   A shop paid for another month (from today, or from its current end date):
--     update public.shops set active_until = greatest(coalesce(active_until, current_date), current_date) + interval '1 month'
--     where owner = (select id from auth.users where email = 'shop@example.com');
--
--   No end date (e.g. your own shop):
--     update public.shops set active_until = null where owner = (select id from auth.users where email = '...');
-- =========================================================================

-- A device joining the shop gets the next till letter for its receipt numbers.
create or replace function public.claim_device(p_shop uuid) returns int
language sql as $$
  update public.shops set next_device = next_device + 1
  where id = p_shop and owner = auth.uid()
  returning next_device - 1;
$$;

-- "Start fresh" / "Restore backup" on one device: empty the cloud copy and
-- bump the generation so every other device downloads the new data.
create or replace function public.reset_shop(p_shop uuid) returns int
language plpgsql as $$
declare g int;
begin
  update public.shops set generation = generation + 1
  where id = p_shop and owner = auth.uid()
  returning generation into g;
  if g is null then raise exception 'Not your shop'; end if;
  delete from public.records where shop_id = p_shop;
  return g;
end $$;

grant execute on function public.claim_device(uuid), public.reset_shop(uuid) to authenticated;
revoke execute on function public.claim_device(uuid), public.reset_shop(uuid) from public, anon;

-- =========================================================================
-- SUPPLIER ADMIN (admin.html) — only for the Rails POS supplier.
--
-- Security:
--   • Only logins listed in vendor_admins are admins. You add them yourself:
--       insert into public.vendor_admins (user_id)
--       select id from auth.users where email = 'your-admin@email';
--   • Sign-in is email + password only (no authenticator app), so use a long
--     password (12+ characters) that isn't used anywhere else.
--   • The admin tables can't be read or written through the API at all; the
--     functions below are the only way in, and every change is logged.
-- =========================================================================

alter table public.shops add column if not exists plan text not null default 'trial'; -- trial | paid
-- Deactivated by the supplier: selling pauses on all the shop's devices (data kept). Shops can't change it.
alter table public.shops add column if not exists deactivated boolean not null default false;
alter table public.shops add column if not exists deactivated_reason text;

-- Subscription payments recorded by the supplier (can be backdated).
create table if not exists public.vendor_payments (
  id           bigserial primary key,
  shop_id      uuid references public.shops(id) on delete cascade,
  paid_on      date not null,
  amount_cents int  not null default 0,
  months       int  not null,
  method       text,
  note         text,
  admin_id     uuid,
  created_at   timestamptz not null default now()
);
alter table public.vendor_payments enable row level security;
revoke all on public.vendor_payments from anon, authenticated;
-- v22: the supplier picks the paid-until date for each payment
alter table public.vendor_payments add column if not exists paid_until date;
alter table public.vendor_payments alter column months drop not null;

create table if not exists public.vendor_admins (
  user_id  uuid primary key references auth.users(id) on delete cascade,
  added_at timestamptz not null default now()
);
create table if not exists public.vendor_audit (
  id        bigserial primary key,
  at        timestamptz not null default now(),
  admin_id  uuid,
  shop_id   uuid,
  action    text,
  old_until date,
  new_until date
);
alter table public.vendor_admins enable row level security; -- no policies: invisible to the API
alter table public.vendor_audit  enable row level security;
revoke all on public.vendor_admins, public.vendor_audit from anon, authenticated;

-- Stops unless the caller is a listed admin.
create or replace function public.vendor_check() returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or not exists (select 1 from public.vendor_admins where user_id = auth.uid()) then
    raise exception 'Not authorised';
  end if;
end $$;

create or replace function public.vendor_whoami() returns json
language plpgsql security definer set search_path = public as $$
begin
  return json_build_object(
    'admin', exists (select 1 from public.vendor_admins where user_id = auth.uid()),
    'aal', coalesce(auth.jwt() ->> 'aal', ''));
end $$;

drop function if exists public.vendor_list_shops(); -- its columns changed in v21
create or replace function public.vendor_list_shops()
returns table (shop_id uuid, shop_name text, email text, plan text, active_until date,
               created_at timestamptz, last_seen timestamptz, tills int, records bigint,
               deactivated boolean, deactivated_reason text,
               paid_total bigint, paid_this_month bigint, last_payment date)
language plpgsql security definer set search_path = public as $$
begin
  perform public.vendor_check();
  return query
    select s.id, s.name, u.email::text, s.plan, s.active_until, s.created_at,
           (select max(r.updated_at) from public.records r where r.shop_id = s.id),
           greatest(s.next_device - 1, 0),
           (select count(*) from public.records r where r.shop_id = s.id),
           s.deactivated, s.deactivated_reason,
           (select coalesce(sum(p.amount_cents), 0) from public.vendor_payments p where p.shop_id = s.id)::bigint,
           (select coalesce(sum(p.amount_cents), 0) from public.vendor_payments p
             where p.shop_id = s.id and date_trunc('month', p.paid_on) = date_trunc('month', current_date))::bigint,
           (select max(p.paid_on) from public.vendor_payments p where p.shop_id = s.id)
    from public.shops s join auth.users u on u.id = s.owner
    order by s.created_at;
end $$;

-- Record a subscription payment (may be backdated). The paid-until date runs
-- from the payment date, or from the current end date if that is later.
create or replace function public.vendor_record_payment(p_shop uuid, p_paid_on date, p_months int,
  p_amount_cents int, p_method text default 'EFT', p_note text default '')
returns date
language plpgsql security definer set search_path = public as $$
declare old date; new_date date;
begin
  perform public.vendor_check();
  if p_paid_on is null or p_paid_on > current_date then raise exception 'The payment date can''t be in the future'; end if;
  if p_months is null or p_months < 1 or p_months > 24 then raise exception 'Months must be 1 to 24'; end if;
  if p_amount_cents is null or p_amount_cents < 0 then raise exception 'Enter the amount paid'; end if;
  select active_until into old from public.shops where id = p_shop for update;
  if not found then raise exception 'Shop not found'; end if;
  new_date := (greatest(coalesce(old, p_paid_on), p_paid_on) + make_interval(months => p_months))::date;
  update public.shops set active_until = new_date, plan = 'paid' where id = p_shop;
  insert into public.vendor_payments (shop_id, paid_on, amount_cents, months, method, note, admin_id)
    values (p_shop, p_paid_on, p_amount_cents, p_months, left(coalesce(p_method, ''), 20), left(coalesce(p_note, ''), 200), auth.uid());
  insert into public.vendor_audit (admin_id, shop_id, action, old_until, new_until)
    values (auth.uid(), p_shop, left('Payment R' || to_char(p_amount_cents / 100.0, 'FM999999990.00') || ' on ' || p_paid_on
      || ' (' || p_months || ' mo)', 60), old, new_date);
  return new_date;
end $$;

-- Record a subscription payment with the paid-until date chosen by the supplier.
-- The payment date may be in the past (backdated) but not the future.
create or replace function public.vendor_record_payment_until(p_shop uuid, p_paid_on date, p_until date,
  p_amount_cents int, p_method text default 'EFT', p_note text default '')
returns date
language plpgsql security definer set search_path = public as $$
declare old date;
begin
  perform public.vendor_check();
  if p_paid_on is null or p_paid_on > current_date then raise exception 'The payment date can''t be in the future'; end if;
  if p_until is null or p_until < p_paid_on then raise exception 'Paid until must be on or after the payment date'; end if;
  if p_until > current_date + interval '5 years' then raise exception 'Paid until can''t be more than 5 years ahead'; end if;
  if p_amount_cents is null or p_amount_cents < 0 then raise exception 'Enter the amount paid'; end if;
  select active_until into old from public.shops where id = p_shop for update;
  if not found then raise exception 'Shop not found'; end if;
  update public.shops set active_until = p_until, plan = 'paid' where id = p_shop;
  insert into public.vendor_payments (shop_id, paid_on, paid_until, amount_cents, months, method, note, admin_id)
    values (p_shop, p_paid_on, p_until, p_amount_cents, null, left(coalesce(p_method, ''), 20), left(coalesce(p_note, ''), 200), auth.uid());
  insert into public.vendor_audit (admin_id, shop_id, action, old_until, new_until)
    values (auth.uid(), p_shop, left('Payment R' || to_char(p_amount_cents / 100.0, 'FM999999990.00') || ' on ' || p_paid_on, 60), old, p_until);
  return p_until;
end $$;

drop function if exists public.vendor_shop_payments(uuid); -- its columns changed in v22
create or replace function public.vendor_shop_payments(p_shop uuid)
returns table (paid_on date, paid_until date, amount_cents int, months int, method text, note text, created_at timestamptz)
language plpgsql security definer set search_path = public as $$
begin
  perform public.vendor_check();
  return query select p.paid_on, p.paid_until, p.amount_cents, p.months, p.method, p.note, p.created_at
    from public.vendor_payments p where p.shop_id = p_shop order by p.paid_on desc, p.id desc;
end $$;

-- Deactivate (selling pauses on all the shop's devices; data kept) or reactivate.
create or replace function public.vendor_set_active(p_shop uuid, p_active boolean, p_reason text default '')
returns boolean
language plpgsql security definer set search_path = public as $$
declare cur date;
begin
  perform public.vendor_check();
  select active_until into cur from public.shops where id = p_shop for update;
  if not found then raise exception 'Shop not found'; end if;
  update public.shops set deactivated = not p_active,
    deactivated_reason = case when p_active then null else nullif(left(coalesce(p_reason, ''), 200), '') end
  where id = p_shop;
  insert into public.vendor_audit (admin_id, shop_id, action, old_until, new_until)
    values (auth.uid(), p_shop, left(case when p_active then 'Reactivated' else 'Deactivated' ||
      case when coalesce(p_reason, '') <> '' then ': ' || p_reason else '' end end, 60), cur, cur);
  return p_active;
end $$;

-- Set a shop's paid-until date (null = no end date). Marks the shop as paying.
create or replace function public.vendor_set_until(p_shop uuid, p_until date, p_action text default 'set date')
returns date
language plpgsql security definer set search_path = public as $$
declare old date;
begin
  perform public.vendor_check();
  select active_until into old from public.shops where id = p_shop for update;
  if not found then raise exception 'Shop not found'; end if;
  update public.shops set active_until = p_until, plan = 'paid' where id = p_shop;
  insert into public.vendor_audit (admin_id, shop_id, action, old_until, new_until)
    values (auth.uid(), p_shop, left(coalesce(p_action, 'set date'), 40), old, p_until);
  return p_until;
end $$;

-- Add 1–24 months, counted from today or from the current end date if that is later.
create or replace function public.vendor_add_months(p_shop uuid, p_months int)
returns date
language plpgsql security definer set search_path = public as $$
declare old date; new_date date;
begin
  perform public.vendor_check();
  if p_months is null or p_months < 1 or p_months > 24 then raise exception 'Months must be 1 to 24'; end if;
  select active_until into old from public.shops where id = p_shop for update;
  if not found then raise exception 'Shop not found'; end if;
  new_date := (greatest(coalesce(old, current_date), current_date) + make_interval(months => p_months))::date;
  update public.shops set active_until = new_date, plan = 'paid' where id = p_shop;
  insert into public.vendor_audit (admin_id, shop_id, action, old_until, new_until)
    values (auth.uid(), p_shop, '+' || p_months || ' month' || case when p_months > 1 then 's' else '' end, old, new_date);
  return new_date;
end $$;

create or replace function public.vendor_audit_log(p_limit int default 50)
returns table (at timestamptz, shop_name text, action text, old_until date, new_until date)
language plpgsql security definer set search_path = public as $$
begin
  perform public.vendor_check();
  return query
    select a.at, coalesce(s.name, '(deleted shop)'), a.action, a.old_until, a.new_until
    from public.vendor_audit a left join public.shops s on s.id = a.shop_id
    order by a.at desc limit least(greatest(coalesce(p_limit, 50), 1), 200);
end $$;

revoke execute on function public.vendor_check(), public.vendor_whoami(), public.vendor_list_shops(),
  public.vendor_set_until(uuid, date, text), public.vendor_add_months(uuid, int), public.vendor_audit_log(int),
  public.vendor_record_payment(uuid, date, int, int, text, text), public.vendor_shop_payments(uuid),
  public.vendor_record_payment_until(uuid, date, date, int, text, text),
  public.vendor_set_active(uuid, boolean, text) from public, anon;
grant execute on function public.vendor_whoami(), public.vendor_list_shops(),
  public.vendor_set_until(uuid, date, text), public.vendor_add_months(uuid, int), public.vendor_audit_log(int),
  public.vendor_record_payment(uuid, date, int, int, text, text), public.vendor_shop_payments(uuid),
  public.vendor_record_payment_until(uuid, date, date, int, text, text),
  public.vendor_set_active(uuid, boolean, text) to authenticated;
