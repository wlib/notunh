// The Worker's bindings, vars and secrets, as wrangler.jsonc declares them

export type Env = {
  DB:                     D1Database,
  /** The built site, for the pages the Worker answers for itself */
  ASSETS:                 Fetcher,
  /** How many days of laundry's transitions and polls the nightly run keeps */
  RETAIN_DAYS:            number,
  /** How many days of samples it keeps once the observations archive has their day (src/transit/observations/archive.mts) */
  RETAIN_ARCHIVED_DAYS:   number,
  /** How many days of the visits extracted from the observations it keeps */
  RETAIN_VISIT_DAYS:      number,
  /** How many days of daily statistics and evaluations it keeps */
  RETAIN_STATISTICS_DAYS: number,
  /** Lets the workflows read and write rows and models through /api/, so they need no D1 credentials, a secret */
  BUILD_TOKEN?:           string,
  /** A GitHub token that can start the workflows, a secret, for the nightly run to start them */
  GITHUB_TOKEN?:          string,
  /** Each device's reminders (reminders.mts), where they're set up, which Previews aren't */
  REMINDERS?:             DurableObjectNamespace,
  /** The VAPID key pair reminders are pushed with (push.mts), base64url, both secrets */
  VAPID_PUBLIC_KEY?:      string,
  VAPID_PRIVATE_KEY?:     string,
  /** Who push services can reach about our pushes, a mailto: or https: URL */
  VAPID_SUBJECT?:         string,
  /** How many reminders may be set from one address a minute (api.mts), a Rate Limiting binding, or none to not bound it */
  RATE_LIMIT?:            RateLimit
}
