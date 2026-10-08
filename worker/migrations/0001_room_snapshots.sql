CREATE TABLE `room_snapshots` (
	`room` text PRIMARY KEY NOT NULL,
	`at` integer NOT NULL,
	`machines` text NOT NULL
);
