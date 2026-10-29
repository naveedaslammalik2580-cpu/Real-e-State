do $$
declare r record; cols text;
begin
  for r in
    select c.oid, c.conname, c.conrelid
    from pg_constraint c
    join pg_class t on t.oid=c.conrelid
    join pg_namespace n on n.oid=t.relnamespace
    where c.contype='f' and n.nspname='public'
      and t.relname in ('contacts','team_members','properties','deals','milestones','tasks','activities','showings','referrals','goals','finance_records','scripts','ai_prompts','scheduled_items','custom_field_values','workspace_settings')
      and array_length(c.conkey,1) > 1
  loop
    select string_agg(quote_ident(a.attname), ', ' order by u.ord)
      into cols
    from unnest((select conkey from pg_constraint where oid=r.oid)) with ordinality u(attnum,ord)
    join pg_attribute a on a.attrelid=r.conrelid and a.attnum=u.attnum;
    execute format('create index if not exists %I on %s (%s)', r.conname || '_idx', r.conrelid::regclass, cols);
  end loop;
end $$;
