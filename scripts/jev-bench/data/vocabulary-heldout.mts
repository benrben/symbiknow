/** Independently authored fictional contexts. External execution requires separate heldout approval. */
export const vocabularyHeldoutAnswerKey = Object.freeze({
  'star-brightness': true,
  'hive-work': false,
  'kiln-cycles': true,
  'oral-records': false,
  'sailing-turns': true,
  'timber-work': false,
  'bread-rest': true,
  'garden-layout': false,
  'choir-preparation': true,
  'geological-records': false,
  'cycle-brakes': true,
  'loom-work': false,
});
export type VocabularyHeldoutId = keyof typeof vocabularyHeldoutAnswerKey;
export type VocabularyHeldoutTerm = Readonly<{
  name: string; definition: string; canvasId: string; canvasName: string;
  documentId: string; title: string; content: string; evidence: string;
}>;
export type VocabularyHeldoutCase = Readonly<{
  id: VocabularyHeldoutId; domain: string; expectedMerge: boolean;
  source: VocabularyHeldoutTerm; target: VocabularyHeldoutTerm;
}>;
type Description = readonly [name: string, definition: string, title: string, body: string];
function member(id: VocabularyHeldoutId, side: string, domain: string, description: Description): VocabularyHeldoutTerm {
  const [name, definition, title, evidence] = description;
  return Object.freeze({ name, definition, canvasId: `vocab-heldout-${id}-${side}`, canvasName: `${domain}: ${side} notebook`,
    documentId: `vocab-heldout-${id}-${side}-notes`, title, content: `# ${title}\n\n${evidence}\n`, evidence });
}
function pair(id: VocabularyHeldoutId, domain: string, source: Description, target: Description): VocabularyHeldoutCase {
  return Object.freeze({ id, domain, expectedMerge: vocabularyHeldoutAnswerKey[id],
    source: member(id, 'source', domain, source), target: member(id, 'target', domain, target) });
}
export const vocabularyHeldout = Object.freeze([
  pair('star-brightness', 'Fictional astronomy club',
    ['Stellar brightness measurements', 'Measurements of a star’s apparent brightness on the magnitude scale.', 'Night readings at Alder Observatory',
      'Alder Observatory measures the apparent brightness of its comparison stars on the magnitude scale. Each stellar brightness measurement records the star, observation time, filter, and magnitude value. Repeated measurements form a light curve.'],
    ['Magnitude readings', 'Recorded measurements of a star’s apparent brightness expressed in magnitudes.', 'Magnitude notebook for Alder stars',
      'The Alder club records magnitude readings for each comparison star. A reading measures the star’s apparent brightness in a specified filter and attaches an observation time. The notebook uses these readings to draw stellar light curves.']),
  pair('hive-work', 'Fictional beekeeping cooperative',
    ['Hive inspections', 'Checks of a bee colony’s brood, queen activity, food stores, and health.', 'Cedar Apiary colony checks',
      'Cedar Apiary performs hive inspections every ten days. The keeper opens the brood boxes, checks eggs and brood patterns, notes queen activity, assesses food stores, and records signs of disease. The inspection record tracks colony health.'],
    ['Honey extraction', 'Harvesting honey from filled comb by uncapping cells and spinning the frames.', 'Cedar Apiary honey room',
      'Cedar Apiary extracts honey from ripe frames brought to the honey room. Workers uncap the filled cells, spin the frames in an extractor, filter the collected honey, and fill jars. The harvest record tracks honey yield by batch.']),
  pair('kiln-cycles', 'Fictional ceramics studio',
    ['Kiln firing log', 'A record of temperature changes, hold durations, and cooling during a kiln firing.', 'Slate Studio kiln notebook',
      'Slate Studio keeps a kiln firing log for every load. The potter records the temperature ramp, the duration of each hold, peak temperature, and the cooling stages. These records connect glaze results to the firing cycle used for the load.'],
    ['Firing cycle record', 'The recorded heating, holding, and cooling schedule actually followed in a kiln firing.', 'Slate Studio cycle records',
      'A firing cycle record at Slate Studio documents how one kiln load was heated and cooled. It lists measured ramp temperatures, hold durations, peak temperature, and cooling stages. The potter consults that record when comparing glaze results from different loads.']),
  pair('oral-records', 'Fictional oral history archive',
    ['Interview transcripts', 'Written renderings of the words spoken in recorded oral history interviews.', 'River Archive interview text',
      'River Archive prepares interview transcripts from recorded conversations. A transcriber writes the speaker’s words, marks pauses and unclear audio, and checks the text against the recording. The transcript supports quotation and text search.'],
    ['Recording consent forms', 'Signed permissions governing the recording and publication of an oral history interview.', 'River Archive permissions register',
      'River Archive obtains a recording consent form before an interview. The signed form states whether recording and publication are permitted, identifies any access restrictions, and records the participant’s signature. Archivists retain it as evidence of permission.']),
  pair('sailing-turns', 'Fictional sailing school',
    ['Tacking', 'Changing sailing tack by turning the bow through the wind.', 'Willow Sailing bow turns',
      'Willow Sailing teaches tacking by bringing the bow through the wind. The crew shifts the sails as the boat changes from port tack to starboard tack or back again. This bow-through-wind turn is practised on a marked training course.'],
    ['Coming about', 'Turning a sailing boat’s bow through the wind to change from one tack to the other.', 'Willow Sailing coming-about drills',
      'In the Willow Sailing coming-about drill, the helm turns the bow through the wind and the crew resets the sails on the opposite side. The manoeuvre changes the boat from one tack to the other. Instructors record the timing and control of each turn.']),
  pair('timber-work', 'Fictional woodworking guild',
    ['Joinery patterns', 'Methods and shapes for connecting pieces of timber with fitted joints.', 'Birch Guild joint exercises',
      'Birch Guild apprentices study joinery patterns for mortise-and-tenon and dovetail joints. They mark the joint shape, cut the mating pieces, and check the fit before glue-up. The pattern specifies how the timber pieces connect.'],
    ['Finishing schedules', 'Ordered applications and drying intervals for coatings on a wood surface.', 'Birch Guild coating notebook',
      'Birch Guild writes a finishing schedule for each furniture surface. It specifies sanding steps, the coats of oil or varnish, drying intervals, and the final buffing step. The schedule controls the surface treatment after construction.']),
  pair('bread-rest', 'Fictional neighbourhood bakery',
    ['Final dough rise', 'The rise of shaped bread dough immediately before baking.', 'Juniper Bakery shaped-loaf rest',
      'Juniper Bakery allows each shaped loaf its final dough rise before it enters the oven. The baker watches the dough expand in its basket and checks its readiness with a gentle press. The record notes the duration and temperature of this final rest.'],
    ['Final proofing', 'The resting and rising of shaped bread dough immediately before it is baked.', 'Juniper Bakery proofing records',
      'Final proofing at Juniper Bakery begins after the loaves are shaped and ends when they are loaded into the oven. During this rest the shaped dough rises in its baskets. Bakers record the proofing temperature, duration, and readiness of each loaf.']),
  pair('garden-layout', 'Fictional community garden',
    ['Crop rotation', 'Changing the plant families grown in a garden bed across successive growing seasons.', 'Fern Garden yearly bed plan',
      'Fern Garden uses crop rotation when planning its beds for the next year. The committee records the previous crop family and assigns a different family to the same bed in the following season. The yearly plan helps manage soil depletion and recurring pests.'],
    ['Companion planting', 'Growing selected plants next to one another during the same season.', 'Fern Garden adjacent-plant plan',
      'Fern Garden uses companion planting to arrange neighbouring plants during one growing season. Gardeners put selected herbs, flowers, and vegetables beside one another in the current bed layout. The plan records which plants grow together at the same time.']),
  pair('choir-preparation', 'Fictional amateur choir',
    ['Vocal warmups', 'Singing and breathing exercises that prepare singers’ voices before rehearsal.', 'Meadow Choir rehearsal opening',
      'Meadow Choir starts rehearsal with vocal warmups. Singers practise gentle breathing, humming, and short scales to prepare their voices before singing the programme. The conductor records the exercises used at the start of each session.'],
    ['Pre-rehearsal voice exercises', 'Breathing and singing exercises performed before rehearsal to prepare the voice.', 'Meadow Choir voice preparation',
      'Before rehearsing the programme, Meadow Choir performs pre-rehearsal voice exercises. The group uses gentle breathing, humming, and short scales to prepare each singer’s voice. The exercise sheet describes this opening preparation routine.']),
  pair('geological-records', 'Fictional field geology society',
    ['Rock identification', 'Determining a rock’s type from its minerals, texture, and composition.', 'Flint Society specimen notebook',
      'Flint Society identifies collected rocks by examining mineral content, grain size, texture, and composition. Members compare those properties with a specimen guide and record a rock type. The notebook describes each individual specimen.'],
    ['Stratigraphic ordering', 'Determining the relative sequence of rock layers at a field site.', 'Flint Society layer survey',
      'Flint Society records stratigraphic ordering at a quarry face. Surveyors trace the rock layers, note which beds lie above or below others, and describe the relative sequence of deposition. The survey concerns the order of layers at the site.']),
  pair('cycle-brakes', 'Fictional bicycle repair club',
    ['Mechanical brake cable tension', 'The tautness adjustment of the cable operating a bicycle’s mechanical brake.', 'Rowan Cycle cable setting',
      'Rowan Cycle sets mechanical brake cable tension by adjusting the cable that pulls the brake arms. The mechanic checks lever travel and pad movement, then fixes the cable at the required tautness. The service record describes that cable adjustment.'],
    ['Brake wire tautness adjustment', 'Adjusting the operating cable’s tension in a bicycle mechanical brake.', 'Rowan Cycle brake-wire service',
      'The brake-wire tautness adjustment at Rowan Cycle changes the tension of the cable operating a mechanical brake. A mechanic adjusts the wire, checks lever travel and pad movement, and secures it at the chosen tension. This procedure concerns the same operating cable throughout.']),
  pair('loom-work', 'Fictional weaving circle',
    ['Warp threading', 'Passing the lengthwise warp yarns through a loom’s heddles before weaving.', 'Hazel Weavers loom setup',
      'Hazel Weavers performs warp threading while setting up the loom. Each lengthwise warp yarn is passed through its assigned heddle before weaving begins. The threading chart records the arrangement of those warp yarns in the heddles.'],
    ['Weft insertion', 'Passing crosswise weft yarn through the opened warp shed while weaving cloth.', 'Hazel Weavers shuttle practice',
      'Hazel Weavers practises weft insertion after the loom has been set up. A shuttle carries crosswise weft yarn through the opened warp shed, and the yarn is beaten into the growing cloth. The practice record follows those crosswise passes during weaving.']),
]);
