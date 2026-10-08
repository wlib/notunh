/** A name as it's written in a path or a link, like "stoke-hall-g05" for "Stoke Hall G05" */
export const slug = (name: string) =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
