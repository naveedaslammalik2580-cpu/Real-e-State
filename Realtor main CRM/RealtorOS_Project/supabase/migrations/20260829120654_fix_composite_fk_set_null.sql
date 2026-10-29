do $$
declare
  relationship record;
  corrected_definition text;
begin
  for relationship in
    select
      constraint_row.conname,
      constraint_row.conrelid,
      relationship_column.attname as relationship_column,
      pg_get_constraintdef(constraint_row.oid) as old_definition
    from pg_constraint constraint_row
    join lateral unnest(constraint_row.conkey) with ordinality key_column(attnum, position)
      on true
    join pg_attribute relationship_column
      on relationship_column.attrelid = constraint_row.conrelid
     and relationship_column.attnum = key_column.attnum
    join pg_attribute tenant_column
      on tenant_column.attrelid = constraint_row.conrelid
     and tenant_column.attnum = constraint_row.conkey[1]
    where constraint_row.contype = 'f'
      and constraint_row.connamespace = 'public'::regnamespace
      and constraint_row.confdeltype = 'n'
      and cardinality(constraint_row.conkey) = 2
      and tenant_column.attname = 'user_id'
      and key_column.position = 2
  loop
    corrected_definition := regexp_replace(
      relationship.old_definition,
      ' ON DELETE SET NULL$',
      ' ON DELETE SET NULL (' || quote_ident(relationship.relationship_column) || ')'
    );

    execute format(
      'alter table %s drop constraint %I, add constraint %I %s',
      relationship.conrelid::regclass,
      relationship.conname,
      relationship.conname,
      corrected_definition
    );
  end loop;
end
$$;
