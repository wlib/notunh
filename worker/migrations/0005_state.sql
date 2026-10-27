CREATE TABLE `state` (
	`person` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`at` integer NOT NULL,
	`by` text NOT NULL,
	PRIMARY KEY(`person`, `key`)
);
