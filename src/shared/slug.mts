/** A name as it's written in a path or a link, like "stoke-hall-g05" for "Stoke Hall G05" */
export const slug = (name: string) =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")

/** A value as a path's segment: its spaces as +, a colon as it is, and anything else a segment can't hold escaped */
export const segmentOf = (value: string) =>
  encodeURIComponent(value).replaceAll("%20", "+").replaceAll("%3A", ":")
