// Structured data, only of the kinds Google shows something for: the site's name and logo on the home page (WebSite,
// Organization), the trail to a page (BreadcrumbList), and an official event's when and where (Event), which makes
// it eligible for Google's events (https://developers.google.com/search/docs/appearance/structured-data/event).
// Nothing is said that isn't known: an event is described only at a place the map knows in Durham, its organizer only
// where its calendar says who that is, and never what it costs

import type { BreadcrumbList, Event as EventThing, Organization, WebSite, WithContext } from "schema-dts"
import type { Event, Source } from "../social/event.mts"
import type { GazetteerPlace } from "../places/gazetteer.mts"
import { chapterNamed } from "../places/chapters.mts"
import { distance } from "../geo/projection.mts"
import { isoOf } from "../shared/time.mts"

const CONTEXT = "https://schema.org"

/** A step of the trail to a page: its name, and its address, which the page itself needn't give */
export type Crumb = { name: string, url?: string }

export const breadcrumbsOf = (trail: readonly Crumb[]): WithContext<BreadcrumbList> => ({
  "@context":      CONTEXT,
  "@type":         "BreadcrumbList",
  itemListElement: trail.map(({ name, url }, index) => ({ "@type": "ListItem", position: index + 1, name, ...url && { item: url } }))
})

/** The site, by the names people type for it, and who makes it, with its logo */
export const siteDataOf = ({ name, alternateNames, url, logo, sameAs, founder }: {
  name:           string,
  alternateNames: string[],
  url:            string,
  logo:           string,
  sameAs:         string[],
  founder:        { name: string, url: string }
}): [WithContext<WebSite>, WithContext<Organization>] => [
  { "@context": CONTEXT, "@type": "WebSite", name, alternateName: alternateNames, url },
  { "@context": CONTEXT, "@type": "Organization", name, alternateName: alternateNames, url, logo, sameAs, founder: { "@type": "Person", ...founder, sameAs: founder.url } }
]

/** Who runs the events of a calendar where that's one body; a club's own on Wildcat Link isn't named in it */
const ORGANIZERS: Partial<Record<Source, { name: string, url: string }>> = {
  "athletics": { name: "UNH Athletics", url: "https://unhwildcats.com" },
  "25live":    { name: "University of New Hampshire", url: "https://www.unh.edu" },
  "dserec":    { name: "UNH Club Sports", url: "https://unh.dserec.com/online/clubsports" }
}

/** The middle of campus, and how far from it a place is still in Durham, whose address it's given */
const CAMPUS = { lat: 43.1365, lon: -70.9345 }
const DURHAM_METERS = 5000

/** Where Durham's places are, by the town's own post office */
const DURHAM = { addressLocality: "Durham", addressRegion: "NH", postalCode: "03824", addressCountry: "US" }

/**
 * An official event's structured data, at its place, as its page and card are at their addresses, or none for one the
 * map doesn't place in Durham, or that someone made here, which is theirs and not for search
 */
export const eventDataOf = ({ event, place, url, image, description }: {
  event:       Event,
  place:       Pick<GazetteerPlace, "name" | "at"> | undefined,
  url:         string,
  image:       string,
  description: string
}): WithContext<EventThing> | undefined => {
  if (!place || event.source === "pin" || event.source === "course" || distance({ lon: place.at[0], lat: place.at[1] }, CAMPUS) > DURHAM_METERS)
    return
  const street = chapterNamed(place.name)?.house?.address
  const organizer = ORGANIZERS[event.source]
  return {
    "@context":          CONTEXT,
    "@type":             "Event",
    name:                event.title,
    startDate:           isoOf(event.start),
    ...event.end > event.start && { endDate: isoOf(event.end) },
    eventStatus:         "https://schema.org/EventScheduled",
    eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
    location:            { "@type": "Place", name: place.name, address: { "@type": "PostalAddress", ...street && { streetAddress: street }, ...DURHAM } },
    description,
    image:               [image],
    url,
    ...organizer && { organizer: { "@type": "Organization", ...organizer } }
  }
}
