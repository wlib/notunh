CREATE TABLE `devices` (
	`id` text PRIMARY KEY NOT NULL,
	`secret` text NOT NULL,
	`person` text NOT NULL,
	`push` text,
	`created` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `devices_person` ON `devices` (`person`);--> statement-breakpoint
CREATE TABLE `emails` (
	`address` text PRIMARY KEY NOT NULL,
	`person` text,
	`verified` integer,
	`pending` text,
	`code` text,
	`expires` integer,
	`tries` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `emails_person` ON `emails` (`person`);--> statement-breakpoint
CREATE TABLE `going` (
	`pin` text NOT NULL,
	`device` text NOT NULL,
	PRIMARY KEY(`pin`, `device`)
);
--> statement-breakpoint
CREATE TABLE `links` (
	`code` text PRIMARY KEY NOT NULL,
	`device` text NOT NULL,
	`expires` integer NOT NULL,
	`linked` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE `marks` (
	`pin` text NOT NULL,
	`device` text NOT NULL,
	`time` integer NOT NULL,
	PRIMARY KEY(`pin`, `device`, `time`)
);
--> statement-breakpoint
CREATE TABLE `pins` (
	`id` text PRIMARY KEY NOT NULL,
	`person` text NOT NULL,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`place` text,
	`where` text NOT NULL,
	`start` integer NOT NULL,
	`end` integer NOT NULL,
	`times` text NOT NULL,
	`chosen` integer,
	`spots` integer,
	`visibility` text NOT NULL,
	`created` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `pins_end` ON `pins` (`end`);--> statement-breakpoint
CREATE INDEX `pins_person` ON `pins` (`person`);--> statement-breakpoint
CREATE TABLE `reports` (
	`pin` text NOT NULL,
	`device` text NOT NULL,
	PRIMARY KEY(`pin`, `device`)
);
