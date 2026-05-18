# Preprocessor Agent — Recklein Case Engine

## Purpose
Normalize all incoming text from:
- PDFs
- FOIA responses
- PAC responses
- emails
- faxes
- jail logs
- transport logs
- court records

## Responsibilities
- OCR cleanup
- remove headers/footers
- unify date formats
- extract entities (names, dates, courts, case numbers)
- detect document type
- detect originating jurisdiction
- detect missing pages
- detect redaction needs
- output normalized_text

## Output Format
```json
{
  "normalized_text": "...",
  "document_type": "...",
  "origin_state": "...",
  "origin_county": "...",
  "case_number": "...",
  "needs_redaction": true
}
```
