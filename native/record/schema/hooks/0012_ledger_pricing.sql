ALTER TABLE ledger ADD COLUMN saved_input_millitokens INTEGER CHECK(saved_input_millitokens>=0);
ALTER TABLE ledger ADD COLUMN cost_input_millitokens INTEGER CHECK(cost_input_millitokens>=0);
ALTER TABLE ledger_settlements ADD COLUMN price_profile TEXT;
