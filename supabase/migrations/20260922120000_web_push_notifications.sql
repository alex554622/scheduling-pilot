-- Notifications that arrive when the app is shut.
--
-- Everything before this was a pop-up drawn by a page that happened to be
-- open: the bell's realtime subscription, the break reminder's `setTimeout`,
-- the toast on a new board message. Close the tab — or lock the phone, which
-- is the same thing to an installed app — and none of it happens. "Your break
-- is nearly up" is precisely the notification nobody is watching a screen for.
--
-- So the browser is no longer the one deciding when to speak. Three pieces:
--
--   * `push_subscriptions` — one row per device that has said yes. Written by
--     the browser itself under RLS; the endpoint it holds is where a push
--     service accepts deliveries for that device.
--   * `push_queue` — an outbox. Rows are written by triggers, never by a
--     client, and carry a `due_at`: now for something that has just happened,
--     the end of the break for something that has not happened yet.
--   * `claim_due_pushes` / `mark_push_sent` — what the app server's dispatcher
--     calls. It runs inside the Node container that already serves the app, so
--     there is no new box, no cron and no edge function to keep alive.
--
-- The queue is why a break reminder survives a closed app: the moment the
-- break starts, the punch already says when it ends, and a row is filed for
-- that minute. Whether anyone is looking by then is not its problem.
--
-- Re-runnable; applied by hand in Studio.

-- ------------------------------------------------------------- subscriptions
create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  -- The push service's delivery URL. Unique because it *is* the device: the
  -- same browser re-subscribing hands back the same endpoint, and a second row
  -- for it would mean every notification arriving twice.
  endpoint text not null unique,
  -- The device's own key material, used to encrypt each payload so the push
  -- service relays something it cannot read.
  p256dh text not null,
  auth text not null,
  -- Only so a person can tell their phone from their laptop in a support
  -- conversation. Never matched on.
  user_agent text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create index if not exists push_subscriptions_user_idx
  on public.push_subscriptions (user_id);

alter table public.push_subscriptions enable row level security;
grant select, insert, update, delete on public.push_subscriptions to authenticated;
grant all on public.push_subscriptions to service_role;

-- Your own devices, and nobody else's. A browser writes its own row here
-- directly — there is nothing in it the browser did not generate itself.
drop policy if exists push_subscriptions_own on public.push_subscriptions;
create policy push_subscriptions_own on public.push_subscriptions
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- -------------------------------------------------------------------- outbox
create table if not exists public.push_queue (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  -- The notification kind, kept so the person's switches can be read again at
  -- the moment of sending. A break queued ten minutes ago must not arrive
  -- after they have just turned break reminders off.
  type text not null,
  title text not null,
  body text,
  link text,
  -- Matches the tag the page uses for the same event, so a device that is
  -- awake and gets both shows one notification rather than a pair.
  tag text,
  due_at timestamptz not null default now(),
  sent_at timestamptz,
  -- Held by the dispatcher while it works on the row, so two app containers
  -- cannot send the same notification twice.
  claimed_at timestamptz,
  attempts int not null default 0,
  last_error text,
  created_at timestamptz not null default now()
);

-- The dispatcher's only question: what is due and unsent?
create index if not exists push_queue_due_idx
  on public.push_queue (due_at) where sent_at is null;

-- Cancelling: every punch in the company sweeps this person's pending break
-- reminder, and every enqueue clears the tag it is replacing. Both are lookups
-- by owner, and both happen on the hot path of somebody clocking in.
create index if not exists push_queue_user_pending_idx
  on public.push_queue (user_id, type) where sent_at is null;

alter table public.push_queue enable row level security;
-- Deliberately no grants to `authenticated`: rows are written by the definer
-- functions below and read by the service role. There is no policy either, so
-- even a stray grant would select nothing.
grant all on public.push_queue to service_role;

-- ------------------------------------------------------------------- enqueue
-- File one for later. `_tag` doubles as the cancellation handle: filing a new
-- row under a tag replaces whatever was queued under it, which is how a break
-- corrected by a manager re-arms rather than doubles.
create or replace function public.enqueue_push(
  _user uuid,
  _type text,
  _title text,
  _body text,
  _link text,
  _tag text,
  _due timestamptz default now()
) returns void language plpgsql security definer set search_path = public
as $fn$
begin
  if _user is null or not public.wants_notification(_user, _type) then
    return;
  end if;

  if _tag is not null then
    delete from public.push_queue
     where user_id = _user and tag = _tag and sent_at is null;
  end if;

  insert into public.push_queue (user_id, type, title, body, link, tag, due_at)
  values (_user, _type, _title, _body, _link, _tag, _due);
end;
$fn$;
revoke all on function public.enqueue_push(uuid, text, text, text, text, text, timestamptz)
  from public, anon, authenticated;

-- ----------------------------------------------------- every notification row
-- One trigger covers the lot — published schedules, shift changes,
-- announcements, company status, the platform's own alerts — because every one
-- of them already ends up as a row in `notifications`. Anything taught to
-- write one in future is pushed without being taught twice.
create or replace function public.push_for_notification()
returns trigger language plpgsql security definer set search_path = public
as $fn$
begin
  perform public.enqueue_push(
    new.user_id, new.type, new.title, coalesce(new.body, ''),
    coalesce(new.link, '/dashboard'),
    -- The same tag the bell gives it on a device that is already awake.
    'notification-' || new.id::text,
    now()
  );
  return null;
end;
$fn$;
revoke all on function public.push_for_notification() from public, anon, authenticated;

drop trigger if exists trg_push_for_notification on public.notifications;
create trigger trg_push_for_notification
after insert on public.notifications
for each row execute function public.push_for_notification();

-- --------------------------------------------------------------- break is up
-- How far ahead of the end of the break to speak up. Matches BREAK_WARNING_MS
-- in src/lib/break-reminder.ts — the page and the queue must not disagree
-- about when "nearly up" is, or a device that is awake shows two.
create or replace function public.break_warning_minutes() returns int
language sql immutable as $fn$ select 2 $fn$;

-- A break's end is known the moment it starts: the punch carries the length the
-- employee picked. So the reminder is filed then, for the minute it is wanted,
-- and nothing has to be watching in between.
create or replace function public.push_for_break()
returns trigger language plpgsql security definer set search_path = public
as $fn$
declare
  punch public.time_punches;
  warn int := public.break_warning_minutes();
begin
  -- Assigned in branches rather than a CASE: `new` does not exist on a delete,
  -- and reading it at all there is an error.
  if tg_op = 'DELETE' then punch := old; else punch := new; end if;

  -- A correction, an early return, or clocking out: whatever was queued for
  -- this punch is no longer true. It is filed again below if it still is.
  delete from public.push_queue
   where user_id = punch.user_id
     and type = 'break_ending'
     and sent_at is null
     and (tag = 'break-' || punch.id::text
          -- Coming back, or going home, ends every break — including one
          -- started on a shared clock-in tablet under a different punch id.
          or punch.kind in ('break_end', 'out', 'in'));

  if tg_op = 'DELETE' then
    return null;
  end if;

  if punch.kind = 'break_start' and coalesce(punch.break_minutes, 0) > warn then
    perform public.enqueue_push(
      punch.user_id,
      'break_ending',
      'Break almost over',
      'Two minutes left on your ' || punch.break_minutes || '-minute break.',
      '/timeclock',
      'break-' || punch.id::text,
      punch.at + make_interval(mins => punch.break_minutes - warn)
    );
  end if;

  return null;
end;
$fn$;
revoke all on function public.push_for_break() from public, anon, authenticated;

drop trigger if exists trg_push_for_break on public.time_punches;
create trigger trg_push_for_break
after insert or update or delete on public.time_punches
for each row execute function public.push_for_break();

-- ------------------------------------------------------------ board messages
-- An ordinary post never becomes a notification row — one per post per person
-- would bury the bell under the day's small talk — so it is queued straight.
-- An announcement is left alone: it writes a row, and the trigger above has it.
create or replace function public.push_for_message()
returns trigger language plpgsql security definer set search_path = public
as $fn$
declare
  who text;
  preview text;
  member record;
begin
  if new.is_announcement then
    return null;
  end if;

  select nullif(full_name, '') into who from public.profiles where id = new.author_id;
  preview := left(new.body, 140) || case when char_length(new.body) > 140 then '…' else '' end;

  for member in
    select id from public.profiles
     where company_id = new.company_id and id <> new.author_id
  loop
    perform public.enqueue_push(
      member.id, 'board_message',
      coalesce(who, 'Someone') || ' posted a message',
      preview, '/messages', 'msg-' || new.id::text, now()
    );
  end loop;

  return null;
end;
$fn$;
revoke all on function public.push_for_message() from public, anon, authenticated;

drop trigger if exists trg_push_for_message on public.company_messages;
create trigger trg_push_for_message
after insert on public.company_messages
for each row execute function public.push_for_message();

-- ---------------------------------------------------------------- dispatcher
-- Take the next few due rows and mark them as mine.
--
-- `for update skip locked` and the `claimed_at` stamp are what let more than
-- one app container run this loop without either of them sending the same
-- notification. A claim older than two minutes is treated as abandoned — a
-- container that died mid-send should not silence a reminder forever.
create or replace function public.claim_due_pushes(_limit int default 25)
returns setof public.push_queue
language plpgsql security definer set search_path = public
as $fn$
begin
  -- Sent rows are of no further interest to anybody; a day is long enough to
  -- look at one while working out why a phone stayed quiet.
  delete from public.push_queue
   where sent_at is not null and sent_at < now() - interval '1 day';

  -- Switched off since it was filed. Not an error, and not worth sending.
  delete from public.push_queue q
   where q.sent_at is null and q.due_at <= now()
     and not public.wants_notification(q.user_id, q.type);

  -- Too late to be worth saying. If this container has been down — or the
  -- whole stack has — the last thing anybody wants on the way back up is
  -- yesterday's breaks going off one after another.
  --
  -- The break window is tight on purpose: the message says "two minutes left",
  -- and two minutes after it was due that sentence is false. Silence beats a
  -- wrong number on the one notification people time themselves by. Everything
  -- else keeps for a day. This is also what finally clears a row that has
  -- burned through its five attempts.
  delete from public.push_queue q
   where q.sent_at is null
     and q.due_at < now() - case when q.type = 'break_ending'
                                 then interval '2 minutes'
                                 else interval '1 day' end;

  return query
  with due as (
    select q.id from public.push_queue q
     where q.sent_at is null
       and q.due_at <= now()
       and q.attempts < 5
       and (q.claimed_at is null or q.claimed_at < now() - interval '2 minutes')
     order by q.due_at
     limit greatest(_limit, 1)
     for update skip locked
  )
  update public.push_queue q
     set claimed_at = now(), attempts = q.attempts + 1
    from due
   where q.id = due.id
  returning q.*;
end;
$fn$;
revoke all on function public.claim_due_pushes(int) from public, anon, authenticated;
grant execute on function public.claim_due_pushes(int) to service_role;

-- Done with, or failed with something worth keeping. A row that has burned
-- through its attempts is left behind rather than retried forever; `attempts`
-- and `last_error` are the record of why a phone stayed quiet.
create or replace function public.mark_push_sent(_id uuid, _error text default null)
returns void language sql security definer set search_path = public
as $fn$
  update public.push_queue
     set sent_at = case when _error is null then now() else sent_at end,
         claimed_at = null,
         last_error = _error
   where id = _id;
$fn$;
revoke all on function public.mark_push_sent(uuid, text) from public, anon, authenticated;
grant execute on function public.mark_push_sent(uuid, text) to service_role;
