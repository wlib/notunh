ALTER TABLE `models` ADD `revision` text NOT NULL DEFAULT '';--> statement-breakpoint
UPDATE `models` SET `revision` = lower(hex(randomblob(16)));
