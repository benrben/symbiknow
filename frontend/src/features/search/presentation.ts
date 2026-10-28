import type { Doc, SearchAnswer } from "../../shared/api/client";

export function sortSearchMatches(matches: Doc[], sort: string, descending: boolean) {
  if (sort === "relevance") return matches;
  return [...matches].sort((a, b) => {
    let order: number;
    if (sort === "date") {
      const left = Date.parse(a.created_at || ""), right = Date.parse(b.created_at || "");
      // Unknown dates stay last in both directions, without replacing them with today's date.
      if (!Number.isFinite(left) || !Number.isFinite(right)) {
        return Number(!Number.isFinite(left)) - Number(!Number.isFinite(right));
      }
      order = left - right;
    } else {
      const field = sort === "type" ? "mime_type" : "filename";
      order = a[field].localeCompare(b[field], undefined, { numeric: true });
    }
    return descending ? -order : order;
  });
}

export function reconcileSearchMatches(
  matches: Doc[],
  documents: Doc[],
  scopeReady: boolean,
  folder?: string,
  group?: string,
) {
  if (!scopeReady) return matches;
  const currentById = new Map(documents.map((d) => [d.document_id, d]));
  return matches.flatMap((match) => {
    const current = currentById.get(match.document_id);
    // A browse page (including Recent) is not the authority on search membership.
    // Absence here cannot invalidate a version-checked backend search result.
    if (!current) return [match];
    if (
      current.version !== match.version ||
      (current.status && current.status !== "indexed") ||
      !(
        folder === undefined ||
        current.folder === folder ||
        (!!folder && current.folder?.startsWith(folder + " / "))
      ) ||
      (group && !current.groups?.includes(group))
    )
      return [];
    return [
      {
        ...match,
        folder: current.folder,
        groups: current.groups,
        organization_status: current.organization_status,
      },
    ];
  });
}

export function unavailableAnswerMessage(
  answer: SearchAnswer,
  hasCheckedAnswers = false,
) {
  // The backend supplies fixed, sanitized messages rather than provider bodies.
  const failure = answer.failure;
  const guidance = failure
    ? `${failure.message} ${failure.recovery}`
    : "Answer checking could not be completed.";
  return {
    title: "Answer checking unavailable",
    body: `${guidance} ${hasCheckedAnswers
      ? "Only previously accepted answers are shown."
      : "This does not mean the answer is missing."} Switch to Search to browse related files.`,
  };
}

// Presentation only: the backend decides whether an answer was established.
export function emptySearchMessage(
  answer: SearchAnswer,
  evaluate: boolean,
  unavailable: boolean,
) {
  if (!evaluate)
    return {
      title: "No matching files",
      body: "Try different words, another mode, or a broader scope.",
    };
  if (unavailable) return unavailableAnswerMessage(answer);
  if (answer.status === "not_evaluated")
    return {
      title: "Answer was not checked",
      body:
        answer.reason === "context_budget"
          ? "The retrieved text exceeds the answer-checking limit. Narrow the question or folder, or show related files. This does not mean the answer is missing."
          : answer.reason === "sensitive_content"
          ? "The retrieved files may contain credentials, so their text was not sent for answer checking. Open the related files to read them locally. This does not mean the answer is missing."
          : "The retrieved files were not evaluated. Retry the check or show related files; this does not mean the answer is missing.",
    };
  return {
    title:
      answer.status === "needs_context"
        ? "More context needed"
        : "No supported answer found",
    body: `Checked ${answer.evaluated_count ?? 0} of ${answer.candidate_count ?? 0} candidates in this scope. ${answer.status === "needs_context" ? "The evidence is ambiguous or conflicting." : "No answer was established in the checked passages."}`,
  };
}

// Cosine distance of the best semantic match at or beyond which nothing is a
// strong match. Calibrated on the current embedding model: gibberish queries
// bottom out near 0.32, real topics reach 0.16-0.28. It only changes a notice;
// results are never hidden.
export const WEAK_MATCH_DISTANCE = 0.3;

export function hasNoStrongMatch(matches: Doc[], mode: string, evaluate: boolean) {
  if (mode !== "semantic" || evaluate || !matches.length) return false;
  const distances = matches.map((d) => {
    const retrieval = (d as { retrieval?: { score?: number | null; score_kind?: string } }).retrieval;
    return retrieval?.score_kind === "_distance" && typeof retrieval.score === "number" ? retrieval.score : undefined;
  });
  if (distances.some((value) => value === undefined)) return false;
  return Math.min(...(distances as number[])) >= WEAK_MATCH_DISTANCE;
}
