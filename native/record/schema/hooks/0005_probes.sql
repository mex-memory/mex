ALTER TABLE epochs ADD COLUMN intent TEXT NOT NULL DEFAULT 'working' CHECK(intent IN ('working','investigating','changing','reproducing'));
ALTER TABLE epochs ADD COLUMN closed INTEGER NOT NULL DEFAULT 0 CHECK(closed IN (0,1));
ALTER TABLE deliveries ADD COLUMN title TEXT NOT NULL DEFAULT '';
ALTER TABLE deliveries ADD COLUMN kind TEXT NOT NULL DEFAULT '';
ALTER TABLE deliveries ADD COLUMN level TEXT NOT NULL DEFAULT '';
CREATE TABLE delivery_touches (delivery_id TEXT PRIMARY KEY REFERENCES deliveries(id));
