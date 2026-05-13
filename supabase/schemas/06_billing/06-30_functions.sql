-- Check if a product limit allows usage for an organization.
-- Returns true if allowed, raises exception if blocked.
--  1. No subscription → allow (no billing)
--  2. No tiers_products row → allow (no limit)
--  3. Cap is null → unlimited, allow
--  4. Counter/gauge: usage + amount > cap → block
--  5. Balance: balance - amount < cap → block (cap is a floor, e.g. 0 or negative for debt)
create function billing.check_limit(
  _organization_id uuid,
  _product_id text,
  _amount numeric default 1
) returns boolean
language plpgsql
security definer
set search_path to ''
as $$
declare
  _tier_id text;
  _kind text;
  _cap numeric;
  _interval text;
  _current numeric;
  _period date;
begin
  -- Get tier from subscription
  select s.tier_id into _tier_id
  from billing.subscriptions s
  where s.organization_id = _organization_id;

  -- No subscription = no billing = allow
  if not found then
    return true;
  end if;

  -- Get product kind
  select p.kind into _kind
  from billing.products p
  where p.id = _product_id;

  -- No product = no billing for this resource
  if not found then
    return true;
  end if;

  -- Get tier cap and interval
  select tp.cap, tp.interval
  into _cap, _interval
  from billing.tiers_products tp
  where tp.tier_id = _tier_id
    and tp.product_id = _product_id;

  -- No tier_product row = no limit for this product
  if not found then
    return true;
  end if;

  -- Cap is null = unlimited
  if _cap is null then
    return true;
  end if;

  -- Determine the period to check
  _period := case _interval
    when 'month' then date_trunc('month', current_date)::date
    when 'day' then current_date
    else '1970-01-01'::date
  end;

  -- Get current value
  select u.quantity into _current
  from billing.usage u
  where u.organization_id = _organization_id
    and u.product_id = _product_id
    and u.interval = _interval
    and u.period = _period;

  _current := coalesce(_current, 0);

  -- Balance products: cap is a floor (minimum allowed balance)
  -- e.g. cap=0 means no debt, cap=-5 allows up to $5 debt
  if _kind = 'balance' then
    if _current - _amount < _cap then
      raise exception 'Insufficient balance for %', _product_id;
    end if;
  else
    -- Counter/gauge: cap is a ceiling
    if _current + _amount > _cap then
      raise exception 'Usage limit reached for %', _product_id;
    end if;
  end if;

  return true;
end;
$$;

-- Generic: increment usage counters for a product.
-- Upserts day, month, and lifetime rows.
create function billing.update_usage(
  _organization_id uuid,
  _product_id text,
  _quantity numeric default 1
) returns void
language plpgsql
security definer
set search_path to ''
as $$
declare
  _today date := current_date;
  _month date := date_trunc('month', current_date)::date;
begin
  -- No product = no billing for this resource
  if not exists (select 1 from billing.products where id = _product_id) then
    return;
  end if;

  -- Upsert day
  insert into billing.usage (organization_id, product_id, interval, period, quantity)
  values (_organization_id, _product_id, 'day', _today, _quantity)
  on conflict (organization_id, product_id, interval, period)
  do update set quantity = billing.usage.quantity + _quantity;

  -- Upsert month
  insert into billing.usage (organization_id, product_id, interval, period, quantity)
  values (_organization_id, _product_id, 'month', _month, _quantity)
  on conflict (organization_id, product_id, interval, period)
  do update set quantity = billing.usage.quantity + _quantity;

  -- Upsert lifetime
  insert into billing.usage (organization_id, product_id, interval, period, quantity)
  values (_organization_id, _product_id, 'lifetime', '1970-01-01', _quantity)
  on conflict (organization_id, product_id, interval, period)
  do update set quantity = billing.usage.quantity + _quantity;
end;
$$;

-- Generic trigger: check limit before insert.
-- Product id is derived from the table name (e.g. messages, conversations).
create function billing.check_product_limit() returns trigger
language plpgsql
security definer
set search_path to ''
as $$
begin
  perform billing.check_limit(new.organization_id, tg_table_name);
  return new;
end;
$$;

-- Generic trigger: update usage after insert or delete.
-- Product id is derived from the table name.
-- Counter products ignore delete; gauge products decrement on delete.
create function billing.update_product_usage() returns trigger
language plpgsql
security definer
set search_path to ''
as $$
declare
  _kind text;
begin
  if tg_op = 'DELETE' then
    select p.kind into _kind
    from billing.products p
    where p.id = tg_table_name;

    if _kind = 'counter' then
      return old;
    end if;

    perform billing.update_usage(old.organization_id, tg_table_name, -1);
    return old;
  end if;

  perform billing.update_usage(new.organization_id, tg_table_name);
  return new;
end;
$$;

-- Trigger: check storage limit before upload
-- Path convention: organizations/<org_id>/attachments/<file_id>
create function billing.check_storage_limit() returns trigger
language plpgsql
security definer
set search_path to ''
as $$
declare
  _org_id uuid;
  _size_gb numeric;
begin
  _org_id := (string_to_array(new.name, '/'))[2]::uuid;
  _size_gb := coalesce((new.metadata->>'size')::numeric, 0) / 1000000000.0;

  perform billing.check_limit(_org_id, 'storage', _size_gb);
  return new;
end;
$$;

-- Trigger: update storage usage after insert or delete
-- Path convention: organizations/<org_id>/attachments/<file_id>
create function billing.update_storage_usage() returns trigger
language plpgsql
security definer
set search_path to ''
as $$
declare
  _org_id uuid;
  _size_gb numeric;
begin
  if tg_op = 'INSERT' then
    _org_id := (string_to_array(new.name, '/'))[2]::uuid;
    _size_gb := coalesce((new.metadata->>'size')::numeric, 0) / 1000000000.0;
    perform billing.update_usage(_org_id, 'storage', _size_gb);
    return new;
  elsif tg_op = 'DELETE' then
    _org_id := (string_to_array(old.name, '/'))[2]::uuid;
    _size_gb := coalesce((old.metadata->>'size')::numeric, 0) / 1000000000.0;
    perform billing.update_usage(_org_id, 'storage', -_size_gb);
    return old;
  end if;

  return coalesce(new, old);
end;
$$;

-- Trigger: skip ledger insert if the product doesn't exist (no billing)
create function billing.guard_ledger_insert() returns trigger
language plpgsql
security definer
set search_path to ''
as $$
begin
  if not exists (select 1 from billing.products where id = new.product_id) then
    return null;
  end if;
  return new;
end;
$$;

-- Trigger: update usage after ledger insert
-- Updates the lifetime balance and tracks daily/monthly cost stats.
-- Non-billable entries are recorded for analytics but don't affect balance.
create function billing.process_ledger_entry() returns trigger
language plpgsql
security definer
set search_path to ''
as $$
begin
  if new.billable is distinct from false then
    perform billing.update_usage(new.organization_id, new.product_id, new.quantity);
  end if;

  return new;
end;
$$;

-- Trigger: initialize subscription on organization insert.
-- Assigns the lowest-level active tier and default plan (if any).
-- No tiers = no billing.
create function billing.initialize_subscription() returns trigger
language plpgsql
security definer
set search_path to ''
as $$
declare
  _tier_id text;
  _plan_id text;
begin
  select t.id into _tier_id
  from billing.tiers t
  where t.active = true
  order by t.level asc
  limit 1;

  if not found then
    return new;
  end if;

  -- Create subscription with tier only
  insert into billing.subscriptions (organization_id, tier_id)
  values (new.id, _tier_id);

  -- Assign default plan if one exists
  select p.id into _plan_id
  from billing.plans p
  where p.is_default = true
    and p.active = true
  limit 1;

  if _plan_id is not null then
    perform billing.change_plan(new.id, _plan_id);
  end if;

  return new;
end;
$$;

-- Change plan for an organization.
-- Upgrades (new plan min_tier >= current tier level) apply immediately.
-- Downgrades (new plan min_tier < current tier level) are deferred: the new plan
-- is stored in pending_plan_id and applied at the next period end by renew_subscriptions().
-- Called by the app layer (service_role).
create function billing.change_plan(
  _organization_id uuid,
  _plan_id text
) returns void
language plpgsql
security definer
set search_path to ''
as $$
declare
  _plan      billing.plans%rowtype;
  _tier_id   text;
  _cur_level int;
  _pp        record;
begin
  -- Get the target plan
  select * into strict _plan
  from billing.plans p
  where p.id = _plan_id
    and p.active = true;

  -- Find the lowest active tier that satisfies the plan's min_tier requirement
  select t.id into _tier_id
  from billing.tiers t
  where t.level >= _plan.min_tier
    and t.active = true
  order by t.level asc
  limit 1;

  if _tier_id is null then
    raise exception 'No active tier found for plan %', _plan_id;
  end if;

  -- Get the current tier level so we can detect a downgrade
  select t.level into _cur_level
  from billing.subscriptions s
  join billing.tiers t on t.id = s.tier_id
  where s.organization_id = _organization_id;

  -- Downgrade: new plan requires a lower tier than the current one.
  -- Defer the change so the org keeps its current benefits until period end.
  if _cur_level is not null and _plan.min_tier < _cur_level then
    update billing.subscriptions
    set pending_plan_id = _plan_id
    where organization_id = _organization_id;
    return;
  end if;

  -- Upgrade (or initial assignment / renewal): apply immediately.
  update billing.subscriptions
  set tier_id             = _tier_id,
      plan_id             = _plan_id,
      pending_plan_id     = null,
      current_period_start = now()
  where organization_id = _organization_id;

  -- Grant balance products included in the plan
  for _pp in
    select pp.product_id, pp.included
    from billing.plans_products pp
    join billing.products p on p.id = pp.product_id
    where pp.plan_id = _plan_id
      and p.kind = 'balance'
      and pp.included is not null
      and pp.included > 0
  loop
    insert into billing.ledger (organization_id, product_id, type, quantity)
    values (_organization_id, _pp.product_id, 'grant', _pp.included);
  end loop;
end;
$$;

-- Renew subscriptions whose billing period has ended.
-- Called by a daily cron job.
-- For each expired subscription:
--   1. If a pending_plan_id exists (deferred downgrade), applies it first and clears the field.
--   2. Rotates current_period_start/end forward by one billing cycle.
--   3. Re-grants balance products by calling billing.change_plan().
-- Subscriptions without a plan (free tier) are skipped — no renewal needed.
create function billing.renew_subscriptions() returns void
language plpgsql
security definer
set search_path to ''
as $$
declare
  _sub   record;
  _cycle interval;
begin
  for _sub in
    select
      s.organization_id,
      s.plan_id,
      s.pending_plan_id,
      s.current_period_end,
      p.billing_cycle
    from billing.subscriptions s
    join billing.plans p on p.id = s.plan_id
    where s.current_period_end is not null
      and s.current_period_end <= now()
      and p.active = true
  loop
    -- Apply deferred downgrade if one is pending.
    -- We clear pending_plan_id first so that change_plan() below
    -- sees the new (lower) tier and treats it as a regular renewal.
    if _sub.pending_plan_id is not null then
      update billing.subscriptions
      set plan_id         = _sub.pending_plan_id,
          pending_plan_id = null
      where organization_id = _sub.organization_id;

      -- Use the pending plan for the rest of this renewal cycle.
      _sub.plan_id := _sub.pending_plan_id;
    end if;

    -- Determine cycle length from the (possibly updated) plan
    select case p.billing_cycle
      when 'month' then interval '1 month'
      when 'year'  then interval '1 year'
      else              interval '1 month'
    end into _cycle
    from billing.plans p
    where p.id = _sub.plan_id;

    -- Advance the period window before re-granting,
    -- so change_plan() sees the correct new period.
    update billing.subscriptions
    set
      current_period_start = _sub.current_period_end,
      current_period_end   = _sub.current_period_end + _cycle
    where organization_id = _sub.organization_id;

    -- Generate invoice for the closing period before renewing.
    perform billing.generate_invoice(
      _sub.organization_id,
      _sub.current_period_end - _cycle,
      _sub.current_period_end
    );

    -- Re-grant balance products (AI credits, message allowance, etc.)
    perform billing.change_plan(_sub.organization_id, _sub.plan_id);
  end loop;
end;
$$;

-- Generate an invoice for a closed billing period.
-- Creates one billing.invoices row and multiple billing.invoices_items rows:
--   'plan'    — fixed plan fee (even if $0, for record-keeping)
--   'overage' — counter products used above the plan's included quantity
--   'credit'  — balance products (ai_credits) consumed during the period
-- Called automatically by renew_subscriptions() before each renewal.
create function billing.generate_invoice(
  _organization_id uuid,
  _period_start    timestamptz,
  _period_end      timestamptz
) returns uuid
language plpgsql
security definer
set search_path to ''
as $$
declare
  _invoice_id  uuid;
  _plan        billing.plans%rowtype;
  _subtotal    numeric := 0;
  _pp          record;
  _used        numeric;
  _included    numeric;
  _overage_qty numeric;
  _overage_amt numeric;
  _credit_amt  numeric;
  _period_date date;
begin
  -- Get the active plan for this organization
  select p.* into _plan
  from billing.subscriptions s
  join billing.plans p on p.id = s.plan_id
  where s.organization_id = _organization_id;

  if not found then
    return null; -- No subscription, no invoice
  end if;

  -- Create the invoice in draft state
  insert into billing.invoices (organization_id, period_start, period_end, status, subtotal)
  values (_organization_id, _period_start, _period_end, 'draft', 0)
  returning id into _invoice_id;

  -- ── Line item: plan fee ─────────────────────────────────────────────────────
  insert into billing.invoices_items
    (invoice_id, type, plan_id, quantity, unit_price, amount)
  values
    (_invoice_id, 'plan', _plan.id, 1, _plan.price, _plan.price);

  _subtotal := _subtotal + _plan.price;

  -- ── Line items: counter overages (messages, conversations, etc.) ────────────
  -- period date for monthly usage lookup
  _period_date := date_trunc('month', _period_start)::date;

  for _pp in
    select
      pp.product_id,
      pp.included,
      pp.unit_price
    from billing.plans_products pp
    join billing.products p on p.id = pp.product_id
    where pp.plan_id    = _plan.id
      and p.kind        = 'counter'
      and pp.interval   = 'month'
      and pp.unit_price is not null
      and pp.unit_price > 0
  loop
    -- Actual monthly usage
    select coalesce(u.quantity, 0) into _used
    from billing.usage u
    where u.organization_id = _organization_id
      and u.product_id      = _pp.product_id
      and u.interval        = 'month'
      and u.period          = _period_date;

    _included    := coalesce(_pp.included, 0);
    _overage_qty := greatest(_used - _included, 0);
    _overage_amt := _overage_qty * _pp.unit_price;

    if _overage_qty > 0 then
      insert into billing.invoices_items
        (invoice_id, type, product_id, quantity, unit_price, amount)
      values
        (_invoice_id, 'overage', _pp.product_id, _overage_qty, _pp.unit_price, _overage_amt);

      _subtotal := _subtotal + _overage_amt;
    end if;
  end loop;

  -- ── Line items: balance consumption (ai_credits) ────────────────────────────
  -- Sum all billable ledger consumption entries in the period.
  for _pp in
    select
      pp.product_id,
      pp.unit_price
    from billing.plans_products pp
    join billing.products p on p.id = pp.product_id
    where pp.plan_id  = _plan.id
      and p.kind      = 'balance'
  loop
    select coalesce(sum(abs(l.quantity)), 0) into _credit_amt
    from billing.ledger l
    where l.organization_id = _organization_id
      and l.product_id      = _pp.product_id
      and l.type            = 'consumption'
      and l.billable        = true
      and l.created_at      >= _period_start
      and l.created_at      <  _period_end;

    if _credit_amt > 0 then
      insert into billing.invoices_items
        (invoice_id, type, product_id, quantity, unit_price, amount)
      values
        (_invoice_id, 'credit', _pp.product_id, _credit_amt, 1, _credit_amt);

      _subtotal := _subtotal + _credit_amt;
    end if;
  end loop;

  -- ── Update invoice subtotal and mark as issued ───────────────────────────────
  update billing.invoices
  set subtotal = _subtotal,
      status   = 'issued'
  where id = _invoice_id;

  return _invoice_id;
end;
$$;
