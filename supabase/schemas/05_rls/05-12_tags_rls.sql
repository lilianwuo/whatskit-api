alter table public.tags enable row level security;

create policy "members can read their orgs tags"
on public.tags
for select
to authenticated, anon
using (
  organization_id in (
    select public.get_authorized_orgs('member')
  )
);

create policy "members can manage their orgs tags"
on public.tags
for all
to authenticated, anon
using (
  organization_id in (
    select public.get_authorized_orgs('member')
  )
);
