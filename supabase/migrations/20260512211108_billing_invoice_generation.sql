-- Add billing.generate_invoice() and hook it into renew_subscriptions().
-- Generates an invoice for a closed billing period with three item types:
--   'plan'    — fixed plan fee
--   'overage' — counter product usage above the plan's included quantity
--   'credit'  — balance product consumption (ai_credits) billed during the period

set check_function_bodies = off;

-- Generate an invoice for a closed billing period.
create or replace function billing.generate_invoice(
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

  -- Line item: plan fee (recorded even when price = 0)
  insert into billing.invoices_items
    (invoice_id, type, plan_id, quantity, unit_price, amount)
  values
    (_invoice_id, 'plan', _plan.id, 1, _plan.price, _plan.price);

  _subtotal := _subtotal + _plan.price;

  -- Line items: counter overages (messages, conversations, etc.)
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

  -- Line items: balance consumption (ai_credits) billed during the period
  for _pp in
    select
      pp.product_id,
      pp.unit_price
    from billing.plans_products pp
    join billing.products p on p.id = pp.product_id
    where pp.plan_id = _plan.id
      and p.kind     = 'balance'
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

  -- Finalize: update subtotal and mark as issued
  update billing.invoices
  set subtotal = _subtotal,
      status   = 'issued'
  where id = _invoice_id;

  return _invoice_id;
end;
$$;

-- Update renew_subscriptions() to call generate_invoice() before each renewal.
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

    -- Advance the period window
    update billing.subscriptions
    set
      current_period_start = _sub.current_period_end,
      current_period_end   = _sub.current_period_end + _cycle
    where organization_id = _sub.organization_id;

    -- Generate invoice for the period that just closed
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
