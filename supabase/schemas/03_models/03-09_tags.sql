create table public.tags (
  id uuid default gen_random_uuid() not null,
  organization_id uuid not null,
  name text not null,
  color text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

alter table only public.tags
add constraint tags_pkey
primary key (id);

alter table only public.tags
add constraint tags_organization_id_fkey
foreign key (organization_id)
references public.organizations(id)
on delete cascade;

create index tags_organization_idx
on public.tags
using btree (organization_id);

create trigger set_updated_at
before update
on public.tags
for each row
execute function public.moddatetime('updated_at');
