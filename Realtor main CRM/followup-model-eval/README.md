# Follow-up model evaluation (local Ollama)

A standalone Python project for comparing small open-weight models on realistic
real-estate follow-up emails. No paid APIs, frameworks, cloud inference, RealtorOS
integration, or changes to your application. Only `requests` is installed.

## Keep it beside RealtorOS

Extract the ZIP into the **parent folder** of your existing RealtorOS repo. The ZIP
contains its own `followup-model-eval/` folder, giving you:

```text
your-projects/
  RealtorOS/
  followup-model-eval/
```

Do not put it inside RealtorOS. This environment did not contain your RealtorOS
checkout, so the supplied folder is independent; the extraction location on your
Windows computer determines the sibling relationship.

## One-time Windows setup

1. Install current **Python 3** from <https://www.python.org/downloads/windows/>.
   Enable the Python launcher (`py`) in the installer. Python 3.9+ works with this
   project; use a currently supported Python release.
2. Download the current Windows installer from
   <https://ollama.com/download/windows> and run `OllamaSetup.exe`. Start Ollama
   from the Start menu. It runs in the background and exposes
   `http://localhost:11434`. Open a **new** PowerShell window after installation.
   `ollama --version` should work. Use the latest release for Qwen 3.5 support.
3. Pull all three candidates (downloads require internet; generation is local):

   ```powershell
   ollama pull qwen3.5:2b
   ollama pull qwen3.5:4b
   ollama pull phi4-mini:latest
   ```

Official tags checked on **2026-10-06**:

| Requested candidate | Exact tag used | Note |
| --- | --- | --- |
| `qwen3.5:2b` | `qwen3.5:2b` | Exists as requested. |
| `qwen3.5:4b` | `qwen3.5:4b` | Exists as requested. |
| `phi4-mini` | `phi4-mini:latest` | Explicit form of the shorthand; the library also lists `phi4-mini:3.8b` and `phi4-mini:3.8b-q4_K_M`. |

Tag aliases can change. `results/run_info.json` records the installed model
digests, Ollama version, platform, generation settings and input hashes to help
identify what was actually evaluated. The runner checks that models are already
installed; it does not automatically pull or substitute another model.

Allow several GB of disk space per model plus Ollama itself. Available RAM/VRAM
and GPU support affect speed; download size is not the same as runtime memory.
Models run sequentially, with one unscored warm-up and an unload request after
each model. CPU-only runs can take substantially longer. See the
[official Windows instructions](https://docs.ollama.com/windows) for platform
and driver requirements.

## Run in 3 commands

After the one-time setup above, open PowerShell in the **parent** of both folders:

```powershell
cd .\followup-model-eval
py -3 -m pip install -r requirements.txt
py -3 run_eval.py
```

This makes **60 scored calls**: 3 models × 20 cases, plus one unscored warm-up per
model. Watch progress in the terminal, then open `results/report.md` and
`results/report.csv`. An ordinary check failure does not abort the run. API or
setup failures produce a nonzero exit code and are explained in the report.

If `py` is unavailable but Python is on PATH, use `python` instead of `py -3`.
If Ollama is not running, start it from the Start menu or run `ollama serve` in
a separate terminal; do not start a second server when the background app is
already listening.

## Files

| File | Purpose |
| --- | --- |
| `cases/cases.jsonl` | 20 synthetic US buyer/seller conversations; no actual customer data. |
| `prompt.md` | One shared instruction template; case JSON is inserted at `{{case_json}}`. |
| `run_eval.py` | Local API runner, timing, incremental saves and report generation. |
| `checks.py` | Seven automatic checks using Python's standard library. |
| `tests.py` | Offline unit and mock-HTTP integration tests; no model or paid service needed. |
| `results/report.csv` | Per-model pass rates, failure counts, speed and blank human-score column. |
| `results/report.md` | Summary, every check, and the same three sample cases side by side. |
| `results/outputs.csv` | Every generated email, raw output, checks, timing, errors and blank human score. |
| `results/outputs.jsonl` | Append-only log within a run: prompt, raw API response, metrics and checks. |
| `results/run_info.json` | Run settings, model digests, environment and status. |

**The included reports are not-run templates.** No real-model benchmark was
performed in the creation environment because Ollama was unavailable. The sample
slots say `Not run`; real emails, speeds and pass rates appear after your local
run. Tests create mock results only in temporary folders, never these reports.

## Case mix and interpretation

There are 5 no-reply cases, 3 short positive replies, 4 questions, 4 "not ready
yet" replies and 4 price-sensitive replies. Follow-up numbers range from 2–5;
elapsed days range from 1–45. Seller `lead.budget` means their **desired sale
price**, never a confirmed valuation. Its `purpose` field makes this explicit.

`reply_text` is the most recent lead reply when `replied` is true, otherwise
`null`. Only the first agent email is supplied; do not infer the content of
intervening emails for later follow-ups. First names are retained in the case
file for realism and replaced by `{{first_name}}` before a case reaches a model.

The allowed output merge fields are `{{first_name}}`, `{{preferred_area}}`,
`{{budget}}` and `{{realtor_name}}`. The prompt's `{{case_json}}` marker is an
input insertion point and is **not** an allowed email merge field.

Default generation settings: temperature 0.2, seed 42, context 4096, maximum
512 output tokens, JSON format, non-streaming HTTP. Qwen thinking is explicitly
disabled; Phi has no thinking control sent. A fixed seed improves repeatability
but does not guarantee identical output across hardware or Ollama versions.
JSON format constrains syntax; the check still validates the exact email schema.
The evaluator never repairs malformed JSON or strips code fences to award a pass.

The seven automatic checks are:

| Check | Definition |
| --- | --- |
| `valid_json` | Strict JSON object with exactly nonempty string `subject` and `body`; no duplicate keys, NaN, fences or extra text. |
| `word_count` | Body has 60–140 words; greeting and signature count, subject does not, each merge field counts as one word. |
| `allowed_merge_fields` | Exact allowed double-brace fields; recipient field required; rejects the case's real first name and malformed/unknown brace fields. |
| `no_urls` | Rejects schemes, `www`, bare domains and IPv4 link-like strings in subject/body. |
| `no_new_currency_amounts` | Numeric amounts normalized by value and currency; rejects amounts absent from the case. `$425,000`, `USD 425k` and `425000 dollars` are equivalent. Bare `425k` is treated as USD for these US cases. Spelled-out currency amounts are conservatively flagged for human review. |
| `no_unsubscribe` | Rejects common unsubscribe, opt-out and removal/stop-email phrases. |
| `no_bracket_placeholders` | Rejects square-bracket, angle-bracket and `${...}` placeholders. |

Automated checks are screening rules, not complete language understanding.
Obfuscated URLs, unusual currencies, spelled-out amounts, euphemistic opt-outs,
and fabricated numbers without currency markers need human review. The prompt
is stricter than the currency check: it asks for `{{budget}}` or "your budget"
instead of literal amounts. These cases are a smoke evaluation, not a statistical
proof that one model is best for every lead.

Pass-rate denominator = all attempted cases for that model. API failures fail
all checks; unattempted cases remain visibly missing. Invalid generated JSON
fails all checks and increments `json_failures`. API failures have their own
count and do not masquerade as JSON parsing failures.

Generation time = `eval_duration / 1e9`. Tokens/second =
`eval_count / (eval_duration / 1e9)`, using Ollama's timing fields. Wall time also
includes prompt processing and HTTP overhead. Warm-up is excluded. Model
loading and prompt evaluation are not part of generation tokens/s; their API
metrics are retained in the raw log. Average speed is the arithmetic mean of
per-email speeds with available metrics; see `speed_samples`. Tokenizers differ,
so also compare wall seconds and writing quality, not just tokens/s.

## Human scoring

Read the full emails in `outputs.csv` and the three side-by-side samples in
`report.md` (fixed cases 01, 09 and 17: no reply, question and price sensitivity).
Fill the blank **human score (1–5)** cells, considering:

- Does it address the actual reply and respect timing/readiness and budget?
- Is there exactly one clear, easy call to action?
- Does it avoid invented facts, addresses, inventory, rates, promises and claims
  of work already performed?
- Does the tone feel natural, useful and professional without repetition?

1 = unusable; 2 = major edits; 3 = usable with edits; 4 = minor edits; 5 = ready
after factual review. Put each model's mean human score in `report.csv`. Keep an
annotated copy if sharing results. Re-running archives existing result files
under `results/previous_<timestamp>/` before creating fresh reports and blank
score cells. Ctrl+C keeps completed outputs and reports an interrupted run;
there is no resume feature in this small project.

## Optional commands

```powershell
# Offline verification (standard-library unittest; requests is the only dependency)
py -3 tests.py

# Quick first comparison: 3 representative cases across all 3 models
py -3 run_eval.py --case-ids case_01 case_09 case_17 --output-dir results\quick

# One model, allowing more time per call on a slow CPU
py -3 run_eval.py --models qwen3.5:2b --timeout 600

# Generate empty report templates in a different folder without calling Ollama
py -3 run_eval.py --init-reports --output-dir results\templates
```

The endpoint defaults to localhost. `--base-url` permits only HTTP loopback
hosts, redirects are disabled and environment proxy settings are ignored.
Use downloaded local models, not cloud model tags.

## Official references

- [Qwen 3.5 tags](https://ollama.com/library/qwen3.5/tags)
- [Phi-4-mini tags](https://ollama.com/library/phi4-mini/tags)
- [Ollama Windows installation](https://docs.ollama.com/windows)
- [Generate API](https://docs.ollama.com/api/generate)
- [Usage metrics](https://docs.ollama.com/api/usage)
