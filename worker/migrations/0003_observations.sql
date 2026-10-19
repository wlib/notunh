CREATE TABLE `summaries` (
	`at` integer PRIMARY KEY NOT NULL,
	`version` integer NOT NULL,
	`extractor` integer NOT NULL,
	`state` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `visits` ADD `spread` text;--> statement-breakpoint
ALTER TABLE `visits` ADD `dwelled` real;--> statement-breakpoint
ALTER TABLE `visits` ADD `flags` integer;--> statement-breakpoint
ALTER TABLE `visits` ADD `profile` text;--> statement-breakpoint
ALTER TABLE `visits` ADD `extractor` integer;