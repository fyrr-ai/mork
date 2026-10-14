# 17. OCR finds defects; repository verification establishes them

Date: 2026-10-14 · Status: Accepted

Open Code Review replaces Mork's full Pi reviewer as the only defect finder in
Check. On five real PR snapshots, OCR found 18 of 26 golden findings versus 13
for the improved Pi reviewer, but reported 104 comments versus 34. Lower effort
and custom rules reduced comments to 34 and golden hits to 11. We choose medium
effort and avoid paying for a second full bug review. Golden matches and model
judgements are imperfect evidence; these experiments do not prove general recall.

A fresh Pi verifier inspects OCR claims, callers and mitigations using only
read/search tools inside the head and baseline checkouts. It must distinguish a
concrete regression from an intended change or pre-existing behaviour, and cite
both revisions for confirmation. The runner validates all cited quotes against a
separate checkout never handed to an agent. New code can cite checked absence at
base. A quotation proves its location, not the semantic claim.

Findings are confirmed, refuted, unknown or duplicates of an earlier canonical
finding. Missing/invalid evidence or omitted assessments mean unknown. Partial
OCR coverage and worker failures remain visible and keep review at careful.
Neither an OCR P0 nor a confident Jev answer clears missing verification.
A persisted OCR result freezes finding IDs for an interrupted verifier session.
Earlier claims are carried into each new Check until reassessed against the new
head, so silence from OCR cannot erase an unknown. Changed lines are re-anchored
from checked current-head evidence at the claimed path. Duplicate assessments
identify root causes while canonical claims stay visible in the PR. Invalid references remain unknown.

Jev assigns urgency only to confirmed findings from their verified expected
behaviour, scenario and code evidence, in bounded batches. Confirmed, located
bugs, security and performance defects rated must-fix use the existing repair
loop: at most three findings per round, three rounds by default. When urgency
is undecided, only already-confirmed findings may use OCR's P0/P1 fallback;
the PR still requires careful review. Unknown claims never trigger a repair or
become grounds for quick review. Refuted claims and duplicates remain labelled
in the PR. Existing protected-path and security-change handover policy remains.

Only non-testable acceptance criteria get a separate narrow Pi check. That
worker supplies verified quotes for Jev; it does not search for defects. It is
not started when every criterion is testable. Gate failures continue to retry
Build before OCR runs. Check and Decide use the existing Step Functions route.
Delivery is still a draft PR, with handover PRs when work exists; no auto-merge.

OCR 1.13.0 is pinned by release SHA-256 in the runner image. Its environment
contains the configured model endpoint and a placeholder credential replaced by
the existing egress sidecar. AWS, GitHub and decision credentials stay in the
runner. OCR uses a private configuration home, trusted rule override and disabled
telemetry. Trusted local execution may use its explicitly supplied LLM key.
The runner base is upgraded to Debian 13 for Git >= 2.41 required by OCR.

This supersedes ADR 14's general Pi reviewer and priority from raw claims.
ADR 16 supervision applies to Pi verification and criteria checking; OCR uses its
own finite review rounds/tool limits and the phase timeout, without periodic
Jev supervision. Evidence and urgency remain model-assisted, not proof that a
change is safe to merge automatically.
