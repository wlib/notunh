CREATE TABLE `latest` (
	`machine` text PRIMARY KEY NOT NULL,
	`room` text NOT NULL,
	`kind` text NOT NULL,
	`number` text NOT NULL,
	`model` text NOT NULL,
	`stack` text,
	`status` text NOT NULL,
	`raw` text NOT NULL,
	`at` integer NOT NULL,
	`reported` integer NOT NULL,
	`remaining` integer NOT NULL,
	`cycle` text
);
--> statement-breakpoint
CREATE TABLE `models` (
	`name` text NOT NULL,
	`through` text NOT NULL,
	`state` text NOT NULL,
	PRIMARY KEY(`name`, `through`)
);
--> statement-breakpoint
CREATE TABLE `polls` (
	`at` integer PRIMARY KEY NOT NULL,
	`failed` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `samples` (
	`source` text NOT NULL,
	`at` integer NOT NULL,
	`body` blob NOT NULL,
	PRIMARY KEY(`source`, `at`)
);
--> statement-breakpoint
CREATE TABLE `transitions` (
	`machine` text NOT NULL,
	`room` text NOT NULL,
	`at` integer NOT NULL,
	`status` text NOT NULL,
	`raw` text NOT NULL,
	`remaining` integer NOT NULL,
	`cycle` text
);
--> statement-breakpoint
CREATE INDEX `transitions_at` ON `transitions` (`at`);--> statement-breakpoint
CREATE TABLE `visits` (
	`vehicle` text NOT NULL,
	`route` text NOT NULL,
	`stop` text NOT NULL,
	`arrive` real NOT NULL,
	`depart` real NOT NULL,
	`trip` text,
	`position` integer,
	`is_end` integer,
	`scheduled` real,
	`from` text,
	`meters` real,
	`left` real,
	`got_in` real,
	`umo` text,
	PRIMARY KEY(`vehicle`, `arrive`)
);
--> statement-breakpoint
CREATE INDEX `visits_arrive` ON `visits` (`arrive`);