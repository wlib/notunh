-- Applied by moving it up into worker/migrations/ once the Worker that no longer reads visits is deployed, and no
-- rollback to one before it is wanted: the Worker before it deletes from visits in the batch of its nightly prune,
-- which would fail every night without the table (docs/deploying.md, Dropping visits)
DROP TABLE `visits`;
