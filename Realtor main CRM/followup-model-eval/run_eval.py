#!/usr/bin/env python3
"""Compare local Ollama models. One dependency: requests."""

import argparse
import csv
import hashlib
import html
import json
import platform
import statistics
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

import requests

from checks import CHECK_NAMES, check_output

ROOT = Path(__file__).resolve().parent
DEFAULT_MODELS = ["qwen3.5:2b", "qwen3.5:4b", "phi4-mini:latest"]
SAMPLE_IDS = ["case_01", "case_09", "case_17"]
OPTIONS = {"temperature": 0.2, "seed": 42, "num_ctx": 4096, "num_predict": 512}


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def load_cases(path):
    cases = []
    seen = set()
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        try:
            case = json.loads(line)
            lead = case["lead"]
            assert isinstance(case["id"], str) and case["id"] not in seen
            assert lead["type"] in ("buyer", "seller")
            for key in ("first_name", "preferred_area", "source"):
                assert isinstance(lead[key], str) and lead[key].strip()
            budget = lead["budget"]
            assert isinstance(budget["amount"], (int, float)) and not isinstance(budget["amount"], bool)
            assert budget["amount"] > 0 and budget["currency"] == "USD"
            for key in ("subject", "body"):
                assert isinstance(case["first_email"][key], str) and case["first_email"][key].strip()
            assert type(case["followup_number"]) is int and 2 <= case["followup_number"] <= 5
            assert type(case["days_since_last_email"]) is int and case["days_since_last_email"] >= 0
            assert type(case["replied"]) is bool
            if case["replied"]:
                assert isinstance(case["reply_text"], str) and case["reply_text"].strip()
            else:
                assert case["reply_text"] is None
            assert isinstance(case["desired_tone"], str) and case["desired_tone"].strip()
        except (KeyError, ValueError, TypeError, AssertionError) as exc:
            raise ValueError("Invalid case at line {}: {}".format(line_number, exc)) from exc
        seen.add(case["id"])
        cases.append(case)
    if not cases:
        raise ValueError("No cases found")
    return cases


def render_prompt(template, case):
    # Preserve the real name in the test dataset, but prevent it entering the prompt.
    anonymized = json.loads(json.dumps(case))
    name = anonymized["lead"]["first_name"]
    anonymized["lead"]["first_name"] = "{{first_name}}"
    for key in ("subject", "body"):
        anonymized["first_email"][key] = anonymized["first_email"][key].replace(name, "{{first_name}}")
    if anonymized["reply_text"]:
        anonymized["reply_text"] = anonymized["reply_text"].replace(name, "{{first_name}}")
    if template.count("{{case_json}}") != 1:
        raise ValueError("prompt.md must contain exactly one {{case_json}} marker")
    return template.replace("{{case_json}}", json.dumps(anonymized, ensure_ascii=False, indent=2))


def local_base_url(value):
    parsed = urlparse(value)
    if (parsed.scheme != "http" or parsed.hostname not in {"localhost", "127.0.0.1", "::1"}
            or parsed.username or parsed.password or parsed.query or parsed.fragment
            or parsed.path not in ("", "/")):
        raise argparse.ArgumentTypeError("Use a local HTTP endpoint, e.g. http://localhost:11434")
    try:
        parsed.port
    except ValueError as exc:
        raise argparse.ArgumentTypeError("Invalid local port") from exc
    return value.rstrip("/")


def api_json(session, method, url, timeout, payload=None):
    response = session.request(method, url, json=payload, timeout=(5, timeout), allow_redirects=False)
    if response.status_code != 200:
        raise ValueError("Ollama HTTP {}: {}".format(response.status_code, response.text[:500]))
    data = response.json()
    if not isinstance(data, dict) or data.get("error"):
        raise ValueError("Invalid Ollama response: " + str(data)[:500])
    return data


def thinking_options(model):
    # These Qwen candidates support a boolean control; Phi has no thinking mode.
    return {"think": False} if model.startswith("qwen3.5:") else {}


def ns_seconds(value):
    return value / 1e9 if isinstance(value, (int, float)) and value >= 0 else None


def generate(session, base_url, model, case, prompt, timeout):
    payload = {"model": model, "prompt": prompt, "stream": False,
               "format": "json", "keep_alive": "5m", "options": OPTIONS.copy()}
    payload.update(thinking_options(model))
    start = time.perf_counter()
    record = {"model": model, "case_id": case["id"], "generated_at": utc_now(),
              "prompt": prompt, "raw_output": "", "ollama_response": None,
              "api_error": None, "wall_seconds": None, "generation_seconds": None,
              "tokens_per_second": None, "eval_count": None,
              "total_seconds": None, "load_seconds": None, "prompt_eval_seconds": None}
    try:
        data = api_json(session, "POST", base_url + "/api/generate", timeout, payload)
        record["ollama_response"] = data
        if not isinstance(data.get("response"), str) or data.get("done") is not True:
            raise ValueError("Ollama must return a completed response string")
        record["raw_output"] = data["response"]
        record["generation_seconds"] = ns_seconds(data.get("eval_duration"))
        record["total_seconds"] = ns_seconds(data.get("total_duration"))
        record["load_seconds"] = ns_seconds(data.get("load_duration"))
        record["prompt_eval_seconds"] = ns_seconds(data.get("prompt_eval_duration"))
        tokens = data.get("eval_count")
        if isinstance(tokens, int) and not isinstance(tokens, bool) and tokens >= 0:
            record["eval_count"] = tokens
            duration = record["generation_seconds"]
            if duration and tokens > 0:
                record["tokens_per_second"] = tokens / duration
    except (requests.RequestException, ValueError) as exc:
        record["api_error"] = str(exc)
    finally:
        record["wall_seconds"] = time.perf_counter() - start
    record.update(check_output(record["raw_output"], case))
    # API failure is not a generated-email JSON parsing failure.
    if record["api_error"]:
        record["parse_error"] = None
    return record


def average(records, field):
    values = [r[field] for r in records if not r["api_error"] and r.get(field) is not None]
    return round(statistics.mean(values), 3) if values else ""


def summarize(records, models, expected_cases):
    summaries = []
    for model in models:
        rows = [r for r in records if r["model"] == model]
        n = len(rows)
        api_failures = sum(bool(r["api_error"]) for r in rows)
        status = "partial" if n and n < expected_cases else "not_run" if not n else (
            "completed_with_api_errors" if api_failures else "completed")
        row = {"model": model,
               "status": status,
               "cases_expected": expected_cases, "cases_attempted": n,
               "api_failures": api_failures,
               "json_failures": sum(bool(r["parse_error"]) for r in rows),
               "all_checks_pass_rate_pct": round(100 * sum(r["all_pass"] for r in rows) / n, 2) if n else ""}
        for name in CHECK_NAMES:
            row[name + "_pass_rate_pct"] = round(100 * sum(r["checks"][name] for r in rows) / n, 2) if n else ""
        row.update({"avg_generation_seconds": average(rows, "generation_seconds"),
                    "avg_wall_seconds": average(rows, "wall_seconds"),
                    "avg_tokens_per_second": average(rows, "tokens_per_second"),
                    "speed_samples": sum(r["tokens_per_second"] is not None and not r["api_error"] for r in rows),
                    "human score (1–5)": ""})
        summaries.append(row)
    return summaries


def write_csv(path, rows, fields=None):
    with path.open("w", newline="", encoding="utf-8-sig") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields or list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)


def md_cell(value):
    return html.escape(str(value)).replace("|", "&#124;").replace("\n", "<br>")


def write_reports(outdir, records, models, cases, metadata):
    outdir.mkdir(parents=True, exist_ok=True)
    summaries = summarize(records, models, len(cases))
    write_csv(outdir / "report.csv", summaries)
    output_fields = ["model", "case_id", "subject", "body", "raw_output", "word_count",
                     "all_pass"] + list(CHECK_NAMES) + ["wall_seconds", "generation_seconds",
                     "tokens_per_second", "eval_count", "api_error", "parse_error", "human score (1–5)"]
    output_rows = []
    for record in records:
        row = {key: record.get(key, "") for key in output_fields}
        row.update(record["checks"])
        row.update(record["email"] or {"subject": "", "body": ""})
        row["human score (1–5)"] = ""
        output_rows.append(row)
    write_csv(outdir / "outputs.csv", output_rows, output_fields)
    (outdir / "run_info.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    lines = ["# Local real-estate follow-up model evaluation", "",
             "Status: **{}**. Updated: {}.".format(metadata["status"], metadata["updated_at"]), "",
             "{} models × {} cases; {} outputs attempted. No paid APIs.".format(len(models), len(cases), len(records)), "",
             "No model emails or performance measurements are fabricated. Blank metrics mean not measured.", "",
             "## Model summary", "",
             "| Model | Status | Attempted / expected | API errors | JSON failures | All checks % | Avg generation s | Avg wall s | Avg tokens/s | Human score (1–5) |",
             "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"]
    for row in summaries:
        values = [row["model"], row["status"], str(row["cases_attempted"]) + " / " + str(row["cases_expected"]),
                  row["api_failures"], row["json_failures"], row["all_checks_pass_rate_pct"],
                  row["avg_generation_seconds"], row["avg_wall_seconds"], row["avg_tokens_per_second"], ""]
        lines.append("| " + " | ".join(md_cell(v) for v in values) + " |")
    lines += ["", "## Per-check pass rates (%)", "",
              "| Check | " + " | ".join(md_cell(model) for model in models) + " |",
              "| --- | " + " | ".join("---" for _ in models) + " |"]
    for name in CHECK_NAMES:
        lines.append("| " + name + " | " + " | ".join(str(row[name + "_pass_rate_pct"]) for row in summaries) + " |")
    if metadata.get("setup_errors"):
        lines += ["", "## Setup errors", ""]
        lines += ["- " + md_cell(error) for error in metadata["setup_errors"]]
    failures = [record for record in records if record["api_error"] or record["parse_error"]]
    if failures:
        lines += ["", "## API and JSON failures", ""]
        lines += ["- {} / {}: {}".format(md_cell(record["model"]), record["case_id"],
                  md_cell(record["api_error"] or record["parse_error"])) for record in failures]
    case_map = {case["id"]: case for case in cases}
    sample_ids = [cid for cid in SAMPLE_IDS if cid in case_map]
    sample_ids += [case["id"] for case in cases if case["id"] not in sample_ids][:3 - len(sample_ids)]
    lines += ["", "## Three sample emails per model, side by side", "",
              "The same cases are shown for every model; examples are not selected by quality."]
    for cid in sample_ids:
        case = case_map[cid]
        lines += ["", "### {} — {}".format(cid, case.get("scenario", "follow-up")), "",
                  "{}; follow-up {}; {} days since last email. Tone: {}.".format(
                      case["lead"]["type"].capitalize(), case["followup_number"],
                      case["days_since_last_email"], case["desired_tone"]), "",
                  "| Field | " + " | ".join(md_cell(model) for model in models) + " |",
                  "| --- | " + " | ".join("---" for _ in models) + " |"]
        samples = [next((r for r in records if r["model"] == model and r["case_id"] == cid), None) for model in models]
        for label in ("Subject", "Body", "Checks", "Human score (1–5)"):
            cells = []
            for record in samples:
                if label == "Human score (1–5)":
                    value = ""
                elif record is None:
                    value = "Not run"
                elif record["api_error"]:
                    value = "API error: " + record["api_error"] if label == "Checks" else "No email generated"
                elif label == "Checks":
                    value = "All pass" if record["all_pass"] else "Failed: " + ", ".join(k for k, ok in record["checks"].items() if not ok)
                elif record["email"]:
                    value = record["email"][label.lower()]
                else:
                    value = record["raw_output"] if label == "Body" else "Invalid JSON"
                cells.append(md_cell(value))
            lines.append("| " + label + " | " + " | ".join(cells) + " |")
    lines += ["", "## Interpretation", "",
              "- Pass rates use all attempted cases, including API errors. Invalid JSON fails every check; missing cases are not silently counted as passes.",
              "- JSON failures count invalid generated email objects; API errors are counted separately.",
              "- Generation seconds = eval_duration / 1e9. Tokens/s = eval_count / (eval_duration / 1e9). Average tokens/s is the arithmetic mean of measured per-email speeds.",
              "- Wall seconds include request overhead and prompt processing. Warm-up and model loading are excluded from generation speed; warm-up calls are not scored.",
              "- Human review still needs to check one CTA, factuality (including addresses, availability and financing), tone, reply relevance and repetition. Regex checks do not prove an email is factually correct.",
              "- Scores: 1 unusable; 2 major edits; 3 usable with edits; 4 minor edits; 5 ready to send after factual review. Human score cells are intentionally blank.",
              "- Review each email in outputs.csv, then copy a model's mean human score into report.csv. Re-running archives prior reports before creating fresh reports and blank score cells.", ""]
    (outdir / "report.md").write_text("\n".join(lines), encoding="utf-8")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--models", nargs="+", default=DEFAULT_MODELS)
    parser.add_argument("--base-url", type=local_base_url, default="http://localhost:11434")
    parser.add_argument("--timeout", type=float, default=300, help="Read timeout per local API call in seconds")
    parser.add_argument("--case-ids", nargs="+", help="Optional subset, e.g. case_01 case_09 case_17")
    parser.add_argument("--output-dir", type=Path, default=ROOT / "results")
    parser.add_argument("--init-reports", action="store_true", help="Create honest not-run report templates without calling Ollama")
    args = parser.parse_args(argv)
    if args.timeout <= 0 or len(args.models) != len(set(args.models)):
        parser.error("Use a positive timeout and unique model tags")
    if any(model.endswith("-cloud") or ":cloud" in model for model in args.models):
        parser.error("Cloud models are excluded; pull local open-weight models")
    cases_path = ROOT / "cases" / "cases.jsonl"
    try:
        cases = load_cases(cases_path)
        if args.case_ids:
            unknown = set(args.case_ids) - {c["id"] for c in cases}
            if unknown:
                parser.error("Unknown case IDs: " + ", ".join(sorted(unknown)))
            cases = [c for c in cases if c["id"] in args.case_ids]
        template = (ROOT / "prompt.md").read_text(encoding="utf-8")
        for case in cases:
            render_prompt(template, case)
    except ValueError as exc:
        parser.error(str(exc))
    outdir = args.output_dir.resolve()
    records = []
    metadata = {"status": "not_run", "started_at": utc_now(), "updated_at": utc_now(),
                "models": args.models, "case_ids": [case["id"] for case in cases],
                "base_url": args.base_url, "options": OPTIONS, "format": "json",
                "thinking": "disabled for qwen3.5; omitted for other models",
                "python_version": platform.python_version(), "platform": platform.platform(),
                "prompt_sha256": hashlib.sha256(template.encode("utf-8")).hexdigest(),
                "cases_sha256": hashlib.sha256(cases_path.read_bytes()).hexdigest(),
                "warmup": "one unscored one-token call per model", "setup_errors": []}
    outdir.mkdir(parents=True, exist_ok=True)
    if args.init_reports:
        # Do not destroy an already measured report accidentally.
        if (outdir / "outputs.jsonl").exists() and (outdir / "outputs.jsonl").stat().st_size:
            parser.error("This output folder has measurements. Choose another --output-dir for templates.")
        write_reports(outdir, records, args.models, cases, metadata)
        print("Not-run reports created in " + str(outdir))
        return 0
    # Preserve prior runs (including manually added human scores) before overwriting.
    if (outdir / "run_info.json").exists():
        archive = outdir / ("previous_" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ"))
        archive.mkdir()
        for name in ("report.csv", "report.md", "outputs.csv", "outputs.jsonl", "run_info.json"):
            path = outdir / name
            if path.exists():
                path.replace(archive / name)
    session = requests.Session()
    session.trust_env = False  # Bypass proxies for local data; never follow redirects.
    exit_code = 0
    try:
        version = api_json(session, "GET", args.base_url + "/api/version", args.timeout)
        metadata["ollama_version"] = version.get("version")
        tags = api_json(session, "GET", args.base_url + "/api/tags", args.timeout)
        installed = {m["name"]: m for m in tags.get("models", []) if isinstance(m, dict) and "name" in m}
        metadata["installed_models"] = installed
        missing = [model for model in args.models if (model if ":" in model else model + ":latest") not in installed]
        if missing:
            raise ValueError("Missing local models. Run: " + "; ".join("ollama pull " + model for model in missing))
        metadata["status"] = "running"
        write_reports(outdir, records, args.models, cases, metadata)
        with (outdir / "outputs.jsonl").open("w", encoding="utf-8") as log:
            for model in args.models:
                print("\nWarming up " + model, flush=True)
                warmup = {"model": model, "prompt": "Reply OK.", "stream": False,
                          "keep_alive": "5m", "options": dict(OPTIONS, num_predict=1)}
                warmup.update(thinking_options(model))
                try:
                    api_json(session, "POST", args.base_url + "/api/generate", args.timeout, warmup)
                except (requests.RequestException, ValueError) as exc:
                    metadata["setup_errors"].append(model + " warm-up: " + str(exc))
                    print("Skipped model: " + str(exc), file=sys.stderr, flush=True)
                    exit_code = 1
                    continue
                for index, case in enumerate(cases, 1):
                    print("{} [{}/{}] {}".format(model, index, len(cases), case["id"]), flush=True)
                    record = generate(session, args.base_url, model, case, render_prompt(template, case), args.timeout)
                    records.append(record)
                    log.write(json.dumps(record, ensure_ascii=False) + "\n")
                    log.flush()
                    metadata["updated_at"] = utc_now()
                    write_reports(outdir, records, args.models, cases, metadata)
                    speed = record["tokens_per_second"]
                    print("  {} | {:.2f}s wall | {} tokens/s".format(
                        "API ERROR" if record["api_error"] else "PASS" if record["all_pass"] else "CHECK FAILED",
                        record["wall_seconds"], "n/a" if speed is None else "{:.2f}".format(speed)), flush=True)
                    if record["api_error"]:
                        exit_code = 1
                try:
                    api_json(session, "POST", args.base_url + "/api/generate", args.timeout,
                             {"model": model, "keep_alive": 0, "stream": False})
                except (requests.RequestException, ValueError):
                    # Cleanup failure is not a quality failure; 5-minute keep_alive will expire.
                    pass
        metadata["status"] = "completed_with_api_errors" if exit_code else "completed"
    except KeyboardInterrupt:
        metadata["status"] = "interrupted"
        exit_code = 130
        print("\nInterrupted; completed outputs saved.", file=sys.stderr)
    except (requests.RequestException, ValueError) as exc:
        metadata["status"] = "setup_failed"
        metadata["setup_errors"].append(str(exc))
        exit_code = 1
        print("Cannot run local evaluation: " + str(exc), file=sys.stderr)
        print("Start Ollama from the Windows Start menu, or run ollama serve if it is not already running.", file=sys.stderr)
    finally:
        session.close()
        metadata["updated_at"] = utc_now()
        write_reports(outdir, records, args.models, cases, metadata)
    print("Reports: " + str(outdir / "report.md"))
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
