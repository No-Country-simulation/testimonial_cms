-- BORRADOR DE FASE 1 PARA REVISIÓN. NO pertenece a prisma/migrations.
-- No ejecutar ni promover sin el ACK de persistencia de la fase correspondiente.
-- Cuatro entidades OLTP. Requiere tenants, users y UNIQUE users(tenant_id,id).
-- No exportar estos objetos ni sus textos/responsables mediante bi_export.
BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE bi_kpi_goals (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    owner_id uuid NOT NULL,
    title text NOT NULL,
    metric_id text NOT NULL,
    catalog_version text NOT NULL DEFAULT 'bi_metrics_v1',
    period_from date NOT NULL,
    period_to date NOT NULL,
    filters jsonb NOT NULL,
    baseline numeric(40,12) NOT NULL,
    target numeric(40,12) NOT NULL,
    state text NOT NULL DEFAULT 'draft',
    version integer NOT NULL DEFAULT 0,
    activated_at timestamptz(3),
    closed_at timestamptz(3),
    archived_at timestamptz(3),
    closing_evaluation jsonb,
    created_at timestamptz(3) NOT NULL DEFAULT now(),
    updated_at timestamptz(3) NOT NULL DEFAULT now(),
    CONSTRAINT pk_bi_kpi_goals PRIMARY KEY (id),
    CONSTRAINT uq_bi_kpi_goals_tenant_id UNIQUE (tenant_id, id),
    CONSTRAINT fk_bi_kpi_goals_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
    CONSTRAINT fk_bi_kpi_goals_owner FOREIGN KEY (tenant_id, owner_id) REFERENCES users(tenant_id, id) ON DELETE RESTRICT ON UPDATE NO ACTION,
    CONSTRAINT ck_bi_kpi_title CHECK (char_length(btrim(title)) BETWEEN 1 AND 120),
    CONSTRAINT ck_bi_kpi_period CHECK (period_from >= DATE '0001-01-01' AND period_to <= DATE '9999-12-31' AND period_to - period_from BETWEEN 0 AND 365),
    CONSTRAINT ck_bi_kpi_version CHECK (version BETWEEN 0 AND 2147483646),
    CONSTRAINT ck_bi_kpi_catalog CHECK (catalog_version = 'bi_metrics_v1' AND metric_id IN
      ('inventory_total','inventory_draft','inventory_pending','inventory_approved','inventory_published','inventory_rejected',
       'average_rating','low_rating_share','published_share','categorized_share','tagged_share','observed_creations','views','clicks','plays','ctr')),
    CONSTRAINT ck_bi_kpi_filters CHECK (jsonb_typeof(filters) = 'object'),
    CONSTRAINT ck_bi_kpi_numbers CHECK (baseline::text NOT IN ('NaN','Infinity','-Infinity') AND target::text NOT IN ('NaN','Infinity','-Infinity') AND baseline >= 0 AND target >= 0 AND baseline <> target),
    CONSTRAINT ck_bi_kpi_metric_domain CHECK (
      CASE WHEN metric_id = 'average_rating' THEN baseline <= 5 AND target <= 5
           WHEN metric_id IN ('low_rating_share','published_share','categorized_share','tagged_share') THEN baseline <= 100 AND target <= 100
           WHEN metric_id = 'ctr' THEN true
           ELSE baseline = trunc(baseline) AND target = trunc(target) END),
    CONSTRAINT ck_bi_kpi_state CHECK (state IN ('draft','active','closed','archived')
      AND (state <> 'draft' OR activated_at IS NULL)
      AND (state NOT IN ('active','closed') OR activated_at IS NOT NULL)
      AND ((state = 'archived') = (archived_at IS NOT NULL))
      AND ((closed_at IS NULL) = (closing_evaluation IS NULL))
      AND (closing_evaluation IS NULL OR jsonb_typeof(closing_evaluation) = 'object')
      AND (closed_at IS NULL OR (activated_at IS NOT NULL AND state IN ('closed','archived')))
      AND (state <> 'closed' OR closed_at IS NOT NULL))
);
CREATE INDEX idx_bi_kpi_tenant_state ON bi_kpi_goals (tenant_id, state, period_to DESC, id DESC);
CREATE INDEX idx_bi_kpi_owner ON bi_kpi_goals (tenant_id, owner_id);

CREATE TABLE bi_objectives (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    owner_id uuid NOT NULL,
    title text NOT NULL,
    description text NOT NULL DEFAULT '',
    period_from date NOT NULL,
    period_to date NOT NULL,
    state text NOT NULL DEFAULT 'draft',
    version integer NOT NULL DEFAULT 0,
    activated_at timestamptz(3),
    closed_at timestamptz(3),
    archived_at timestamptz(3),
    closing_evaluation jsonb,
    created_at timestamptz(3) NOT NULL DEFAULT now(),
    updated_at timestamptz(3) NOT NULL DEFAULT now(),
    CONSTRAINT pk_bi_objectives PRIMARY KEY (id),
    CONSTRAINT uq_bi_objectives_tenant_id UNIQUE (tenant_id, id),
    CONSTRAINT fk_bi_objectives_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
    CONSTRAINT fk_bi_objectives_owner FOREIGN KEY (tenant_id, owner_id) REFERENCES users(tenant_id, id) ON DELETE RESTRICT ON UPDATE NO ACTION,
    CONSTRAINT ck_bi_objective_title CHECK (char_length(btrim(title)) BETWEEN 1 AND 120 AND char_length(description) <= 2000),
    CONSTRAINT ck_bi_objective_period CHECK (period_from >= DATE '0001-01-01' AND period_to <= DATE '9999-12-31' AND period_to - period_from BETWEEN 0 AND 365),
    CONSTRAINT ck_bi_objective_version CHECK (version BETWEEN 0 AND 2147483646),
    CONSTRAINT ck_bi_objective_state CHECK (state IN ('draft','active','closed','archived')
      AND (state <> 'draft' OR activated_at IS NULL)
      AND (state NOT IN ('active','closed') OR activated_at IS NOT NULL)
      AND ((state = 'archived') = (archived_at IS NOT NULL))
      AND ((closed_at IS NULL) = (closing_evaluation IS NULL))
      AND (closing_evaluation IS NULL OR jsonb_typeof(closing_evaluation) = 'object')
      AND (closed_at IS NULL OR (activated_at IS NOT NULL AND state IN ('closed','archived')))
      AND (state <> 'closed' OR closed_at IS NOT NULL))
);
CREATE INDEX idx_bi_objective_tenant_state ON bi_objectives (tenant_id, state, period_to DESC, id DESC);
CREATE INDEX idx_bi_objective_owner ON bi_objectives (tenant_id, owner_id);

CREATE TABLE bi_key_results (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    objective_id uuid NOT NULL,
    owner_id uuid NOT NULL,
    title text NOT NULL,
    kind text NOT NULL,
    metric_id text,
    catalog_version text,
    filters jsonb,
    manual_unit text,
    baseline numeric(40,12) NOT NULL,
    target numeric(40,12) NOT NULL,
    version integer NOT NULL DEFAULT 0,
    created_at timestamptz(3) NOT NULL DEFAULT now(),
    updated_at timestamptz(3) NOT NULL DEFAULT now(),
    CONSTRAINT pk_bi_key_results PRIMARY KEY (id),
    CONSTRAINT uq_bi_results_tenant_id UNIQUE (tenant_id, id),
    CONSTRAINT uq_bi_results_progress_parent UNIQUE (tenant_id, objective_id, id, kind),
    CONSTRAINT fk_bi_results_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
    CONSTRAINT fk_bi_results_objective FOREIGN KEY (tenant_id, objective_id) REFERENCES bi_objectives(tenant_id, id) ON DELETE RESTRICT ON UPDATE NO ACTION,
    CONSTRAINT fk_bi_results_owner FOREIGN KEY (tenant_id, owner_id) REFERENCES users(tenant_id, id) ON DELETE RESTRICT ON UPDATE NO ACTION,
    CONSTRAINT ck_bi_result_title CHECK (char_length(btrim(title)) BETWEEN 1 AND 120),
    CONSTRAINT ck_bi_result_version CHECK (version BETWEEN 0 AND 2147483646),
    CONSTRAINT ck_bi_result_numbers CHECK (baseline::text NOT IN ('NaN','Infinity','-Infinity') AND target::text NOT IN ('NaN','Infinity','-Infinity') AND baseline <> target),
    -- CASE avoids accepting UNKNOWN when a required configuration field is NULL.
    CONSTRAINT ck_bi_result_configuration CHECK (CASE kind
      WHEN 'manual' THEN metric_id IS NULL AND catalog_version IS NULL AND filters IS NULL
        AND manual_unit IS NOT NULL AND manual_unit IN ('count','percentage','number')
      WHEN 'automatic' THEN manual_unit IS NULL AND metric_id IS NOT NULL AND catalog_version IS NOT NULL
        AND filters IS NOT NULL AND jsonb_typeof(filters) = 'object' AND catalog_version = 'bi_metrics_v1'
        AND metric_id IN ('inventory_total','inventory_draft','inventory_pending','inventory_approved','inventory_published','inventory_rejected',
          'average_rating','low_rating_share','published_share','categorized_share','tagged_share','observed_creations','views','clicks','plays','ctr')
      ELSE false END),
    CONSTRAINT ck_bi_result_metric_domain CHECK (CASE
      WHEN kind = 'manual' AND manual_unit = 'number' THEN true
      WHEN kind = 'manual' AND manual_unit = 'count' THEN baseline >= 0 AND target >= 0 AND baseline = trunc(baseline) AND target = trunc(target)
      WHEN kind = 'manual' THEN baseline >= 0 AND target >= 0
      WHEN metric_id = 'average_rating' THEN baseline BETWEEN 0 AND 5 AND target BETWEEN 0 AND 5
      WHEN metric_id IN ('low_rating_share','published_share','categorized_share','tagged_share') THEN baseline BETWEEN 0 AND 100 AND target BETWEEN 0 AND 100
      WHEN metric_id = 'ctr' THEN baseline >= 0 AND target >= 0
      ELSE baseline >= 0 AND target >= 0 AND baseline = trunc(baseline) AND target = trunc(target) END)
);
CREATE INDEX idx_bi_result_objective ON bi_key_results (tenant_id, objective_id, created_at, id);
CREATE INDEX idx_bi_result_owner ON bi_key_results (tenant_id, owner_id);

CREATE TABLE bi_progress_entries (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    objective_id uuid NOT NULL,
    key_result_id uuid NOT NULL,
    result_kind text NOT NULL DEFAULT 'manual',
    recorded_by_id uuid NOT NULL,
    value numeric(40,12) NOT NULL,
    effective_date date NOT NULL,
    comment text NOT NULL,
    recorded_at timestamptz(3) NOT NULL DEFAULT now(),
    CONSTRAINT pk_bi_progress_entries PRIMARY KEY (id),
    CONSTRAINT fk_bi_progress_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
    CONSTRAINT fk_bi_progress_result FOREIGN KEY (tenant_id, objective_id, key_result_id, result_kind)
      REFERENCES bi_key_results(tenant_id, objective_id, id, kind) ON DELETE RESTRICT ON UPDATE NO ACTION,
    CONSTRAINT fk_bi_progress_recorder FOREIGN KEY (tenant_id, recorded_by_id) REFERENCES users(tenant_id, id) ON DELETE RESTRICT ON UPDATE NO ACTION,
    CONSTRAINT ck_bi_progress_manual CHECK (result_kind = 'manual'),
    CONSTRAINT ck_bi_progress_value CHECK (value::text NOT IN ('NaN','Infinity','-Infinity')),
    CONSTRAINT ck_bi_progress_date CHECK (effective_date BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'),
    CONSTRAINT ck_bi_progress_comment CHECK (char_length(btrim(comment)) BETWEEN 1 AND 2000)
);
CREATE INDEX idx_bi_progress_result ON bi_progress_entries
  (tenant_id, objective_id, key_result_id, result_kind, effective_date DESC, recorded_at DESC, id DESC);
CREATE INDEX idx_bi_progress_recorder ON bi_progress_entries (tenant_id, recorded_by_id);

-- Enforce append-only even if a runtime identity is accidentally over-granted.
-- Corrections append a replacement observation; previous entries remain auditable.
CREATE FUNCTION bi_reject_progress_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'BI_PROGRESS_IMMUTABLE';
END;
$$;
CREATE TRIGGER bi_progress_append_only BEFORE UPDATE OR DELETE ON bi_progress_entries
  FOR EACH ROW EXECUTE FUNCTION bi_reject_progress_change();

REVOKE ALL ON bi_kpi_goals, bi_objectives, bi_key_results, bi_progress_entries FROM PUBLIC;
REVOKE ALL ON FUNCTION bi_reject_progress_change() FROM PUBLIC;
-- Runtime OLTP: SELECT/INSERT/UPDATE on goals/objectives/results;
-- SELECT/INSERT only on progress; existing audit_logs and scoped idempotency remain.
-- No privileges on these four tables for BI export, warehouse reader, worker or control.
-- Date within parent's period, role/assignment, lifecycle freeze, catalog/filter
-- validation, CAS and transactional audit are service invariants (phase 3).
COMMIT;
