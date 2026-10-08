/** Independent synthetic filing fixtures. No application, customer, or Atlas document data. */
export type HeldoutPeer = { title: string; sections: string[] };
export type HeldoutGroup = { id: string; name: string; definition: string; peers: [HeldoutPeer, HeldoutPeer] };
export type HeldoutFilingCase = {
  id: string; domain: string; source: { title: string; content: string };
  groups: [HeldoutGroup, HeldoutGroup, HeldoutGroup]; expectedGroup: string | null;
};

function group(id: string, name: string, definition: string, first: HeldoutPeer, second: HeldoutPeer): HeldoutGroup {
  return { id: 'custom:' + id, name, definition, peers: [first, second] };
}
function source(title: string, sections: Array<[string, string]>) {
  return { title, content: '# ' + title + '\n\n' + sections.map(([heading, body]) => '## ' + heading + '\n' + body).join('\n\n') };
}
function placement(id: string, domain: string, document: HeldoutFilingCase['source'], groups: HeldoutFilingCase['groups'], expectedIndex: number): HeldoutFilingCase {
  return { id, domain, source: document, groups, expectedGroup: groups[expectedIndex].id };
}

const astronomy: HeldoutFilingCase['groups'] = [
  group('sky-measurements', 'Observational astronomy', 'Observing celestial objects and recording sky measurements, including photometry and observing plans.',
    { title: 'Variable-star observing log', sections: ['Comparison stars', 'Brightness measurements'] },
    { title: 'A night of lunar observations', sections: ['Observation planning', 'Crater sketches'] }),
  group('optical-care', 'Optical equipment care', 'Maintaining telescopes, lenses, mounts, and observatory equipment rather than interpreting sky observations.',
    { title: 'Lens storage checklist', sections: ['Cleaning records', 'Storage cases'] },
    { title: 'Mount maintenance notebook', sections: ['Hardware inspections', 'Replacement parts'] }),
  group('star-events', 'Public astronomy events', 'Organizing public stargazing sessions, visitor talks, and outreach activities.',
    { title: 'Family stargazing evening', sections: ['Volunteer rota', 'Visitor activities'] },
    { title: 'School visit programme', sections: ['Talk schedule', 'Group arrivals'] }),
];
const beekeeping: HeldoutFilingCase['groups'] = [
  group('honey-processing', 'Honey processing', 'Extracting harvested honey, preparing jars, and maintaining harvest batch records.',
    { title: 'Harvest room notebook', sections: ['Extraction batches', 'Jar labels'] },
    { title: 'Honey settling records', sections: ['Batch identifiers', 'Packaging checks'] }),
  group('colony-care', 'Colony husbandry', 'Inspecting and caring for honeybee colonies, including colony growth, queens, and seasonal hive management.',
    { title: 'Queen and brood inspection log', sections: ['Brood pattern', 'Colony growth'] },
    { title: 'Seasonal hive planning', sections: ['Swarm observations', 'Winter colony notes'] }),
  group('apiary-visitors', 'Apiary visitor programmes', 'Scheduling apiary tours, educational demonstrations, and volunteer visitor arrangements.',
    { title: 'Apiary open day', sections: ['Tour sessions', 'Visitor questions'] },
    { title: 'School demonstration plan', sections: ['Activities', 'Volunteer assignments'] }),
];
const ceramics: HeldoutFilingCase['groups'] = [
  group('kiln-management', 'Kiln management', 'Planning kiln loads, firing schedules, and kiln equipment records.',
    { title: 'Kiln loading journal', sections: ['Shelf layout', 'Firing schedule'] },
    { title: 'Kiln equipment checks', sections: ['Maintenance log', 'Loading space'] }),
  group('pottery-shows', 'Pottery exhibitions', 'Selecting, displaying, and describing finished ceramic pieces for exhibitions.',
    { title: 'Ceramics gallery plan', sections: ['Display positions', 'Object labels'] },
    { title: 'Pottery show catalogue', sections: ['Artist statements', 'Exhibited pieces'] }),
  group('glaze-development', 'Glaze development', 'Formulating and comparing ceramic glazes using recipes, test tiles, and surface observations.',
    { title: 'Glaze recipe notebook', sections: ['Recipe versions', 'Test tile results'] },
    { title: 'Surface comparison worksheet', sections: ['Colour samples', 'Texture observations'] }),
];
const oralHistory: HeldoutFilingCase['groups'] = [
  group('oral-interviews', 'Oral-history interviews', 'Preparing, conducting, and reviewing interviews about remembered experiences and personal histories.',
    { title: 'Interview preparation guide', sections: ['Conversation prompts', 'Participant consent'] },
    { title: 'Interviewer reflection notebook', sections: ['Follow-up questions', 'Interview summaries'] }),
  group('archive-storage', 'Digital archive stewardship', 'Cataloguing recorded files, managing archive storage, and checking long-term preservation copies.',
    { title: 'Archive copy register', sections: ['File identifiers', 'Preservation copies'] },
    { title: 'Collection catalogue procedure', sections: ['Metadata fields', 'Storage locations'] }),
  group('history-events', 'History event programming', 'Planning local-history exhibitions, lectures, and community event schedules.',
    { title: 'Local-history lecture series', sections: ['Speaker programme', 'Event dates'] },
    { title: 'Community exhibition plan', sections: ['Visitor route', 'Display timetable'] }),
];
const navigation: HeldoutFilingCase['groups'] = [
  group('boat-care', 'Boat maintenance', 'Inspecting and maintaining boat equipment, hulls, and fittings.',
    { title: 'Deck fittings checklist', sections: ['Inspection notes', 'Repair records'] },
    { title: 'Hull care notebook', sections: ['Surface work', 'Maintenance schedule'] }),
  group('coastal-pilotage', 'Coastal pilotage', 'Planning coastal passages with charts, bearings, landmarks, and route notes.',
    { title: 'Harbour approach notes', sections: ['Chart landmarks', 'Approach bearings'] },
    { title: 'Coastal passage worksheet', sections: ['Waypoints', 'Route alternatives'] }),
  group('regatta-events', 'Regatta organization', 'Organizing sailing races, entrant registration, and shore-side event arrangements.',
    { title: 'Club regatta plan', sections: ['Race programme', 'Entrant registration'] },
    { title: 'Regatta volunteer handbook', sections: ['Shore assignments', 'Event communications'] }),
];
const woodworking: HeldoutFilingCase['groups'] = [
  group('wood-finishes', 'Furniture finishing', 'Choosing and comparing surface finishes for completed wooden furniture.',
    { title: 'Finish sample board', sections: ['Surface colours', 'Finish comparisons'] },
    { title: 'Furniture surface notebook', sections: ['Sample descriptions', 'Appearance records'] }),
  group('workshop-logistics', 'Workshop logistics', 'Organizing workshop bookings, material deliveries, and shared workspace arrangements.',
    { title: 'Studio booking rota', sections: ['Bench reservations', 'Opening schedule'] },
    { title: 'Material delivery plan', sections: ['Delivery dates', 'Storage allocation'] }),
  group('wood-joinery', 'Woodworking joinery', 'Designing, fitting, and evaluating joints used to assemble wooden objects.',
    { title: 'Mortise-and-tenon practice', sections: ['Joint layout', 'Trial fitting'] },
    { title: 'Dovetail comparison notebook', sections: ['Joint geometry', 'Fit observations'] }),
];
const baking: HeldoutFilingCase['groups'] = [
  group('bread-craft', 'Bread baking', 'Preparing bread dough, maintaining starters, and recording mixing, shaping, and fermentation experiments.',
    { title: 'Starter observation journal', sections: ['Feeding records', 'Fermentation notes'] },
    { title: 'Loaf shaping workshop', sections: ['Dough handling', 'Loaf comparisons'] }),
  group('dining-service', 'Dining service', 'Arranging dining-room bookings, menus, table service, and guest seating.',
    { title: 'Dining-room service rota', sections: ['Seating plan', 'Service assignments'] },
    { title: 'Dinner booking ledger', sections: ['Table reservations', 'Guest arrangements'] }),
  group('kitchen-equipment', 'Kitchen equipment records', 'Inventorying kitchen tools and recording equipment upkeep and replacement.',
    { title: 'Kitchen tool inventory', sections: ['Utensil register', 'Replacement notes'] },
    { title: 'Mixer upkeep notebook', sections: ['Inspection records', 'Equipment history'] }),
];
const gardening: HeldoutFilingCase['groups'] = [
  group('bird-surveys', 'Bird surveys', 'Observing birds and recording species, locations, and repeated field counts.',
    { title: 'Garden bird count', sections: ['Species observations', 'Survey dates'] },
    { title: 'Nesting observation log', sections: ['Observation locations', 'Field notes'] }),
  group('vegetable-growing', 'Vegetable growing', 'Planning and caring for vegetable crops, including planting, supports, crop rotations, and harvest records.',
    { title: 'Vegetable plot rotation', sections: ['Crop families', 'Bed planning'] },
    { title: 'Seedling transplant journal', sections: ['Planting observations', 'Crop progress'] }),
  group('park-programmes', 'Park visitor programmes', 'Arranging guided walks, visitor activities, and public events in parks.',
    { title: 'Weekend park walks', sections: ['Visitor routes', 'Guide rota'] },
    { title: 'Park activity calendar', sections: ['Event programme', 'Public information'] }),
];
const choir: HeldoutFilingCase['groups'] = [
  group('concert-logistics', 'Concert logistics', 'Arranging venues, audience admission, and schedules for concerts.',
    { title: 'Concert venue checklist', sections: ['Room arrangements', 'Audience access'] },
    { title: 'Evening concert timetable', sections: ['Arrival times', 'Stage schedule'] }),
  group('instrument-upkeep', 'Instrument upkeep', 'Recording the storage, inspection, and maintenance of musical instruments.',
    { title: 'Piano maintenance register', sections: ['Service appointments', 'Inspection notes'] },
    { title: 'Instrument storage guide', sections: ['Storage locations', 'Equipment checks'] }),
  group('choral-practice', 'Choral rehearsal', 'Rehearsing ensemble singing, including entries, phrasing, pronunciation, and vocal balance.',
    { title: 'Section rehearsal notes', sections: ['Entries', 'Vowel agreement'] },
    { title: 'Ensemble phrasing worksheet', sections: ['Phrase shapes', 'Voice balance'] }),
];
const geology: HeldoutFilingCase['groups'] = [
  group('field-geology', 'Field geology', 'Mapping and describing rocks, geological layers, and landforms observed in the field.',
    { title: 'Outcrop mapping notebook', sections: ['Layer descriptions', 'Sketch maps'] },
    { title: 'Rock identification fieldbook', sections: ['Specimen observations', 'Location notes'] }),
  group('lab-equipment', 'Laboratory equipment care', 'Recording laboratory instrument inventory, inspection, and upkeep.',
    { title: 'Microscope equipment log', sections: ['Instrument checks', 'Service records'] },
    { title: 'Laboratory inventory', sections: ['Equipment identifiers', 'Storage locations'] }),
  group('science-outreach', 'Science outreach events', 'Preparing public science talks, exhibits, and school activity sessions.',
    { title: 'Science fair programme', sections: ['Demonstration schedule', 'Visitor activities'] },
    { title: 'School science visit', sections: ['Session plans', 'Volunteer rota'] }),
];
const cycling: HeldoutFilingCase['groups'] = [
  group('cycle-routes', 'Cycle route planning', 'Comparing cycling routes using destinations, map connections, and journey preferences.',
    { title: 'Town cycling route notes', sections: ['Map connections', 'Route alternatives'] },
    { title: 'Weekend ride planning', sections: ['Destinations', 'Journey stages'] }),
  group('bicycle-upkeep', 'Bicycle upkeep', 'Inspecting, adjusting, and maintaining bicycles and their components.',
    { title: 'Bicycle service notebook', sections: ['Component checks', 'Adjustment records'] },
    { title: 'Wheel and chain inspection', sections: ['Wear observations', 'Service history'] }),
  group('cycling-outreach', 'Cycling club outreach', 'Organizing cycling-club membership events, introductions, and public activities.',
    { title: 'New member welcome ride', sections: ['Introductions', 'Event arrangements'] },
    { title: 'Cycling club open day', sections: ['Visitor programme', 'Volunteer assignments'] }),
];
const weaving: HeldoutFilingCase['groups'] = [
  group('yarn-catalogue', 'Yarn stock cataloguing', 'Cataloguing yarn supplies by material, colour, quantity, and storage location.',
    { title: 'Yarn stock register', sections: ['Material identifiers', 'Stock quantities'] },
    { title: 'Textile supply catalogue', sections: ['Colour ranges', 'Storage locations'] }),
  group('textile-displays', 'Textile exhibition planning', 'Choosing and displaying textiles for exhibitions and preparing object descriptions.',
    { title: 'Textile gallery display', sections: ['Exhibit positions', 'Object descriptions'] },
    { title: 'Weaving exhibition catalogue', sections: ['Displayed works', 'Visitor labels'] }),
  group('loom-weaving', 'Loom weaving', 'Preparing looms and producing woven cloth through warp arrangement, threading, and weave patterns.',
    { title: 'Warp preparation notebook', sections: ['Warp arrangement', 'Threading order'] },
    { title: 'Weave pattern samples', sections: ['Pattern drafts', 'Cloth observations'] }),
];

export const filingHeldout: HeldoutFilingCase[] = [
  placement('star-brightness', 'astronomy', source('Comparing nightly star brightness', [
    ['Observation sequence', 'The observers record images of the same variable star and nearby comparison stars on successive evenings. Each observing entry identifies the field and the images used for comparison.'],
    ['Brightness comparison', 'The notebook compares the variable star with the reference stars and records the resulting brightness trend. Observations from successive evenings are plotted on the same brightness chart.'],
  ]), astronomy, 0),
  placement('spring-hive', 'beekeeping', source('Spring hive inspection journal', [
    ['Brood and colony growth', 'Each visit records the brood pattern, the queen observation, and the growth of the colony. The entries compare changes across the hives during spring.'],
    ['Next inspection', 'The keeper lists colony observations to revisit and records notes about colony space and swarming activity. Each entry refers to the same colony across successive inspections.'],
  ]), beekeeping, 1),
  placement('glaze-tiles', 'ceramics', source('Comparing glaze recipe test tiles', [
    ['Recipe versions', 'The studio labels a series of test tiles with their glaze recipe identifiers. The notes track which recipe was applied to each clay sample.'],
    ['Surface observations', 'After the samples are available, the potter compares colour, texture, and coverage across the tiles. The findings guide the next version of the glaze recipe.'],
  ]), ceramics, 2),
  placement('interview-prompts', 'oral-history', source('Preparing a remembered-work interview', [
    ['Conversation prompts', 'The interviewer prepares open questions about remembered work routines and significant changes. Follow-up prompts invite the participant to explain the sequence in their own words.'],
    ['Interview review', 'The notes record how participant consent will be confirmed and which questions need clarification. After the conversation, the interviewer summarizes themes for a follow-up interview.'],
  ]), oralHistory, 0),
  placement('harbour-route', 'coastal-navigation', source('A harbour approach route worksheet', [
    ['Chart reference points', 'The route worksheet identifies chart landmarks and notes which features can be compared along the proposed coastal passage. It records approach bearings as route-planning information.'],
    ['Route alternatives', 'The crew compares possible waypoints and writes an alternative route alongside the primary passage. The chosen route is annotated with the landmarks expected at each stage.'],
  ]), navigation, 1),
  placement('joint-fitting', 'woodworking', source('Trial fitting a mortise-and-tenon joint', [
    ['Joint layout', 'The apprentice draws the joint geometry and marks which faces should meet. A practice piece is used to compare the layout with the assembled joint.'],
    ['Fit observations', 'The notebook records gaps, alignment, and the changes made during successive trial fits. Each correction is linked to its trial-fitting notes.'],
  ]), woodworking, 2),
  placement('starter-loaves', 'bread-making', source('Starter and loaf comparison notebook', [
    ['Starter observations', 'The baker records starter feeding observations and compares the appearance of dough prepared from successive batches. Each loaf is linked to its starter record.'],
    ['Shaping and fermentation', 'The notes describe dough handling, shaping, and changes observed during fermentation. Loaves are compared according to the recorded dough and starter observations.'],
  ]), baking, 0),
  placement('tomato-bed', 'vegetable-gardening', source('Tomato bed planting and support plan', [
    ['Planting layout', 'The gardener sketches the vegetable bed, lists the tomato seedlings, and records their planned positions. The planting notes are compared with the previous crop rotation.'],
    ['Crop support and progress', 'The journal tracks supports, plant growth, and harvest observations for the vegetable crop. Every entry refers to the same vegetable bed through the growing season.'],
  ]), gardening, 1),
  placement('choir-phrasing', 'choral-music', source('Balancing a choral phrase in rehearsal', [
    ['Entries and pronunciation', 'The singers mark shared entries and agree how the words should be pronounced. Each section rehearses its part before the ensemble sings the phrase together.'],
    ['Vocal balance', 'The conductor records where one section should support another and compares the shape of the phrase across takes. The next rehearsal uses these vocal balance notes to revisit the phrase.'],
  ]), choir, 2),
  placement('outcrop-map', 'geology', source('Mapping layers along a stream outcrop', [
    ['Field descriptions', 'The survey team sketches the visible rock layers and records changes between observation points. Each sketch refers to the location where the layer was observed.'],
    ['Map comparison', 'The notebook compares the field sketches and describes how the layers continue across the surveyed ground. The main subject is the geology observed outdoors.'],
  ]), geology, 0),
  placement('chain-adjustment', 'bicycle-maintenance', source('A bicycle drivetrain service worksheet', [
    ['Component observations', 'The worksheet records chain and derailleur observations for one bicycle. The mechanic lists which adjustments were checked during the service.'],
    ['Service comparison', 'The final notes compare the shifting behavior before and after the adjustments and identify components to inspect at the next service. The document is about upkeep of the bicycle itself.'],
  ]), cycling, 1),
  placement('warp-pattern', 'textile-craft', source('Preparing a warp for a woven sample', [
    ['Warp arrangement', 'The weaver records the order of warp threads and how they will be threaded through the loom. A small draft shows the pattern to test.'],
    ['Woven sample', 'The sample notes compare the resulting cloth with the pattern draft and record changes for the next weaving attempt. The next draft uses the changes observed in the cloth samples.'],
  ]), weaving, 2),
  { id: 'unrelated-train-trip', domain: 'off-topic', groups: astronomy, expectedGroup: null,
    source: source('Planning an intercity train journey', [['Journey stages', 'The traveller compares train connections, writes down transfer stations, and chooses a sequence of rail journeys.'], ['Packing notes', 'The list covers luggage, reading material, and personal reminders for the trip.']]) },
  { id: 'unrelated-film-club', domain: 'off-topic', groups: gardening, expectedGroup: null,
    source: source('A film-club discussion plan', [['Film selection', 'The club chooses a film and prepares questions about the story and editing.'], ['Discussion format', 'The members plan a short introduction followed by a discussion of the film.']]) },
  { id: 'unrelated-word-puzzles', domain: 'off-topic', groups: woodworking, expectedGroup: null,
    source: source('Comparing word-puzzle clues', [['Clue categories', 'The puzzle editor groups clues by wordplay pattern and compares alternate phrasings.'], ['Puzzle review', 'The review records ambiguous clues and checks whether each answer fits the intended puzzle.']]) },
  { id: 'unrelated-family-album', domain: 'off-topic', groups: choir, expectedGroup: null,
    source: source('Arranging a fictional family photo album', [['Picture sequence', 'The album editor places imagined family photographs in a sequence and writes captions for each page.'], ['Page review', 'The review checks caption consistency and compares possible page layouts. No real people or photographs are included.']]) },
];
