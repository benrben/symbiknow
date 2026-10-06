function sharedPrefix(queryWord: string, titleWord: string): number {
  let first = 0;
  while (first < Math.min(queryWord.length, titleWord.length) && queryWord[first] === titleWord[first]) first++;
  return first;
}

function transposed(queryWord: string, titleWord: string, first: number): boolean {
  return first + 1 < queryWord.length && queryWord[first] === titleWord[first + 1]
    && queryWord[first + 1] === titleWord[first]
    && queryWord.slice(first + 2) === titleWord.slice(first + 2);
}

function equalSizeEdit(queryWord: string, titleWord: string, first: number): boolean {
  return transposed(queryWord, titleWord, first) || queryWord.slice(first + 1) === titleWord.slice(first + 1);
}

/** One insertion, deletion, substitution, or adjacent transposition in a title word. */
export function nearTitleWord(queryWord: string, titleWord: string): boolean {
  if (queryWord.length < 5 || Math.abs(queryWord.length - titleWord.length) > 1) return false;
  // The candidate builder calls this only for terms absent from the exact title/body words.
  const first = sharedPrefix(queryWord, titleWord);
  if (queryWord.length === titleWord.length) return equalSizeEdit(queryWord, titleWord, first);
  return queryWord.length > titleWord.length
    ? queryWord.slice(first + 1) === titleWord.slice(first)
    : queryWord.slice(first) === titleWord.slice(first + 1);
}
