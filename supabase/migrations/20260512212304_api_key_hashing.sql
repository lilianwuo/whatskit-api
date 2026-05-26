-- API Key Hashing: replace plaintext key storage with SHA-256 hash.
--
-- Migration plan:
--   1. Add key_prefix and key_hash columns.
--   2. Backfill from existing plaintext key column.
--   3. Add unique constraint on key_hash.
--   4. Drop the plaintext key column.
--   5. Update get_authorized_orgs() to use hash comparison.
--   6. Drop and recreate the RLS policy to use hash comparison.
--
-- IMPORTANT: After this migration, existing API keys will still work because
-- we backfill key_hash from the current plaintext key. Users do NOT need to
-- regenerate their keys — the same key string will now be hashed on each request.

-- Step 1: Add new columns (nullable initially for backfill)
-- IF NOT EXISTS: on a fresh DB these columns already exist from the schema file.
alter table public.api_keys
add column if not exists key_prefix text,
add column if not exists key_hash bytea;

-- Step 2: Backfill from existing plaintext key (only when old key column still exists)
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'api_keys'
      and column_name  = 'key'
  ) then
    update public.api_keys
    set
      key_prefix = left(key, 10),
      key_hash   = extensions.digest(key, 'sha256')
    where key_prefix is null or key_hash is null;
  end if;
end;
$$;

-- Step 3: Enforce not-null and unique constraints
-- Use DO blocks because ADD CONSTRAINT IF NOT EXISTS is not valid PostgreSQL syntax.
do $$
begin
  -- Set not null on key_prefix if the column exists and is nullable
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'api_keys'
      and column_name  = 'key_prefix'
      and is_nullable  = 'YES'
  ) then
    alter table public.api_keys alter column key_prefix set not null;
  end if;

  -- Set not null on key_hash if the column exists and is nullable
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'api_keys'
      and column_name  = 'key_hash'
      and is_nullable  = 'YES'
  ) then
    alter table public.api_keys alter column key_hash set not null;
  end if;

  -- Add unique constraint only if it doesn't already exist
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.api_keys'::regclass
      and conname  = 'api_keys_key_hash_key'
  ) then
    alter table public.api_keys
    add constraint api_keys_key_hash_key unique (key_hash);
  end if;
end;
$$;

-- Step 4: Drop the plaintext key column and its old unique constraint (only if they exist)
alter table public.api_keys
drop constraint if exists api_keys_key_key;

alter table public.api_keys
drop column if exists key cascade; -- drops dependent RLS policies; Step 6 recreates them

-- Step 5: Update get_authorized_orgs() to compare hashes
set check_function_bodies = off;

create or replace function public.get_authorized_orgs(role public.role default 'member') returns setof uuid
language plpgsql
security definer
set search_path to ''
as $$
declare
  req_level int;
  api_key text;
  org_id uuid;
begin
  req_level := case role::text
    when 'owner' then 3
    when 'admin' then 2
    else 1 -- 'member'
  end;

  -- First, try JWT authentication via auth.uid()
  if auth.uid() is not null then
    return query select organization_id from public.agents
    where
      user_id = auth.uid()
    and (
      extra->'invitation' is null
      or extra->'invitation'->>'status' = 'accepted'
    )
    and (
      case (extra->>'role')
        when 'owner' then 3
        when 'admin' then 2
        else 1 -- 'member'
      end
    ) >= req_level;

    return;
  end if;

  -- Fallback to API key authentication (hash comparison)
  api_key := current_setting('request.headers', true)::json->>'api-key';

  if api_key is not null then
    select a.organization_id into org_id
    from public.api_keys a
    where a.key_hash = extensions.digest(api_key, 'sha256')
    and (
      case (a.role::text)
        when 'owner' then 3
        when 'admin' then 2
        else 1 -- 'member'
      end
    ) >= req_level;

    if org_id is not null then
      return next org_id;
    end if;
    return;
  end if;

  raise exception using
    errcode = '42501',
    message = 'authentication required',
    hint = 'use api-key header or jwt authentication';
end;
$$;

-- Step 6: Recreate RLS policy with hash comparison
drop policy if exists "owners can read their orgs api keys" on public.api_keys;

create policy "owners can read their orgs api keys"
on public.api_keys
for select
to authenticated, anon
using (
  key_hash = extensions.digest(
    current_setting('request.headers', true)::json->>'api-key',
    'sha256'
  )
  or organization_id in (
    select public.get_authorized_orgs('owner')
  )
);
