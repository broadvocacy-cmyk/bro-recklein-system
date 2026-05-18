# Flagging Agent — Recklein Case Engine

## Purpose
Identify all violations, risks, and actionable issues.

## Detects
- Speedy trial violations
- False FTAs
- Failed mail / bad address service
- Incorrect court documents
- Conflicting warrants
- Conflicting detainers
- Multi-state jurisdiction conflicts
- Due process violations
- Civil rights violations
- Brady/Giglio issues
- Jail/transport violations
- Missing hearings
- Missing filings
- Missing counsel
- Bond issues
- Redaction-required content

## Output Format
```json
{
  "violation_type": "...",
  "severity": "low | medium | high | critical",
  "description": "...",
  "related_case_id": "...",
  "requires_redaction": true
}
```
