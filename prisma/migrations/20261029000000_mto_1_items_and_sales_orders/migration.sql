-- MTO-1: item roles + fulfilment mode, gram precision and two new units, manual sales orders (ADR-0031). Additive and forward-only:
-- every existing product becomes a SELLABLE item (tracked goods STOCKED, untracked goods MADE_TO_ORDER, services no mode), no product,
-- invoice, stock movement, payment or sequence is rewritten, and no tax treatment is inferred from the new columns.

-- ---------------------------------------------------------------------------------------------------------
-- 1. Items: role and fulfilment mode on the existing products table.
ALTER TABLE "products" ADD COLUMN "item_role" TEXT NOT NULL DEFAULT 'SELLABLE';
ALTER TABLE "products" ADD COLUMN "fulfilment_mode" TEXT;

-- Backfill: tracked goods are held as finished stock; untracked goods are invoiced without a stock effect (made to order).
UPDATE "products" SET "fulfilment_mode" = CASE WHEN "track_inventory" THEN 'STOCKED' ELSE 'MADE_TO_ORDER' END WHERE "kind" = 'GOODS';

-- Any writer that does not name a fulfilment mode (an older client, a restore of an older backup) gets the one its stock tracking implies:
-- sellable goods that track inventory are STOCKED, the rest MADE_TO_ORDER. A mode that IS named is checked, never overwritten.
CREATE FUNCTION "products_default_fulfilment_mode"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."item_role" = 'SELLABLE' AND NEW."kind" = 'GOODS' AND NEW."fulfilment_mode" IS NULL THEN
    NEW."fulfilment_mode" := CASE WHEN NEW."track_inventory" THEN 'STOCKED' ELSE 'MADE_TO_ORDER' END;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "products_default_fulfilment_mode_fill"
  BEFORE INSERT OR UPDATE ON "products"
  FOR EACH ROW EXECUTE FUNCTION "products_default_fulfilment_mode"();

-- Raw materials, components and packaging have no selling price.
ALTER TABLE "products" ALTER COLUMN "selling_price" DROP NOT NULL;

ALTER TABLE "products"
  ADD CONSTRAINT "products_item_role_valid" CHECK ("item_role" IN ('SELLABLE', 'RAW_MATERIAL', 'COMPONENT', 'PACKAGING')),
  ADD CONSTRAINT "products_fulfilment_mode_valid" CHECK ("fulfilment_mode" IS NULL OR "fulfilment_mode" IN ('STOCKED', 'MADE_TO_ORDER')),
  -- Sellable goods say how they are fulfilled and have a price; sellable services have a price and no mode; every other role is physical goods,
  -- priced nowhere, with no mode.
  ADD CONSTRAINT "products_item_role_shape" CHECK (
    ("item_role" = 'SELLABLE' AND "selling_price" IS NOT NULL
       AND (("kind" = 'GOODS' AND "fulfilment_mode" IS NOT NULL) OR ("kind" = 'SERVICE' AND "fulfilment_mode" IS NULL)))
    OR ("item_role" <> 'SELLABLE' AND "kind" = 'GOODS' AND "selling_price" IS NULL AND "mrp" IS NULL
       AND "price_includes_tax" = false AND "fulfilment_mode" IS NULL)),
  -- A stocked item tracks inventory; a made-to-order item holds no finished stock.
  ADD CONSTRAINT "products_mode_matches_tracking" CHECK (
    ("fulfilment_mode" IS DISTINCT FROM 'STOCKED' OR "track_inventory")
    AND ("fulfilment_mode" IS DISTINCT FROM 'MADE_TO_ORDER' OR NOT "track_inventory"));

-- The role never changes after creation (like the kind): it decides where an item may appear.
CREATE OR REPLACE FUNCTION "protect_product_identity"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'products cannot be deleted: make the product inactive instead'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
     OR NEW."sku" IS DISTINCT FROM OLD."sku"
     OR NEW."kind" IS DISTINCT FROM OLD."kind"
     OR NEW."item_role" IS DISTINCT FROM OLD."item_role"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'a product''s id, organization, sku, kind, role and creation time cannot be changed'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- Only SELLABLE items can be invoiced, for any writer (invoice lines are append-only, so this is checked on insert).
CREATE FUNCTION "sales_invoice_lines_item_sellable"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  role text;
BEGIN
  SELECT "item_role" INTO role FROM "products" WHERE "id" = NEW."product_id";
  IF role IS DISTINCT FROM 'SELLABLE' THEN
    RAISE EXCEPTION 'only sellable items can be invoiced' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "sales_invoice_lines_item_sellable_check"
  BEFORE INSERT ON "sales_invoice_lines"
  FOR EACH ROW EXECUTE FUNCTION "sales_invoice_lines_item_sellable"();

-- ---------------------------------------------------------------------------------------------------------
-- 2. Units: grams accept one decimal place (the column stays numeric(18,4); the unit decides what is accepted), and two new units.
-- Raising the precision never invalidates an existing whole-gram quantity. No unit conversion exists.
UPDATE "units" SET "decimal_places" = 1 WHERE "code" = 'G' AND "decimal_places" < 1;

INSERT INTO "units" ("organization_id", "code", "name", "decimal_places", "is_active", "updated_at")
SELECT o."id", 'SHEET', 'Sheet', 0, true, now()
  FROM "organizations" o
 WHERE NOT EXISTS (SELECT 1 FROM "units" u WHERE u."organization_id" = o."id" AND u."code" = 'SHEET');

INSERT INTO "units" ("organization_id", "code", "name", "decimal_places", "is_active", "updated_at")
SELECT o."id", 'SPOOL', 'Spool', 0, true, now()
  FROM "organizations" o
 WHERE NOT EXISTS (SELECT 1 FROM "units" u WHERE u."organization_id" = o."id" AND u."code" = 'SPOOL');

-- ---------------------------------------------------------------------------------------------------------
-- 3. Sales orders (manual entry; no production, no invoice link, no attachments yet).
CREATE TABLE "sales_orders" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "order_number" TEXT NOT NULL,
    "operation_id" UUID NOT NULL,
    "request_fingerprint" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "external_order_id" TEXT,
    "customer_id" UUID,
    "buyer_name" TEXT NOT NULL,
    "buyer_phone" TEXT,
    "buyer_email" TEXT,
    "billing_address_line1" TEXT,
    "billing_address_line2" TEXT,
    "billing_city" TEXT,
    "billing_state_code" VARCHAR(2),
    "billing_pin_code" VARCHAR(6),
    "shipping_address_line1" TEXT,
    "shipping_address_line2" TEXT,
    "shipping_city" TEXT,
    "shipping_state_code" VARCHAR(2),
    "shipping_pin_code" VARCHAR(6),
    "order_date" DATE NOT NULL,
    "due_date" DATE,
    "notes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "total_amount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "financial_year_id" UUID NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "correlation_id" TEXT,

    CONSTRAINT "sales_orders_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "sales_order_lines" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "order_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "product_id" UUID NOT NULL,
    "sku" TEXT NOT NULL,
    "product_name" TEXT NOT NULL,
    "unit_code" TEXT NOT NULL,
    "unit_name" TEXT NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "agreed_unit_price" DECIMAL(18,2) NOT NULL,
    "line_total" DECIMAL(18,2) NOT NULL,
    "customization" TEXT,
    "external_line_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sales_order_lines_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "sales_order_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "order_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "from_status" TEXT,
    "to_status" TEXT,
    "note" TEXT,
    "changed_fields" TEXT,
    "actor_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "correlation_id" TEXT,

    CONSTRAINT "sales_order_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "sales_orders_id_organization_id_key" ON "sales_orders"("id", "organization_id");
CREATE UNIQUE INDEX "sales_orders_organization_id_order_number_key" ON "sales_orders"("organization_id", "order_number");
CREATE UNIQUE INDEX "sales_orders_organization_id_operation_id_key" ON "sales_orders"("organization_id", "operation_id");
-- An external order id identifies one order per organization AND channel, when present.
CREATE UNIQUE INDEX "sales_orders_organization_id_channel_external_order_id_key" ON "sales_orders"("organization_id", "channel", "external_order_id") WHERE "external_order_id" IS NOT NULL;
CREATE INDEX "sales_orders_organization_id_status_due_date_idx" ON "sales_orders"("organization_id", "status", "due_date");
CREATE INDEX "sales_orders_organization_id_order_date_idx" ON "sales_orders"("organization_id", "order_date" DESC);
CREATE INDEX "sales_orders_organization_id_customer_id_idx" ON "sales_orders"("organization_id", "customer_id");
CREATE UNIQUE INDEX "sales_order_lines_order_id_line_no_key" ON "sales_order_lines"("order_id", "line_no");
CREATE UNIQUE INDEX "sales_order_lines_order_id_external_line_id_key" ON "sales_order_lines"("order_id", "external_line_id") WHERE "external_line_id" IS NOT NULL;
CREATE INDEX "sales_order_lines_organization_id_product_id_idx" ON "sales_order_lines"("organization_id", "product_id");
CREATE INDEX "sales_order_events_order_id_created_at_idx" ON "sales_order_events"("order_id", "created_at");

ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_financial_year_id_fkey" FOREIGN KEY ("financial_year_id") REFERENCES "financial_years"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_order_id_organization_id_fkey" FOREIGN KEY ("order_id", "organization_id") REFERENCES "sales_orders"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_order_events" ADD CONSTRAINT "sales_order_events_order_id_organization_id_fkey" FOREIGN KEY ("order_id", "organization_id") REFERENCES "sales_orders"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_order_events" ADD CONSTRAINT "sales_order_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "sales_orders"
  ADD CONSTRAINT "sales_orders_channel_valid" CHECK ("channel" IN ('MANUAL', 'INSTAGRAM', 'PHONE', 'AMAZON', 'FLIPKART', 'OTHER')),
  -- IN_PRODUCTION and READY are part of the vocabulary but unreachable until production exists (MTO-4); INVOICED and PAID are never stored.
  ADD CONSTRAINT "sales_orders_status_valid" CHECK ("status" IN ('DRAFT', 'CONFIRMED', 'NEEDS_INFO', 'IN_PRODUCTION', 'READY', 'CANCELLED', 'CLOSED')),
  ADD CONSTRAINT "sales_orders_order_number_present" CHECK (length(btrim("order_number")) > 0),
  ADD CONSTRAINT "sales_orders_buyer_name_present" CHECK (length(btrim("buyer_name")) > 0),
  ADD CONSTRAINT "sales_orders_external_id_present" CHECK ("external_order_id" IS NULL OR length(btrim("external_order_id")) > 0),
  ADD CONSTRAINT "sales_orders_external_id_only_for_channel" CHECK ("external_order_id" IS NULL OR "channel" <> 'MANUAL'),
  ADD CONSTRAINT "sales_orders_due_after_order" CHECK ("due_date" IS NULL OR "due_date" >= "order_date"),
  ADD CONSTRAINT "sales_orders_total_not_negative" CHECK ("total_amount" >= 0),
  ADD CONSTRAINT "sales_orders_version_positive" CHECK ("version" >= 1);

ALTER TABLE "sales_order_lines"
  ADD CONSTRAINT "sales_order_lines_quantity_positive" CHECK ("quantity" > 0),
  ADD CONSTRAINT "sales_order_lines_price_not_negative" CHECK ("agreed_unit_price" >= 0),
  ADD CONSTRAINT "sales_order_lines_total_not_negative" CHECK ("line_total" >= 0),
  ADD CONSTRAINT "sales_order_lines_line_no_positive" CHECK ("line_no" >= 1);

ALTER TABLE "sales_order_events"
  ADD CONSTRAINT "sales_order_events_type_valid" CHECK ("event_type" IN ('CREATED', 'EDITED', 'STATUS_CHANGED')),
  ADD CONSTRAINT "sales_order_events_status_shape" CHECK (
    ("event_type" = 'STATUS_CHANGED' AND "from_status" IS NOT NULL AND "to_status" IS NOT NULL)
    OR ("event_type" <> 'STATUS_CHANGED' AND "from_status" IS NULL AND "to_status" IS NULL));

-- Rules a foreign key cannot express, true for ANY writer.
-- (a) An order's customer belongs to the same organization; its financial year too.
CREATE FUNCTION "sales_orders_check"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  ref_org uuid;
BEGIN
  IF NEW."customer_id" IS NOT NULL THEN
    SELECT "organization_id" INTO ref_org FROM "customers" WHERE "id" = NEW."customer_id";
    IF ref_org IS DISTINCT FROM NEW."organization_id" THEN
      RAISE EXCEPTION 'the customer belongs to another organization' USING ERRCODE = 'foreign_key_violation';
    END IF;
  END IF;
  SELECT "organization_id" INTO ref_org FROM "financial_years" WHERE "id" = NEW."financial_year_id";
  IF ref_org IS DISTINCT FROM NEW."organization_id" THEN
    RAISE EXCEPTION 'the financial year belongs to another organization' USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "sales_orders_check_references"
  BEFORE INSERT OR UPDATE ON "sales_orders"
  FOR EACH ROW EXECUTE FUNCTION "sales_orders_check"();

-- (b) Identity never changes; orders are never deleted; CANCELLED and CLOSED are final; and a status changes only along an allowed edge.
--     The same table of edges lives in the application (@commercebill/sales-orders) and a test compares them.
CREATE FUNCTION "sales_orders_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'sales orders cannot be deleted: cancel the order instead' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
     OR NEW."order_number" IS DISTINCT FROM OLD."order_number"
     OR NEW."operation_id" IS DISTINCT FROM OLD."operation_id"
     OR NEW."request_fingerprint" IS DISTINCT FROM OLD."request_fingerprint"
     OR NEW."channel" IS DISTINCT FROM OLD."channel"
     OR NEW."external_order_id" IS DISTINCT FROM OLD."external_order_id"
     OR NEW."financial_year_id" IS DISTINCT FROM OLD."financial_year_id"
     OR NEW."created_by" IS DISTINCT FROM OLD."created_by"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'a sales order''s identity (number, channel, external id, creator, creation time) cannot be changed' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."status" IN ('CANCELLED', 'CLOSED') THEN
    RAISE EXCEPTION 'a cancelled or closed sales order cannot be changed' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
       (OLD."status" = 'DRAFT'      AND NEW."status" IN ('CONFIRMED', 'CANCELLED'))
    OR (OLD."status" = 'CONFIRMED'  AND NEW."status" IN ('NEEDS_INFO', 'CANCELLED', 'CLOSED'))
    OR (OLD."status" = 'NEEDS_INFO' AND NEW."status" IN ('CONFIRMED', 'CANCELLED'))) THEN
    RAISE EXCEPTION 'that sales order status change is not allowed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "sales_orders_guard_update"
  BEFORE UPDATE OR DELETE ON "sales_orders"
  FOR EACH ROW EXECUTE FUNCTION "sales_orders_guard"();

-- (c) Lines: the item is this organization's SELLABLE item, and lines change only while the order is editable (not CANCELLED/CLOSED).
CREATE FUNCTION "sales_order_lines_check"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  p_org uuid;
  p_role text;
  o_status text;
BEGIN
  SELECT "status" INTO o_status FROM "sales_orders" WHERE "id" = COALESCE(NEW."order_id", OLD."order_id");
  IF o_status IS NULL OR o_status IN ('CANCELLED', 'CLOSED') THEN
    RAISE EXCEPTION 'the lines of a cancelled or closed sales order cannot be changed' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  SELECT "organization_id", "item_role" INTO p_org, p_role FROM "products" WHERE "id" = NEW."product_id";
  IF p_org IS DISTINCT FROM NEW."organization_id" THEN
    RAISE EXCEPTION 'the item belongs to another organization' USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF p_role IS DISTINCT FROM 'SELLABLE' THEN
    RAISE EXCEPTION 'only sellable items can be ordered' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "sales_order_lines_check_row"
  BEFORE INSERT OR UPDATE OR DELETE ON "sales_order_lines"
  FOR EACH ROW EXECUTE FUNCTION "sales_order_lines_check"();

-- (d) The history is append-only.
CREATE FUNCTION "sales_order_events_immutable"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'sales order history cannot be changed or deleted' USING ERRCODE = 'restrict_violation';
END;
$$;
CREATE TRIGGER "sales_order_events_no_change"
  BEFORE UPDATE OR DELETE ON "sales_order_events"
  FOR EACH ROW EXECUTE FUNCTION "sales_order_events_immutable"();
CREATE TRIGGER "sales_order_events_no_truncate"
  BEFORE TRUNCATE ON "sales_order_events"
  FOR EACH STATEMENT EXECUTE FUNCTION "sales_order_events_immutable"();

-- ---------------------------------------------------------------------------------------------------------
-- 4. Numbering: every existing financial-year sequence set gains a SALES_ORDER sequence (the INVOICE sequence's width, starting at 1).
INSERT INTO "document_sequences" ("organization_id", "location_id", "financial_year_id", "document_type", "prefix", "suffix", "numeric_length", "start_number", "reset_policy", "is_active", "last_number", "updated_at")
SELECT s."organization_id", s."location_id", s."financial_year_id", 'SALES_ORDER', 'SO/{FY}/', '', s."numeric_length", 1, 'FINANCIAL_YEAR', true, 0, now()
  FROM "document_sequences" s
 WHERE s."document_type" = 'INVOICE'
   AND NOT EXISTS (
     SELECT 1 FROM "document_sequences" d
      WHERE d."organization_id" = s."organization_id" AND d."financial_year_id" = s."financial_year_id"
        AND d."document_type" = 'SALES_ORDER' AND d."location_id" IS NOT DISTINCT FROM s."location_id");
