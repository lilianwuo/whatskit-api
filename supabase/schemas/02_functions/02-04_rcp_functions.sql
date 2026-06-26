create or replace function public.change_contact_address(
  p_organization_id uuid,
  old_address text,
  new_address text
)
returns void
language plpgsql
security invoker
set search_path to ''
as $$
declare
  _contact_id uuid;
  _service public.service;
begin
  -- 1. Search for old contact address and get service & contact_id
  select service, contact_id into _service, _contact_id
  from public.contacts_addresses
  where organization_id = p_organization_id
    and address = old_address;

  if _service is null then
    return; -- Exit if not found
  end if;

  -- 2. Create new contact address (linked to same contact if it exists)
  -- Add extra.replaces_address
  insert into public.contacts_addresses (
    organization_id, service, address, contact_id, status, extra
  )
  values (
    p_organization_id, 
    _service, 
    new_address, 
    _contact_id, 
    'active',
    jsonb_build_object('replaces_address', old_address)
  )
  on conflict (organization_id, address) do update set
    contact_id = EXCLUDED.contact_id,
    status = 'active',
    extra = jsonb_set(
      coalesce(public.contacts_addresses.extra, '{}'::jsonb),
      '{replaces_address}',
      to_jsonb(old_address)
    );

  -- 3. Update old contact address status and add reference to new address
  update public.contacts_addresses set 
    status = 'inactive',
    extra = jsonb_set(
      coalesce(extra, '{}'::jsonb),
      '{replaced_by_address}',
      to_jsonb(new_address)
    )
  where organization_id = p_organization_id
    and address = old_address;
end;
$$;

create function public.init_data(
  p_organization_id uuid,
  p_limit integer default 200,
  p_per_conversation integer default 10,
  p_since timestamptz default null,
  p_until timestamptz default null
)
returns json
language plpgsql
stable
security invoker
set search_path to ''
as $$
declare
  _messages json;
  _conversations json;
  _conversation_ids uuid[];
begin
  -- Windowed messages: up to p_per_conversation per conversation, total p_limit
  with windowed as (
    select m.*,
      row_number() over (
        partition by m.conversation_id
        order by m.timestamp desc
      ) as rn
    from public.messages m
    where m.organization_id = p_organization_id
      and (p_since is null or m.timestamp > p_since)
      and (p_until is null or m.timestamp < p_until)
  ),
  limited as (
    select * from windowed
    where rn <= p_per_conversation
    order by timestamp desc
    limit p_limit
  )
  select
    coalesce(json_agg(row_to_json(l.*)), '[]'::json),
    array_agg(distinct l.conversation_id)
  into _messages, _conversation_ids
  from limited l;

  -- Fetch conversations for the messages returned
  select coalesce(json_agg(row_to_json(c.*)), '[]'::json)
  into _conversations
  from public.conversations c
  where c.id = any(_conversation_ids);

  return json_build_object(
    'conversations', _conversations,
    'messages', _messages
  );
end;
$$;

-- Reporting overview for the statistics screen: daily message buckets,
-- period totals, and the estimated WhatsApp template spend.
-- security invoker so the caller's RLS scopes data to their own organization.
create function public.report_overview(
  p_organization_id uuid,
  p_from timestamptz,
  p_to timestamptz
)
returns json
language plpgsql
stable
security invoker
set search_path to ''
as $$
declare
  _series json;
  _totals json;
  _cost numeric;
begin
  -- Daily buckets: sent (outgoing reached 'sent'), failed, replies (incoming).
  with daily as (
    select
      date_trunc('day', m.timestamp) as day,
      count(*) filter (
        where m.direction = 'outgoing' and m.status ? 'sent'
      ) as sent,
      count(*) filter (
        where m.status ? 'failed'
      ) as failed,
      count(*) filter (
        where m.direction = 'incoming'
      ) as replies
    from public.messages m
    where m.organization_id = p_organization_id
      and m.timestamp >= p_from
      and m.timestamp < p_to
    group by 1
    order by 1
  )
  select coalesce(json_agg(row_to_json(daily)), '[]'::json)
  into _series
  from daily;

  -- Period totals across delivery states.
  select json_build_object(
    'sent', count(*) filter (where m.direction = 'outgoing' and m.status ? 'sent'),
    'delivered', count(*) filter (where m.status ? 'delivered'),
    'read', count(*) filter (where m.status ? 'read'),
    'failed', count(*) filter (where m.status ? 'failed'),
    'replies', count(*) filter (where m.direction = 'incoming')
  )
  into _totals
  from public.messages m
  where m.organization_id = p_organization_id
    and m.timestamp >= p_from
    and m.timestamp < p_to;

  -- Estimated WhatsApp template spend from the billing ledger.
  -- Template costs are recorded with provider='whatsapp' and a negative
  -- quantity (a debit), so the spend is the negated sum.
  select coalesce(-sum(l.quantity), 0)
  into _cost
  from billing.ledger l
  where l.organization_id = p_organization_id
    and l.provider = 'whatsapp'
    and l.type = 'consumption'
    and l.created_at >= p_from
    and l.created_at < p_to;

  return json_build_object(
    'series', _series,
    'totals', _totals,
    'estimated_cost', _cost
  );
end;
$$;
