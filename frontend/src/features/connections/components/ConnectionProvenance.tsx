import type { Link } from "../../../shared/api/client";
import OrganizationHistory from "../../organization/components/OrganizationHistory";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function text(value: unknown) {
  return typeof value === "string" ? value : "";
}

export default function ConnectionProvenance({
  link,
  showClaims = true,
}: {
  link: Link;
  showClaims?: boolean;
}) {
  const metadata = record(link),
    proof = record(link.proof),
    review = record(proof.review);
  const actor = text(metadata.reviewed_by) || text(review.actor);
  const reason = text(review.reason) || text(metadata.reason);
  const date = text(metadata.reviewed_at);
  const criterion = text(proof.criterion);
  const criteria: Record<string, string> = {
    entails_target_claim: "The source claim supports the target claim.",
    incompatible_claims:
      "The claims make incompatible statements about the same subject.",
    shared_subject:
      "The passages share a subject or explicit reference; this does not establish agreement.",
  };
  const source = record(proof.source),
    target = record(proof.target);
  return (
    <section
      className="connection-provenance"
      aria-label="Connection origin and reasoning"
    >
      <dl>
        <dt>Origin</dt>
        <dd>
          {actor
            ? "Reviewed connection"
            : Object.keys(proof).length
              ? "Automatic evidence check"
              : "Not recorded"}
        </dd>
        <dt>Reviewer</dt>
        <dd>{actor || "Not recorded"}</dd>
        <dt>Review date</dt>
        <dd>{date || "Not recorded on this connection; see history below"}</dd>
        {metadata.decision_id != null && (
          <>
            <dt>Decision</dt>
            <dd>{text(metadata.decision_id)}</dd>
          </>
        )}
        {metadata.correction_id != null && (
          <>
            <dt>Correction</dt>
            <dd>{text(metadata.correction_id)}</dd>
          </>
        )}
      </dl>
      <p>
        {reason ||
          criteria[criterion] ||
          "No explanation was recorded for this connection."}
      </p>
      {typeof metadata.confidence === "number" && (
        <p>
          Model score: {metadata.confidence.toFixed(2)}. This is a model
          estimate, not a measure of evidence strength.
        </p>
      )}
      {showClaims && text(source.text) && text(target.text) && (
        <details>
          <summary>Exact claims used for this connection</summary>
          <p>
            <strong>Source · {link.source_version}</strong>
            <br />
            {text(source.text)}
          </p>
          <p>
            <strong>Target · {link.version}</strong>
            <br />
            {text(target.text)}
          </p>
        </details>
      )}
      {!!link.additional_evidence?.length && (
        <p>
          This connection also has {link.additional_evidence.length} additional
          evidence record(s). The original review is preserved.
        </p>
      )}
      {link.additional_evidence?.map((extra, index) => {
        const extraProof = record(extra.proof),
          extraReview = record(extraProof.review);
        const extraSource = record(extraProof.source),
          extraTarget = record(extraProof.target);
        return (
          <details key={index}>
            <summary>Additional evidence record {index + 1}</summary>
            <p>Reviewer: {text(extraReview.actor) || "Not recorded"}</p>
            <p>{text(extraReview.reason) || "Reason not recorded"}</p>
            <p>
              <strong>
                Source · {text(extra.source_version) || link.source_version} ·{" "}
                {text(extra.source_chunk_id)}
              </strong>
              <br />
              {text(extraSource.text) || "Claim text not recorded"}
            </p>
            <p>
              <strong>
                Target · {text(extra.version) || link.version} ·{" "}
                {text(extra.target_chunk_id)}
              </strong>
              <br />
              {text(extraTarget.text) || "Claim text not recorded"}
            </p>
          </details>
        );
      })}
      <OrganizationHistory
        key={link.source_document_id}
        documentId={link.source_document_id}
      />
    </section>
  );
}
