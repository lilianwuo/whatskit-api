-- Renew subscriptions whose billing period has ended.
-- Called by a daily cron job.
-- For each expired subscription with an active plan:
--   1. Rotates current_period_start/end forward by one billing cycle.
--   2. Re-grants balance products by calling billing.change_plan().
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
      s.current_period_end,
      p.billing_cycle
    from billing.subscriptions s
    join billing.plans p on p.id = s.plan_id
    where s.current_period_end is not null
      and s.current_period_end <= now()
      and p.active = true
  loop
    -- Determine cycle length from the plan
    _cycle := case _sub.billing_cycle
      when 'month' then interval '1 month'
      when 'year'  then interval '1 year'
      else              interval '1 month'
    end;

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

-- Renew expired subscriptions every day at 00:05 UTC.
-- The 5-minute offset avoids clock-edge race conditions with period_end timestamps.
select cron.schedule(
  'billing-renewal',
  '5 0 * * *',
  $$select billing.renew_subscriptions()$$
);
