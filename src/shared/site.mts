// The site's one canonical origin, shared by every layer that names it: pages' links for search engines and previews,
// calendar files' links back, push's contact, and the user agent our requests carry

export const SITE = "https://notunh.app"

/** The origin as a person reads it, without its scheme */
export const HOST = new URL(SITE).host
