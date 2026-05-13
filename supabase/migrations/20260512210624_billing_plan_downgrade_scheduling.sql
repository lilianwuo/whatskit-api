-- Add pending_plan_id to billing.subscriptions for deferred plan downgrades.
-- When a user requests a downgrade, change_plan() stores the new plan here
-- instead of applying immediately. renew_subscriptions() applies it at period end.

alter table billing.subscriptions
add column pending_plan_id text;

alter table only billing.subscriptions
add constraint subscriptions_pending_plan_id_fkey
foreign key (pending_plan_id)
references billing.plans(id);

-- Replace change_plan() to differentiate upgrades (immediate) from downgrades (deferred).
set check_function_bodies = off;

create or replace function billing.change_plan(
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
  set tier_id              = _tier_id,
      plan_id              = _plan_id,
      pending_plan_id      = null,
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

-- Replace renew_subscriptions() to apply pending downgrades at period end.
create or replace function billing.renew_subscriptions() returns void
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
    -- Clear pending_plan_id first so change_plan() treats it as a regular renewal.
    if _sub.pending_plan_id is not null then
      update billing.subscriptions
      set plan_id         = _sub.pending_plan_id,
          pending_plan_id = null
      where organization_id = _sub.organization_id;

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

    -- Re-grant balance products (AI credits, message allowance, etc.)
    perform billing.change_plan(_sub.organization_id, _sub.plan_id);
  end loop;
end;
$$;
