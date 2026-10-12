-- phase: expand
-- Project delegation (ADR-003 amendment 2026-10-12): the first-party service that started a job for a person in a
-- project, as a subject-ref string ('service:watch'); the person is the requester. NULL when the project's own
-- token started the job. A delegated caller reads only the jobs whose requester and via are its own.
ALTER TABLE run_jobs ADD COLUMN IF NOT EXISTS via text;
