# Rollback runbook

Use this when a release must be undone.

1. Freeze deploys in the release channel
2. Redeploy the previous tagged build
3. Run the smoke tests against production
4. Post a status update with the incident link

Owner: on-call engineer. Target: rollback in under 15 minutes.
