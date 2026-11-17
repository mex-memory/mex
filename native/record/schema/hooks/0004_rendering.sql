ALTER TABLE deliveries ADD COLUMN detail TEXT NOT NULL DEFAULT '';
CREATE TABLE delivery_conflicts (
 session_id TEXT NOT NULL, agent_id TEXT NOT NULL, epoch INTEGER NOT NULL,
 project_id TEXT NOT NULL, checkout TEXT NOT NULL,
 winner TEXT NOT NULL, loser TEXT NOT NULL, reason TEXT NOT NULL,
 PRIMARY KEY(session_id,agent_id,epoch,project_id,checkout,winner,loser),
 FOREIGN KEY(session_id,agent_id,epoch) REFERENCES epochs(session_id,agent_id,epoch)
);
