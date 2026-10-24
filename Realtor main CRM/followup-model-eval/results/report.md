# Local real-estate follow-up model evaluation

Status: **not_run**. Updated: 2026-10-06T13:34:21.256157+00:00.

3 models × 20 cases; 0 outputs attempted. No paid APIs.

No model emails or performance measurements are fabricated. Blank metrics mean not measured.

## Model summary

| Model | Status | Attempted / expected | API errors | JSON failures | All checks % | Avg generation s | Avg wall s | Avg tokens/s | Human score (1–5) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| qwen3.5:2b | not_run | 0 / 20 | 0 | 0 |  |  |  |  |  |
| qwen3.5:4b | not_run | 0 / 20 | 0 | 0 |  |  |  |  |  |
| phi4-mini:latest | not_run | 0 / 20 | 0 | 0 |  |  |  |  |  |

## Per-check pass rates (%)

| Check | qwen3.5:2b | qwen3.5:4b | phi4-mini:latest |
| --- | --- | --- | --- |
| valid_json |  |  |  |
| word_count |  |  |  |
| allowed_merge_fields |  |  |  |
| no_urls |  |  |  |
| no_new_currency_amounts |  |  |  |
| no_unsubscribe |  |  |  |
| no_bracket_placeholders |  |  |  |

## Three sample emails per model, side by side

The same cases are shown for every model; examples are not selected by quality.

### case_01 — no reply

Buyer; follow-up 2; 4 days since last email. Tone: warm, practical, low pressure.

| Field | qwen3.5:2b | qwen3.5:4b | phi4-mini:latest |
| --- | --- | --- | --- |
| Subject | Not run | Not run | Not run |
| Body | Not run | Not run | Not run |
| Checks | Not run | Not run | Not run |
| Human score (1–5) |  |  |  |

### case_09 — question

Buyer; follow-up 2; 1 days since last email. Tone: direct, helpful, transparent about unknowns.

| Field | qwen3.5:2b | qwen3.5:4b | phi4-mini:latest |
| --- | --- | --- | --- |
| Subject | Not run | Not run | Not run |
| Body | Not run | Not run | Not run |
| Checks | Not run | Not run | Not run |
| Human score (1–5) |  |  |  |

### case_17 — price-sensitive

Buyer; follow-up 2; 2 days since last email. Tone: budget-conscious, respectful, practical.

| Field | qwen3.5:2b | qwen3.5:4b | phi4-mini:latest |
| --- | --- | --- | --- |
| Subject | Not run | Not run | Not run |
| Body | Not run | Not run | Not run |
| Checks | Not run | Not run | Not run |
| Human score (1–5) |  |  |  |

## Interpretation

- Pass rates use all attempted cases, including API errors. Invalid JSON fails every check; missing cases are not silently counted as passes.
- JSON failures count invalid generated email objects; API errors are counted separately.
- Generation seconds = eval_duration / 1e9. Tokens/s = eval_count / (eval_duration / 1e9). Average tokens/s is the arithmetic mean of measured per-email speeds.
- Wall seconds include request overhead and prompt processing. Warm-up and model loading are excluded from generation speed; warm-up calls are not scored.
- Human review still needs to check one CTA, factuality (including addresses, availability and financing), tone, reply relevance and repetition. Regex checks do not prove an email is factually correct.
- Scores: 1 unusable; 2 major edits; 3 usable with edits; 4 minor edits; 5 ready to send after factual review. Human score cells are intentionally blank.
- Review each email in outputs.csv, then copy a model's mean human score into report.csv. Re-running archives prior reports before creating fresh reports and blank score cells.
