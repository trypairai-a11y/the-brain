-- Ops layer: typed links + timeline events between entries.
-- Backs the graph_query, timeline, link_entities, log_event operations.

-- CreateTable
CREATE TABLE "entity_links" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "from_entry_id" UUID NOT NULL,
    "to_entry_id" UUID NOT NULL,
    "edge_type" TEXT NOT NULL,
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "entity_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entity_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "entry_id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "entity_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "entity_links_tenant_id_from_entry_id_to_entry_id_edge_type_key" ON "entity_links"("tenant_id", "from_entry_id", "to_entry_id", "edge_type");

-- CreateIndex
CREATE INDEX "entity_links_tenant_id_from_entry_id_idx" ON "entity_links"("tenant_id", "from_entry_id");

-- CreateIndex
CREATE INDEX "entity_links_tenant_id_to_entry_id_idx" ON "entity_links"("tenant_id", "to_entry_id");

-- CreateIndex
CREATE INDEX "entity_events_tenant_id_entry_id_occurred_at_idx" ON "entity_events"("tenant_id", "entry_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "entity_events_tenant_id_occurred_at_idx" ON "entity_events"("tenant_id", "occurred_at" DESC);

-- AddForeignKey
ALTER TABLE "entity_links" ADD CONSTRAINT "entity_links_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entity_links" ADD CONSTRAINT "entity_links_from_entry_id_fkey" FOREIGN KEY ("from_entry_id") REFERENCES "entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entity_links" ADD CONSTRAINT "entity_links_to_entry_id_fkey" FOREIGN KEY ("to_entry_id") REFERENCES "entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entity_events" ADD CONSTRAINT "entity_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entity_events" ADD CONSTRAINT "entity_events_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;
