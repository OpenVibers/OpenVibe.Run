-- phase: expand
-- 0015 is reserved by the open blind-fill PR. Only display text is stored; never proxy credentials.
ALTER TABLE run_sessions ADD COLUMN egress_label text;
