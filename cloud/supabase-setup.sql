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
  kind       text not null check (kind in ('products', 'sales', 'movements', 'cashups', 'kv')),
  id         text not null,
  data       jsonb,
  deleted    boolean not null default false,
  device     text,
  seq        bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key (shop_id, kind, id)
);
create index if not exists records_shop_seq on public.records (shop_id, seq);

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
revoke execute on function public.claim_device(uuid), public.reset_shop(uuid) from anon;
