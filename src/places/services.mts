// The few ways to reserve or borrow something that belong to one place and aren't a room to book, each a line on
// that place's page: Hamel's racquetball and squash courts, which Campus Rec books apart from its schedule, and the
// library's equipment at Dimond's Info Desk. Kept by hand and short: only where it's how it's done there, never a
// building's list of offices and services

export type Service = { place: string, label: string, url: string }

export const SERVICES: readonly Service[] = [
  { place: "Hamel Rec Center", label: "Book a racquetball or squash court", url: "https://crec.unh.edu/booking" },
  { place: "Dimond Library",   label: "Borrow equipment at the Info Desk", url: "https://library.unh.edu/services/computers-printing/equipment" }
]

/** The ways to reserve or borrow something at a place, by its gazetteer name */
export const servicesAt = (place: string) =>
  SERVICES.filter(service => service.place === place)
