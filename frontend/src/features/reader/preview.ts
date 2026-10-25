import { waitForJob, type Job } from "../../shared/api/client";

/** Ready artifacts need one read. Cold artifacts return their own durable job. */
export async function readPreview(
  url: string,
  signal: AbortSignal,
): Promise<Response> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(url, { signal });
    if (
      response.status === 202 ||
      response.headers.get("Content-Type")?.includes("application/json")
    ) {
      const result = await response.json().catch(() => ({}));
      if (response.ok && typeof result.job_id === "string") {
        await waitForJob(result as Job<unknown>, signal);
        continue;
      }
      // Rendering can finish between the endpoint's cache check and job request.
      if (response.ok && result.ready === true) continue;
      throw new Error(result.error || "Preview preparation unavailable");
    }
    if (!response.ok) throw new Error("Preview unavailable");
    return response;
  }
  throw new Error(
    "Preview preparation did not finish. Retry or download the original.",
  );
}
