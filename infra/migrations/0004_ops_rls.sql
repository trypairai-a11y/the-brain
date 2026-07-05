-- RLS for the ops-layer tables (entity_links, entity_events).
-- Run AFTER `prisma migrate deploy` has created the tables.
-- Same policy shape as 0002_admin_bypass.sql (tenant isolation + is_admin bypass).

DO $$
DECLARE
  t text;
  tables text[] := ARRAY['entity_links','entity_events'];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (tenant_id = current_tenant_id() OR current_setting(''app.is_admin'', true) = ''true'')
         WITH CHECK (tenant_id = current_tenant_id() OR current_setting(''app.is_admin'', true) = ''true'')',
      t);
  END LOOP;
END$$;
