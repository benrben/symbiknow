# MCP tools and search review — 17 October 2026

Follow-up: the [hard missing-fact search review](MCP-hard-search-review.md) found a wrong-company acceptance and two missed valid answers. The scores below measure the earlier, easier file-finding task; they do not establish reliable answer checking.

Checked all three MCP tools through real stdio and HTTP connections. The checks used temporary libraries, real INT8 text/image embeddings, Docling/OCR, and the configured live Jev provider for answer tests. The user's library was not changed or restarted.

## Fixes

- **Upload retries:** a completed chunk upload used to accept different retry bytes if the caller kept the same declared hash. Retries now check the actual bytes against the original committed version. Correct retries still work after restart and after a newer version is uploaded.
- **JPEG and BMP search:** indexing failed because Pillow does not expose `n_frames` for these single-image formats. The code now uses one frame when that property is absent. Other image formats retain their real frame counts.

## Tool checks

| Tool | Checked | Result |
| --- | --- | --- |
| `upload` | Actual bytes, batches, chunking, retries, restart/resume, version conflicts, mixed success/error batches | Pass after retry fix |
| `download` | All fixture formats, SHA-256 byte equality, range downloads, pinned versions, history | Pass |
| `search` | All four modes, English/Hebrew, OCR, images, compact/full output, evaluation, pagination, stale cursors, bad inputs | Protocol checks pass; quality differences below |

Discovery advertises exactly these three tools. JSON text and structured results agree. Missing-provider behavior was checked separately: answer mode reports unavailable instead of claiming the library has no answer.

## Search comparison

Each of the ten supported format families has equal weight: TXT, Markdown, HTML, PDF, PNG, JPEG, WebP, GIF, BMP, TIFF. Regular/scanned PDFs share the PDF weight; English/Hebrew TXT share TXT. A binary file was also stored and downloaded correctly, with an explicit unsupported-for-search status.

**Finding files score:** 10 points when the expected file ranks first, 5 when second, 3.33 when third, and 0 when absent. Average within each format, then average the ten formats. This uses 17 known-file questions; the extra missing-answer question is excluded. This is a small benchmark score, not a production accuracy guarantee.

**Speed score:** based on median MCP round-trip time: under 0.10s = 10; 0.25s = 9; 0.50s = 8; 1s = 7; 2s = 6; 5s = 5; 10s = 4; 20s = 3; 30s = 2; otherwise 1. These are declared usability bands, not industry standards. One sample per question/mode; all modes use the same corpus and limit of three. Order rotates between retrieval modes; answer runs last. Caches, model loading and other tests on this machine affect timings.

| Mode | Finding files /10 | Speed /10 | Median time | Correct file first | Checks whether text answers? |
| --- | ---: | ---: | ---: | ---: | --- |
| `keyword` | 9.25 | 9 | 0.138s | 15/17 | No |
| `semantic` | 10.00 | 9 | 0.240s | 17/17 | No |
| `hybrid` | 9.75 | 8 | 0.253s | 16/17 | No |
| `answer` | 9.25 | 7 | 0.551s | 15/17 | Yes, using Jev |

### Why the scores are not all 10

- **keyword:** English question / Hebrew file (not in the returned results); Cat photo (not in the returned results). Speed is 9/10 because the measured median was 0.138s.
- **semantic:** All expected files ranked first in this small test. That earns 10 here, but does not establish perfect behavior on other libraries. Speed is 9/10 because the measured median was 0.240s.
- **hybrid:** Cat photo (rank 2). Speed is 8/10 because the measured median was 0.253s.
- **answer:** Exact ticket ID (not in the returned results); Cat photo (not in the returned results). Speed is 7/10 because the measured median was 0.551s.

Semantic and hybrid timings were only about 13 milliseconds apart in this run. Their one-point speed-score difference comes from crossing a rating-band boundary, not proof of a meaningful performance difference. A speed score of 10 requires a median below 100 milliseconds under this rubric.

Keyword search depends on matching words and readable text, so it cannot reliably connect an English question to Hebrew wording or recognize a photo. Semantic search compares meaning and visual content, but can still return related files when no answer exists. Hybrid combines both rankings; word matches can push a less useful text file above the best image match. Answer mode deliberately filters results: a bare ticket ID or a photo request may have no accepted textual answer, even when ordinary search finds the file. Its file-finding score should not be confused with answer-checking accuracy.

### Results by question

Numbers below are the expected file's rank within the first three results. A dash means it was not returned. The last row instead records whether the mode withheld results for a question with no answer in these fixtures; retrieval modes are not designed to make that judgment.

| Case | Keyword | Semantic | Hybrid | Answer |
| --- | ---: | ---: | ---: | ---: |
| Exact ticket ID | 1 | 1 | 1 | — |
| Different wording | 1 | 1 | 1 | 1 |
| Hebrew question / Hebrew file | 1 | 1 | 1 | 1 |
| English question / Hebrew file | — | 1 | 1 | 1 |
| Markdown | 1 | 1 | 1 | 1 |
| HTML | 1 | 1 | 1 | 1 |
| Regular PDF | 1 | 1 | 1 | 1 |
| Scanned PDF | 1 | 1 | 1 | 1 |
| PNG text | 1 | 1 | 1 | 1 |
| JPEG text | 1 | 1 | 1 | 1 |
| WebP text | 1 | 1 | 1 | 1 |
| GIF text | 1 | 1 | 1 | 1 |
| BMP text | 1 | 1 | 1 | 1 |
| TIFF text | 1 | 1 | 1 | 1 |
| GIF second frame | 1 | 1 | 1 | 1 |
| TIFF second page | 1 | 1 | 1 | 1 |
| Cat photo | — | 1 | 2 | — |
| Question with no answer in these files | Related files returned | Related files returned | Related files returned | Withheld |

For the **15 actual questions with facts in the files**, answer mode accepted the expected source first in **15/15** cases. For the missing-answer question it reported `no_answer_in_evaluated_candidates`. This checks source selection and accepted evidence; it is not a broad test of hallucination, contradictions, or all possible provider failures. Answer mode returns checked passages, not a newly written final answer.

## File format checks

All fixture originals passed whole-file SHA-256 verification after MCP download. The extra GIF frame and TIFF page were included in the search questions.

| File | Index status | Readable text | Visual search |
| --- | --- | --- | --- |
| `cat.png` | indexed | Yes | Yes |
| `english.txt` | indexed | Yes | No |
| `guide.md` | indexed | Yes | No |
| `hebrew.txt` | indexed | Yes | No |
| `native.pdf` | indexed | Yes | Yes |
| `poster.bmp` | indexed | Yes | Yes |
| `poster.gif` | indexed | Yes | Yes |
| `poster.jpg` | indexed | Yes | Yes |
| `poster.png` | indexed | Yes | Yes |
| `poster.tiff` | indexed | Yes | Yes |
| `poster.webp` | indexed | Yes | Yes |
| `scanned.pdf` | indexed | Yes | Yes |
| `schedule.html` | indexed | Yes | No |
| `unsupported.bin` | unsupported | No | No |

A readable-text flag only means the extractor produced some text. It does not prove that OCR is correct: the cat photograph produced the stray character `0`, so answer mode must not treat it as a meaningful description.

## What I recommend

- Use **semantic** for natural-language questions, Hebrew/English cross-language search, and photos. It found every expected file first in this small corpus.
- Use **keyword** for exact codes and known words. It can search an existing text index without loading the embedding model.
- Keep **hybrid** available for mixed word/meaning searches. Its visual-query ranking needs a broader benchmark before changing the current fusion algorithm.
- Use **answer** when you need evidence that actually answers a question. It takes extra provider time and requires Jev access. It evaluates retrieved text/OCR windows, so it cannot certify purely visual content.

## Validation and limits

The full regression suite passed **301 tests in 248.30 seconds**. The 12 new image-format cases were added after that suite started; they passed as part of **42 focused image/ingestion/memory checks** after the image fix. The initial focused MCP suite passed 72 tests. The new retry regression failed before the fix and passed afterward. The image-format regression initially failed for JPEG/BMP from both bytes and paths. See [the full test log](outputs/mcp-tools-review/full-tests.log) and [the focused image test log](outputs/mcp-tools-review/image-after-fix.log).

No new per-mode RAM comparison was measured in this review. Semantic, hybrid and answer share the same local embedding model; answer also calls the hosted provider. Keyword avoids query embeddings, but a shared server may retain a model loaded by earlier work until its idle timeout. See [the earlier measured RAM review](outputs/memory-research/implementation-review/README.md) for actual memory numbers.

This run covers format families, not every extension alias, document layout, encoding, corrupted file, language, or maximum-size workload. Existing regression tests cover additional error, scope, pagination and publication cases. Search timings here are small-corpus measurements, not service guarantees.

The running server was not restarted. Restart it to load the fixes. JPEG/BMP files that previously failed indexing may also need a retry/reindex; this review did not modify those files in the user's library.

## Evidence and reproduction

- [Final raw results](outputs/mcp-tools-review/final/results.json)
- [Calculated scores](outputs/mcp-tools-review/final/scores.json)
- [Discovered tool schemas](outputs/mcp-tools-review/final/tool-schemas.json)
- [Real MCP check script](outputs/mcp-tools-review/check_tools.py)
- [Comparison generator](outputs/mcp-tools-review/summarize.py)
- [Pre-fix search run](outputs/mcp-tools-review/results.json)

```sh
MCP_REVIEW_OUTPUT=outputs/mcp-tools-review/final .venv/bin/python outputs/mcp-tools-review/check_tools.py
.venv/bin/python outputs/mcp-tools-review/summarize.py
```

The check script uses the cached models and synthetic fixtures. If a Jev key is configured, answer tests make hosted calls. Do not compare scores from a provider-disabled run with the live-provider results above.
