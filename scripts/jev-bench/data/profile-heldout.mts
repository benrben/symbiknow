/** New independent documents and answer keys; never used to choose a threshold. */
export const profileHeldout = [
  { id: 'orchard', topics: [{ topic: 'Tree pruning', truth: true }, { topic: 'Drip irrigation', truth: true }, { topic: 'Bookkeeping', truth: false }] },
  { id: 'museum', topics: [{ topic: 'Collection cataloguing', truth: true }, { topic: 'Museum storage', truth: true }, { topic: 'Catering', truth: false }] },
  { id: 'sailing', topics: [{ topic: 'Coastal navigation', truth: true }, { topic: 'Boat safety', truth: true }, { topic: 'Graphic design', truth: false }] },
  { id: 'drainage', topics: [{ topic: 'Rain gardens', truth: true }, { topic: 'Stormwater drainage', truth: true }, { topic: 'Payroll', truth: false }] },
  { id: 'theatre', topics: [{ topic: 'Stage rigging', truth: true }, { topic: 'Emergency evacuation', truth: true }, { topic: 'Ticket pricing', truth: false }] },
  { id: 'bread', topics: [{ topic: 'Sourdough starters', truth: true }, { topic: 'Bread fermentation', truth: true }, { topic: 'Photography', truth: false }] },
  { id: 'wildlife', topics: [{ topic: 'Bird monitoring', truth: true }, { topic: 'Field data collection', truth: true }, { topic: 'School timetables', truth: false }] },
  { id: 'observatory', topics: [{ topic: 'Telescope alignment', truth: true }, { topic: 'Optical maintenance', truth: true }, { topic: 'Travel insurance', truth: false }] },
  { id: 'apprentice', topics: [{ topic: 'Woodworking joinery', truth: true }, { topic: 'Tool maintenance', truth: true }, { topic: 'Language classes', truth: false }] },
  { id: 'archive', topics: [{ topic: 'Photo digitisation', truth: true }, { topic: 'Digital preservation', truth: true }, { topic: 'Garden planting', truth: false }] },
] as const;
