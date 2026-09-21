-- A message board for the day: announcements and the day's notes, gone after 24h.
--
-- Everyone in a company can post; a company admin can also mark a post as an
-- announcement, which is pinned to the top and tells everyone in the company.
-- A message lives for one day. That limit is enforced here, in the read policy,
-- rather than by the screen hiding old rows: a message past its day cannot be
-- read by anyone, from any client, and is swept away on the next post.
--
-- Re-runnable; applied by hand in Studio.

create table if not exists public.company_messages (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  author_id uuid not null references auth.users(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 1000),
  is_announcement boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists company_messages_company_created_idx
  on public.company_messages (company_id, created_at desc);

alter table public.company_messages enable row level security;
-- No UPDATE: a posted message is what was said. Delete and post again.
grant select, insert, delete on public.company_messages to authenticated;
grant all on public.company_messages to service_role;

-- --------------------------------------------------------------------- policies
drop policy if exists company_messages_read on public.company_messages;
create policy company_messages_read on public.company_messages
  for select to authenticated
  using (
    company_id = public.current_company_id()
    and created_at > now() - interval '24 hours'
  );

drop policy if exists company_messages_post on public.company_messages;
create policy company_messages_post on public.company_messages
  for insert to authenticated
  with check (
    author_id = auth.uid()
    and company_id = public.current_company_id()
    -- Only an admin can make one everybody gets told about.
    and (not is_announcement or public.has_role(auth.uid(), 'company_admin'::app_role, company_id))
  );

-- Your own, or anyone's if you run the company.
drop policy if exists company_messages_remove on public.company_messages;
create policy company_messages_remove on public.company_messages
  for delete to authenticated
  using (
    author_id = auth.uid()
    or public.has_role(auth.uid(), 'company_admin'::app_role, company_id)
  );

-- ---------------------------------------------------------------------- stamps
-- The clock is the server's. A client that sent its own `created_at` could date
-- a message into next week and keep it on the board for eight days.
create or replace function public.company_messages_stamp()
returns trigger language plpgsql set search_path = public
as $$
begin
  new.created_at := now();
  new.body := btrim(new.body);
  return new;
end;
$$;

drop trigger if exists trg_company_messages_stamp on public.company_messages;
create trigger trg_company_messages_stamp
before insert on public.company_messages
for each row execute function public.company_messages_stamp();

-- ------------------------------------------------------- sweep, and announce
-- Definer, because it removes other people's expired posts and writes
-- notifications, neither of which the poster may do themselves.
create or replace function public.company_messages_after_post()
returns trigger language plpgsql security definer set search_path = public
as $$
declare
  who text;
begin
  -- Housekeeping on the way past: nobody can read these any more anyway.
  delete from public.company_messages
   where company_id = new.company_id
     and created_at < now() - interval '24 hours';

  if new.is_announcement then
    select nullif(p.full_name, '') into who from public.profiles p where p.id = new.author_id;

    insert into public.notifications (user_id, type, title, body, link)
    select p.id,
           'announcement',
           'Announcement from ' || coalesce(who, 'your admin'),
           left(new.body, 140) || case when char_length(new.body) > 140 then '…' else '' end,
           '/messages'
      from public.profiles p
     where p.company_id = new.company_id
       and p.id <> new.author_id
       and public.wants_notification(p.id, 'announcement');
  end if;

  return null;
end;
$$;
revoke all on function public.company_messages_after_post() from public, anon, authenticated;

drop trigger if exists trg_company_messages_after_post on public.company_messages;
create trigger trg_company_messages_after_post
after insert on public.company_messages
for each row execute function public.company_messages_after_post();

-- ---------------------------------------------------------------------- live
-- New posts appear on everyone's board without a refresh. Realtime applies the
-- read policy above per subscriber, so nobody is sent another company's post.
do $$
begin
  perform 1 from pg_publication_tables
   where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'company_messages';
  if not found then
    execute 'alter publication supabase_realtime add table public.company_messages';
  end if;
end $$;
