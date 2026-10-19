# Symbiknow / Organization / Project subject taxonomy and candidate cohesion

Repository implementation guide. Snapshot: 17 October 2026.
## Goal
Documents should share a meaningful project → subject folder rather than one folder per filename or boilerplate document type. A policy, rejected proposal, runbook and acceptance check can belong to one subject while retaining their distinct content and versions.

## Content preparation
Representative evidence removes repeated non-substantive notices while preserving passage IDs and provenance. Explicit project/subject headings offer reusable subject paths. Ordinary prose uses project recognition and bounded sparse topic features. Existing folder names are candidates, not permission to cross a document's project/entity boundary.

## Avoiding fragments
The generator suppresses generic document types and imperative action labels. Isolated details can use a shared substantive label where evidence supports it; otherwise a general project parent remains a valid candidate. Relevant child subjects rank ahead of a generic parent. Manual folder corrections remain authoritative during routine indexing.

## OCR identity
Uncertain OCR possessives/casing can resolve against established non-OCR project identities. Arbitrary fuzzy merging is avoided because a similar-looking name can be a real separate project. This is a candidate-generation safeguard, not a complete OCR identity benchmark.

## Limits and evaluation
Feature, centroid and label-sample budgets bound candidate preparation. They do not prove project/topic accuracy across languages, synonyms or 100,000 originals. Evaluate pairwise co-membership, singleton rate and shuffled-ingestion stability with an independently labeled corpus; exact Finance versus Billing strings are not sufficient quality metrics.

## Current membership evidence

Project ownership uses a separate bounded selection of owner-bearing passages and canonical identity candidates. This can inspect up to 128 sampled source chunks without passing them all to the provider. Topic and link evidence retain smaller budgets. A source filename or import path is corroboration, not an assignment command. Canonical owner selection and generated topic placement remain separate from manual overrides.

## Source references
- `app/organization.py`
- `app/jev.py`
- `tests/test_organization.py`

This guide summarizes the checked repository implementation; it is not a separately validated external specification.
