CREATE TABLE ledger_trials (
 session_id TEXT PRIMARY KEY REFERENCES sessions(session_id),
 trial TEXT NOT NULL CHECK(length(trial)=32),
 holdout INTEGER NOT NULL CHECK(holdout IN (0,1))
);

CREATE TABLE ledger_session_metrics (
 session_id TEXT PRIMARY KEY REFERENCES ledger_settlements(session_id),
 model TEXT NOT NULL CHECK(length(model) BETWEEN 1 AND 128),
 requests INTEGER NOT NULL CHECK(requests BETWEEN 1 AND 32000),
 spend_input_millitokens INTEGER NOT NULL CHECK(spend_input_millitokens BETWEEN 0 AND 281474976710656),
 end_input_tokens INTEGER NOT NULL CHECK(end_input_tokens BETWEEN 1 AND 2000000),
 mex_context_tokens INTEGER CHECK(mex_context_tokens BETWEEN 0 AND end_input_tokens),
 trial TEXT CHECK(length(trial)=32),
 holdout INTEGER CHECK(holdout IN (0,1)),
 CHECK((trial IS NULL)=(holdout IS NULL))
);

CREATE TABLE ledger_context (
 session_id TEXT NOT NULL REFERENCES sessions(session_id),
 ts TEXT NOT NULL,
 tokens INTEGER NOT NULL CHECK(tokens BETWEEN 0 AND 2000000),
 at_start INTEGER NOT NULL CHECK(at_start IN (0,1))
);
CREATE INDEX ledger_context_session ON ledger_context(session_id);
