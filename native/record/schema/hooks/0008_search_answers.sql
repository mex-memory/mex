ALTER TABLE surface_windows ADD COLUMN observed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE surface_windows ADD COLUMN followup INTEGER NOT NULL DEFAULT 0 CHECK(followup IN (0,1));
ALTER TABLE surface_windows ADD COLUMN harm INTEGER NOT NULL DEFAULT 0 CHECK(harm IN (0,1));
ALTER TABLE surface_windows ADD COLUMN complete INTEGER NOT NULL DEFAULT 1 CHECK(complete IN (0,1));
ALTER TABLE surface_firings ADD COLUMN complete INTEGER NOT NULL DEFAULT 1 CHECK(complete IN (0,1));
ALTER TABLE surface_gates ADD COLUMN minimum_avoided_delta REAL NOT NULL DEFAULT 0;
ALTER TABLE surface_gates ADD COLUMN minimum_cost_sessions INTEGER NOT NULL DEFAULT 0;
ALTER TABLE surface_gates ADD COLUMN no_harm_rise INTEGER NOT NULL DEFAULT 0;
-- Qualification projections from the task cost ledger, not another token ledger.
-- The live cost producer owns writes. Offline replay never populates this table.
CREATE TABLE surface_cost_checks (
 project_id TEXT NOT NULL, surface TEXT NOT NULL, session_id TEXT NOT NULL, agent_id TEXT NOT NULL,
 net_weighted_tokens REAL NOT NULL,
 PRIMARY KEY(project_id,surface,session_id,agent_id)
);
