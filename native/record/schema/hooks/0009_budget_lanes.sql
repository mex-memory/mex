ALTER TABLE deliveries ADD COLUMN lane TEXT NOT NULL DEFAULT 'legacy';
CREATE TABLE lane_offers (
 session_id TEXT NOT NULL,agent_id TEXT NOT NULL,epoch INTEGER NOT NULL,
 project_id TEXT NOT NULL,checkout TEXT NOT NULL,entry_id TEXT NOT NULL,lane TEXT NOT NULL,
 tokens INTEGER NOT NULL,budget_held INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(session_id,agent_id,epoch,project_id,checkout,entry_id,lane)
);
