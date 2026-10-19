ALTER TABLE `models` ADD `revision` text NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE `models` ADD `written` integer NOT NULL DEFAULT 0;--> statement-breakpoint
UPDATE `models` SET `revision` = lower(hex(randomblob(16))), `written` = (SELECT count(*) FROM `models` AS `before` WHERE `before`.`name` = `models`.`name` AND `before`.`through` <= `models`.`through`);
