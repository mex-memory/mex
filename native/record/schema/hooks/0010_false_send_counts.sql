ALTER TABLE epochs ADD COLUMN false_send_counted INTEGER NOT NULL DEFAULT 0 CHECK(false_send_counted IN (0,1));
