# notunh

[![notunh: a map of central UNH with a Gables Connector bus on Main Street, beside its laundry and dining screens](public/social/home.png)](https://notunh.app)

An unofficial app for UNH, at [notunh.app](https://notunh.app): live buses and directions, campus events, classes, rooms and parking, dining menus, and free laundry machines. An offline-first PWA built with Vite and [bruh](https://github.com/Technical-Source/bruh).

```sh
npm install
npm run dev           # http://localhost:5173
npm test
npm run typecheck
npm run worker        # the API on http://localhost:8787 with a local D1
```

`NOTUNH_OFFLINE=1 npm run dev` runs on the test fixtures, fetching nothing.

## Docs

- [Development](docs/development.md): layout, conventions, scripts, environment, data sources
- [Deploying](docs/deploying.md): pipeline, workflows, secrets, rollbacks, search
- [Offline](docs/offline.md): the service worker and live updates
- [Storage](docs/storage.md): every artifact and table, and your synced things
- [Map](docs/map.md): the sheet and its pages, map data, walking, place search
- [Transit](docs/transit.md): locating, forecasting, trip planning
- [Courses](docs/courses.md): sections, instructors, rooms
- [Programs](docs/programs.md): a program's courses by prerequisite
- [Parking](docs/parking.md): where a stay fits
- [Social](docs/social.md): events, pins, identity, email codes
- [Reminders](docs/reminders.md): when to leave, by Web Push
- [Worker](docs/worker.md): the API, crons, laundry
