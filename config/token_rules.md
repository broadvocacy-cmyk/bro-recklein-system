# Token Discipline Rules — Recklein Case Engine

## Core Principles
- Free models handle 90% of work.
- Claude Pro (Sonnet) is used ONLY for:
  - final reasoning
  - strategic synthesis
  - legal analysis
  - morning brief generation
  - multi-agent reconciliation

## Routing Rules
- Preprocessor → free model
- Flagging Agent → free model
- Brady Monitor → free model
- Judge Pattern Agent → free model
- Case Researcher → free model unless complex
- Defense Strategist → Claude Pro
- Morning Brief → Claude Pro
- Thought Partner Bridge → Claude Pro

## Output Compression
- All agents must compress output to essential facts.
- No agent may exceed 1,200 tokens per output.
- Strategist may exceed only when synthesizing multi-state conflicts.
