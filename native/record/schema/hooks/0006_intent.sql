-- Only a digest is retained; command text never enters the local record.
ALTER TABLE epochs ADD COLUMN last_failure TEXT NOT NULL DEFAULT '';
