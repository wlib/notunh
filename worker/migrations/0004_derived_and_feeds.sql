CREATE TABLE `chunks` (
	`generation` text NOT NULL,
	`part` integer NOT NULL,
	`body` blob NOT NULL,
	PRIMARY KEY(`generation`, `part`)
);
--> statement-breakpoint
CREATE TABLE `derived` (
	`name` text NOT NULL,
	`at` integer NOT NULL,
	`identity` text NOT NULL,
	`generation` text NOT NULL,
	`parts` integer NOT NULL,
	PRIMARY KEY(`name`, `at`)
);
--> statement-breakpoint
CREATE TABLE `feeds` (
	`id` text NOT NULL,
	`acquired` integer NOT NULL,
	`source` text NOT NULL,
	`version` text NOT NULL,
	`start` text NOT NULL,
	`end` text NOT NULL,
	`feed` text NOT NULL,
	`original` blob NOT NULL
);
--> statement-breakpoint
CREATE INDEX `feeds_id` ON `feeds` (`id`);