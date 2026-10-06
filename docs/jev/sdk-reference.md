# Jev SDK reference

The public entry point is `server/sdk.ts`; its compiled entry point is `dist/sdk/sdk.js` with declarations in `dist/sdk/sdk.d.ts`.

| Export | Purpose |
| --- | --- |
| `choice(instructions, criteria)` | Build a choice question; preserve literal option keys in its answer type. |
| `score(instructions, criteria)` | Build an ordinal score question with 2–10 ordered labels. |
| `noul(instructions, criteria?)` | Build a probability question with optional `true` / `false` criteria. |
| `decideWithJev(key, state, questions, fetcher?, options?)` | Validate a request, call Jev, and validate its answers. |
| `askJev(decider, key, state, questions, options?)` | Preserve the literal question-to-answer types across a supplied decider. |
| `choiceAnswer`, `scoreAnswer`, `noulAnswer` | Read a named answer with type checks. |
| `expectedScore(answer, levels)` | Normalize a score's probability-weighted expectation by `levels - 1`. |
| `topScore(answer)` | Read the selected score level. |
| `assertValidJevRequest(state, questions)` | Check question construction and the estimated state budget. |
| `estimateJevTokens(value)` | Estimate tokens as UTF-8 JSON bytes divided by three, rounded up. |
| `onJevUsage(listener)` | Subscribe to valid provider-reported usage; returns an unsubscribe function. |
| `ApiError` | Error with a numeric `status`. |
| `JEV_MODEL`, `JEV_STATE_TOKEN_LIMIT` | Model name and estimated request budget. |

Public types include the question and answer types, `AnswerFor`, `AnswersFor`, `JevDecider`, `JevCallOptions`, and `JevUsage`. The low-level transport remains internal.

`JevCallOptions` accepts `signal`, `maxRetries`, and `baseDelayMs`. The optional `fetcher` allows a caller to inject an HTTP boundary without changing the engine. `askJev` forwards call options to its decider; use a wrapper decider to supply a custom fetcher.

Requests go to `https://api.typesafe.ai/v1/systemone`. The default model is `jev-1.13.0`; `TYPESAFE_MODEL` overrides it when the module loads. API keys are passed explicitly; the SDK does not load `.env` files.

The engine checks question IDs, instructions, 2–255 choice options, 2–10 score labels, and Noul criteria keys. Estimated state plus the largest question must fit 32,000 tokens. Answers must include each requested ID and type, valid selected options/score ranges, confidence, and required probabilities. Probability values must be finite and between zero and one; their sum is not enforced.

Each HTTP attempt has a 20-second deadline. The default is two retries after the initial attempt for network failures and HTTP 429, 500, 502, 503, 504, or 529. Backoff uses jitter; a valid `Retry-After` is honored up to ten seconds. Response bodies are capped at 262,144 bytes. There is no global decision cache or action state.

| Status | Meaning |
| --- | --- |
| `400` | Missing API key. |
| `413` | Estimated request state exceeds the budget. |
| `499` | Caller cancellation. |
| `500` | Invalid question construction. |
| `502` | Provider/network failure, malformed response, or invalid answer. |

This SDK exports decisions without application dependencies. Symbi Reflex implements the application actions through the workspace `/jev` routes and corresponding MCP and Symbi tools. Those actions use separate authorization, evidence, checked-write, and Undo contracts; SDK answers alone do not authorize writes.
