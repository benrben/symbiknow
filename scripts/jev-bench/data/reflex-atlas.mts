/** Atlas answers frozen before heldout preparation; retain the original benchmark claims. */
export const atlasReflexClaims: Array<[string, 'yes' | 'no' | 'insufficient_evidence']> = [
  ['The search index splits documents into passages of about 220 characters.', 'yes'], ['Each document has its own Git repository.', 'yes'],
  ['The local embedding model is Xenova all-MiniLM-L6-v2.', 'yes'], ['White text on Agent Blue has a contrast ratio of only 3.2:1.', 'yes'],
['MCP tokens can be limited to specific canvases.', 'yes'],
  ['The Tasks feature was removed from the app.', 'yes'], ['Chat proposals can be undone after they are applied.', 'yes'],
  ['All documents in a workspace share a single Git repository.', 'no'], ['The embedding model is downloaded automatically from the internet when it is missing.', 'no'],
  ['White text on Agent Blue meets the 4.5:1 contrast requirement for normal text.', 'no'], ['The search index uses passages of about 1,000 characters.', 'no'],
  ['The Tasks board is a core part of the current app.', 'no'], ['MCP tokens always have access to every canvas.', 'no'],
  ['SymbiKnow has a native iPad app.', 'insufficient_evidence'], ['The team plan costs $10 per month.', 'insufficient_evidence'],
  ['The interface can be switched to Spanish.', 'insufficient_evidence'], ['Search results are kept for 30 days.', 'insufficient_evidence'],
  ['SymbiKnow sends a weekly email digest.', 'insufficient_evidence'], ['Documents are encrypted with AES-256 at rest.', 'insufficient_evidence'],
  ['The API re-reads each returned passage from the current file before returning it.', 'yes'], ['The project has 424 Vitest test files.', 'yes'],
  ['Ranked search results are cached with a default limit of 4 MB.', 'yes'], ['One GitHub Actions job runs lint, types, tests, and acceptance.', 'yes'],
  ['The project has about 50 Vitest test files.', 'no'], ['The search result cache defaults to 64 MB.', 'no'],
  ['CI uses Jenkins instead of GitHub Actions.', 'no'], ['Search passages break at a space after 90% of the maximum length.', 'no'],
  ['SymbiKnow was founded in 2021.', 'insufficient_evidence'], ['MiniLM was chosen because it is the fastest model available.', 'insufficient_evidence'],
  ['The CI job finishes in under five minutes.', 'insufficient_evidence'], ['Most users access SymbiKnow from mobile phones.', 'insufficient_evidence'],
];
