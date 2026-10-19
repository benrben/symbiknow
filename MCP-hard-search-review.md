# Hard search: missing facts and misleading matches

Date: 17 October 2026. Real MCP calls, real local INT8 embeddings, and real hosted Jev. This used a temporary library; the live user library was not changed.

Tested **32 questions across all four modes (128 searches)** against 13 test documents. The files include TXT, Markdown, HTML, a regular PDF, and text in a PNG. Questions mix English and Hebrew.

The expected outcomes were written before running searches. The corpus deliberately contains similar names, wrong-company facts, old prices, unapproved proposals, nearby ticket IDs, missing units/dates/owners, and contradictory notes. Some control questions have real answers, so refusing everything cannot pass.

## Jev answer-mode results

| Test group | Correct behavior | Passed | Failed | Provider unavailable |
| --- | --- | ---: | ---: | ---: |
| Fact absent | Do not accept an answer | 20/21 | 1 | 0 |
| Real answer controls | Accept applicable, complete evidence | 4/6 | 2 | 0 |
| Only part of the answer exists | Mark partial; never complete | 3/3 | 0 | 0 |
| False premise | Correct the premise using explicit evidence | 1/1 | 0 | 0 |
| Contradictory current notes | Do not certify one definitive value | 1/1 | 0 | 0 |

Overall: **29/32 cases passed** the declared source/coverage checks. **Wrongly accepted answers: 1 out of 21 questions whose requested facts were absent.** Provider failures are counted separately, not credited as safe refusals.

These checks concern which source passages are accepted and how complete they are labeled. MCP answer mode does not write a final prose answer. Accepting a wrong passage is still a meaningful failure: a downstream agent could use it to write an unsupported answer.

## Mode comparison on absent facts

| Mode | Returned at least one file despite the missing fact | Checks answer support? | Median time, all questions |
| --- | ---: | --- | ---: |
| keyword | 20/21 | No; related-file retrieval only | 0.200s |
| semantic | 21/21 | No; related-file retrieval only | 0.407s |
| hybrid | 21/21 | No; related-file retrieval only | 0.385s |
| answer | 1/21 | Yes, Jev | 1.434s |

Returning related files is expected for keyword, semantic, and hybrid. Their matches are not promises that the answer exists. Only answer mode (or evaluate=True) checks answer support. Do not interpret these counts as identical error rates across all four modes.

Timing is one measured round trip per query/mode, including warmup and provider latency. This run uses limit=5 and full diagnostics; the earlier easy comparison used limit=3. The timings are not a matched speed-regression test.

## Every answer-mode case

| Case | Question | Expected | Actual status | Accepted files | Check |
| --- | --- | --- | --- | --- | --- |
| missing_price | What is the current 2026 price of battery replacement at Atlas repair desk? | none | no_answer_in_evaluated_candidates | None | pass |
| wrong_company_person | Which technician is assigned to ticket ZXQ731 at Atlas repair desk? | none | no_answer_in_evaluated_candidates | None | pass |
| near_identifier | How long does battery replacement for ticket ZXQ732 take? | none | no_answer_in_evaluated_candidates | None | pass |
| unknown_company | How long does battery replacement take at Atlas Medical? | none | answered | atlas-current.txt | FAIL |
| unapproved_amount | What is the approved Atlas repair desk refund limit? | none | no_answer_in_evaluated_candidates | None | pass |
| unapproved_hours | What are the current approved Sunday opening hours at Atlas repair desk? | none | no_answer_in_evaluated_candidates | None | pass |
| unmeasured_duration | What is Juniper's measured recovery duration in minutes? | none | no_answer_in_evaluated_candidates | None | pass |
| secret_absent | What is the exact Juniper backup encryption password? | none | no_answer_in_evaluated_candidates | None | pass |
| wrong_branch | How many parking spaces does Willow North have? | none | no_answer_in_evaluated_candidates | None | pass |
| inverse_wrong_branch | What time does Willow South open? | none | no_answer_in_evaluated_candidates | None | pass |
| near_product | How much does Meridian Mini weigh in kilograms? | none | no_answer_in_evaluated_candidates | None | pass |
| unstated_dimension | How tall is Meridian Pro in centimeters? | none | no_answer_in_evaluated_candidates | None | pass |
| missing_day_pdf | What time does the ORION warehouse open on Sunday? | none | no_answer_in_evaluated_candidates | None | pass |
| missing_timezone_pdf | What time zone applies to the ORION warehouse's 09:30 Monday opening? | none | no_answer_in_evaluated_candidates | None | pass |
| missing_year_ocr | In which year is the CEDAR July 15 security review scheduled? | none | no_answer_in_evaluated_candidates | None | pass |
| planned_not_actual | On which date was the CEDAR security review actually completed? | none | no_answer_in_evaluated_candidates | None | pass |
| missing_owner_ocr | Who is responsible for the CEDAR design review? | none | no_answer_in_evaluated_candidates | None | pass |
| missing_value_hebrew | מהו סכום הקנס על איחור בספריית נחל בשקלים? | none | no_answer_in_evaluated_candidates | None | pass |
| missing_value_cross_language | How many shekels is the late-return fine at Nahal library? | none | no_answer_in_evaluated_candidates | None | pass |
| nonexistent_contact | What is the email address of the Atlas repair desk CEO? | none | no_answer_in_evaluated_candidates | None | pass |
| missing_cause | What is the documented reason why Atlas battery replacement takes 45 minutes? | none | no_answer_in_evaluated_candidates | None | pass |
| unit_conversion_control | How many hours does Juniper keep each backup? | complete | no_answer_in_evaluated_candidates | None | FAIL |
| positive_exact | How long does battery replacement at Atlas repair desk take? | complete | answered | atlas-current.txt | pass |
| positive_other_entity | Who is the technician at Atlas Mobile? | complete | answered | atlas-mobile.txt | pass |
| positive_historical | What did Atlas repair desk charge for battery replacement in 2024? | complete | no_answer_in_evaluated_candidates | None | FAIL |
| negative_fact_control | Has Juniper's recovery duration been measured? | complete | answered | backups.html | pass |
| absence_documented_control | Is the amount of Nahal library's late-return fine documented in the library file? | complete | answered | library-hebrew.txt | pass |
| partial_cost | How long does Atlas battery replacement take, and what is its current 2026 price? | partial | partial | atlas-current.txt | pass |
| partial_pdf | What are ORION's Monday and Sunday warehouse opening hours? | partial | partial | orion-hours.pdf | pass |
| partial_ocr | What is the planned CEDAR security review date, and who is responsible? | partial | partial | cedar-plan.png | pass |
| false_premise_control | Why was ORION shipment O17 cancelled? | correction | answered | orion-shipping.txt | pass |
| conflicting_values | What is the definitive current Echo warranty duration? | conflict | needs_context | None | pass |

## Cases needing attention

### unknown_company

Question: How long does battery replacement take at Atlas Medical?

Expected: Atlas Medical is not documented.

Actual: `answered`; complete=1, partial=0, corrections=0.

Accepted `atlas-current.txt` with coverage `complete` and policy label `direct`.

> Atlas repair desk, current 2026 information. Ticket ZXQ731 is a battery replacement. Battery replacement takes 45 minutes. The repair desk closes at 17:00. Prices and staff assignments are not recorded in this document.

### unit_conversion_control

Question: How many hours does Juniper keep each backup?

Expected: 28 days equals 672 hours; a justified conversion is allowed.

Actual: `no_answer_in_evaluated_candidates`; complete=0, partial=0, corrections=0.

### positive_historical

Question: What did Atlas repair desk charge for battery replacement in 2024?

Expected: 35 dollars is explicit for 2024.

Actual: `no_answer_in_evaluated_candidates`; complete=0, partial=0, corrections=0.

## Fresh evaluations of the failures

The three failed cases were evaluated again through the same Jev judgment/policy code, using the captured retrieval evidence and a fresh process without the application's judgment cache. This was a diagnostic provider/policy check, not a second complete MCP/ingestion run. No prompt, threshold, or application code was changed.

| Case | Fresh result | Accepted sources |
| --- | --- | --- |
| unknown_company | answered | atlas-current.txt |
| unit_conversion_control | no_answer_in_evaluated_candidates | None |
| positive_historical | answered | atlas-archive.txt |

The wrong-company acceptance and unit-conversion refusal repeated. The historical-price question succeeded on the fresh evaluation, showing that this result can vary. The original 29/32 score is retained; a successful retry does not erase the original miss.

For the wrong-company case, Jev assigned entity-match probability 0.97 to the Atlas repair desk passage despite the question naming Atlas Medical. This is a confident identity mistake, so simply displaying confidence does not solve it. For the conversion case, Jev again selected related rather than direct and reported scope mismatch 0.49, even though 28 days can be converted to 672 hours. These are observed model/policy outputs, not proof of the model's internal reasoning.

[Raw uncached diagnostics](outputs/mcp-tools-review/hard-search/failure-diagnostics.json) retain judgments for rejected candidates as well as accepted ones.

## Recommended next improvements

1. Strengthen entity checks: similar names must not count as the same company without an explicit alias or relationship. Validate this on other names and Hebrew/English aliases, not just the Atlas example.
2. Distinguish a unit conversion from a conflicting fact or different time scope. Preserve the original evidence and verify any derived value.
3. Add paired historical/current questions to evaluation coverage and repeat them to detect unstable applicability judgments.

These are follow-up recommendations. No production behavior was changed in this testing task, and the observed failures remain open.

## Interpretation and limits

The earlier 10/10 semantic score measured finding known files in an easy corpus. It did not measure whether facts were missing. This harder benchmark tests a different property, and should be read alongside that comparison.

Ground truth is scoped to these test files. An empty answer does not prove a fact is absent from the entire real world, or even from every document in a larger library: only the top five candidates and their bounded evidence windows were evaluated. The contradictory-notes test depends on retrieving both notes. A near-ticket-ID refusal expects strict identity matching, not inference that nearby tickets share the same service record.

This is one live-provider run with predefined cases, not a statistically representative quality estimate. No application policy or thresholds were changed to improve the score.

## Reproduce and inspect

- [Declared cases and text fixtures](outputs/mcp-tools-review/hard-search/cases.json)
- [All raw MCP results, including ordinary retrieval candidates](outputs/mcp-tools-review/hard-search/results.json)
- [Summary counts](outputs/mcp-tools-review/hard-search/summary.json)
- [Live test script](outputs/mcp-tools-review/hard_search.py)
- [Execution log](outputs/mcp-tools-review/hard-search.log)

```sh
.venv/bin/python outputs/mcp-tools-review/hard_search.py
.venv/bin/python outputs/mcp-tools-review/summarize_hard_search.py
```

The script needs the cached models and a configured Jev key. It makes real hosted calls with the test text and uses a fresh temporary library.
