"""Offline verification with unittest and a local mock HTTP server.

Mock emails and timings are fixtures, never benchmark results.
"""

import contextlib
import csv
import io
import json
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

import run_eval
from checks import CHECK_NAMES, check_output, count_words, currency_amounts, parse_email

CASES = run_eval.load_cases(run_eval.ROOT / "cases" / "cases.jsonl")
BODY = (
    "Hi {{first_name}},\n\n"
    "I wanted to follow up on your home search and the priorities you shared. "
    "There is no need to rush a decision, and we can keep the next step simple. "
    "Understanding what matters most to you would help focus our conversation "
    "before we discuss specific homes or make assumptions about the market. "
    "Could you reply with the one feature that matters most in your next home?\n\n"
    "Best,\n{{realtor_name}}"
)


def email_json(body=BODY, subject="A simple next step for your search"):
    return json.dumps({"subject": subject, "body": body})


def csv_rows(path):
    with path.open(newline="", encoding="utf-8-sig") as handle:
        return list(csv.DictReader(handle))


class CheckTests(unittest.TestCase):
    def check(self, body=BODY, subject="Your next step"):
        return check_output(email_json(body, subject), CASES[0])

    def test_good_email(self):
        result = self.check()
        self.assertTrue(result["all_pass"], result)
        self.assertIsNone(result["parse_error"])

    def test_strict_json_schema(self):
        invalid = ["not json", "```json\n" + email_json() + "\n```",
                   email_json() + " Thanks", "[]", "null",
                   '{"subject":"one","subject":"two","body":"hello"}',
                   '{"subject":"one","body":null}',
                   '{"subject":"one","body":NaN}',
                   '{"subject":" ","body":"hello"}',
                   '{"subject":"one","body":"hello","extra":true}']
        for raw in invalid:
            with self.subTest(raw=raw):
                result = check_output(raw, CASES[0])
                self.assertFalse(any(result["checks"].values()))
                self.assertIsNotNone(result["parse_error"])

    def test_word_boundaries(self):
        for n in (59, 60, 140, 141):
            with self.subTest(n=n):
                body = "{{first_name}} " + " ".join(["word"] * (n - 1))
                result = self.check(body)
                self.assertEqual(result["word_count"], n)
                self.assertEqual(result["checks"]["word_count"], 60 <= n <= 140)

    def test_merge_fields_count_as_one(self):
        self.assertEqual(count_words("Hi {{first_name}} {{preferred_area}} {{budget}} {{realtor_name}}"), 5)
        self.assertEqual(count_words("first-time buyer's home"), 3)

    def test_merge_field_rules(self):
        for text in ("{{address}}", "{{case_json}}", "{{ first_name }}", "{first_name}",
                     "{{first_name}", "Jordan"):
            with self.subTest(text=text):
                self.assertFalse(self.check(BODY + " " + text)["checks"]["allowed_merge_fields"])
        self.assertFalse(self.check(BODY.replace("{{first_name}}", "there"))["checks"]["allowed_merge_fields"])
        self.assertTrue(self.check(BODY + " {{preferred_area}} {{budget}}")["checks"]["allowed_merge_fields"])

    def test_url_variants_in_body_or_subject(self):
        for url in ("https://example.com", "www.example.com", "example.com/list",
                    "example.realtor", "example.top", "example.edu", "mailto:agent@example.com",
                    "http://localhost:3000", "127.0.0.1:3000/list", "ftp://example.org"):
            with self.subTest(url=url):
                self.assertFalse(self.check(BODY + " " + url)["checks"]["no_urls"])
                self.assertFalse(self.check(subject=url)["checks"]["no_urls"])

    def test_existing_currency_is_allowed(self):
        for amount in ("$425,000", "USD 425000", "425000 USD", "425k dollars",
                       "425000 dollars", "$425 thousand", "425000 $", "425k"):
            with self.subTest(amount=amount):
                self.assertTrue(self.check(BODY + " " + amount)["checks"]["no_new_currency_amounts"], amount)

    def test_new_currency_is_rejected(self):
        for amount in ("$426,000", "$425,000.01", "EUR 425000", "£425,000",
                       "425000 CAD", "$12.50", "USD 1.2m", "500k", "$1 million"):
            with self.subTest(amount=amount):
                self.assertFalse(self.check(BODY + " " + amount)["checks"]["no_new_currency_amounts"], amount)

    def test_amount_from_actual_reply_is_allowed(self):
        case = json.loads(json.dumps(CASES[0]))
        case["replied"] = True
        case["reply_text"] = "My comfortable monthly cost is $2,100."
        self.assertTrue(check_output(email_json(BODY + " USD 2100"), case)["checks"]["no_new_currency_amounts"])
        self.assertTrue(currency_amounts("USD 2.1k") == currency_amounts("$2,100"))

    def test_spelled_out_money_is_flagged(self):
        for amount in ("five hundred dollars", "twenty-five dollars", "fifty dollars", "$one hundred"):
            with self.subTest(amount=amount):
                self.assertFalse(self.check(BODY + " " + amount)["checks"]["no_new_currency_amounts"])

    def test_unsubscribe_variants(self):
        for phrase in ("unsubscribe", "opt-out", "opt out", "stop receiving emails",
                       "remove you from my list", "take you off the list", "reply STOP",
                       "no more emails", "stop these messages"):
            with self.subTest(phrase=phrase):
                self.assertFalse(self.check(BODY + " " + phrase)["checks"]["no_unsubscribe"])

    def test_bracket_placeholders(self):
        for placeholder in ("[Name]", "[Property Address]", "[insert link]", "<Name>", "${name}"):
            with self.subTest(placeholder=placeholder):
                self.assertFalse(self.check(BODY + " " + placeholder)["checks"]["no_bracket_placeholders"])


class RunnerTests(unittest.TestCase):
    def test_case_dataset_and_mix(self):
        self.assertEqual(len(CASES), 20)
        self.assertEqual(len({c["id"] for c in CASES}), 20)
        counts = {name: sum(c["scenario"] == name for c in CASES) for name in
                  ("no reply", "short positive reply", "question", "not ready yet", "price-sensitive")}
        self.assertEqual(counts, {"no reply": 5, "short positive reply": 3,
                                  "question": 4, "not ready yet": 4, "price-sensitive": 4})
        self.assertEqual({c["followup_number"] for c in CASES}, {2, 3, 4, 5})
        self.assertEqual({c["lead"]["type"] for c in CASES}, {"buyer", "seller"})

    def test_prompt_anonymizes_first_name(self):
        template = (run_eval.ROOT / "prompt.md").read_text(encoding="utf-8")
        for case in CASES:
            prompt = run_eval.render_prompt(template, case)
            self.assertNotIn(case["lead"]["first_name"], prompt)
            self.assertIn("{{first_name}}", prompt)
            self.assertNotIn("{{case_json}}", prompt)
            self.assertEqual(json.loads(prompt.split("CASE_JSON:\n", 1)[1])["id"], case["id"])

    def test_url_is_local_only(self):
        for url in ("http://localhost:11434", "http://127.0.0.1:5555", "http://[::1]:11434"):
            self.assertEqual(run_eval.local_base_url(url), url)
        for url in ("https://api.example.com", "http://example.com", "http://localhost/path",
                    "http://user:password@localhost", "http://localhost:invalid", "http://localhost?redirect=1"):
            with self.subTest(url=url), self.assertRaises(Exception):
                run_eval.local_base_url(url)

    def test_generate_duration_math_and_missing_metrics(self):
        data = {"done": True, "response": email_json(), "eval_count": 25,
                "eval_duration": 2000000000, "total_duration": 4000000000}
        with patch("run_eval.api_json", return_value=data):
            row = run_eval.generate(None, "http://localhost:11434", "qwen3.5:2b", CASES[0], "prompt", 3)
        self.assertEqual(row["generation_seconds"], 2.0)
        self.assertEqual(row["tokens_per_second"], 12.5)
        for duration in (None, 0):
            with patch("run_eval.api_json", return_value=dict(data, eval_duration=duration)):
                row = run_eval.generate(None, "http://localhost:11434", "phi4-mini:latest", CASES[0], "prompt", 3)
            self.assertIsNone(row["tokens_per_second"])

    def test_parse_and_api_failures_are_distinct(self):
        with patch("run_eval.api_json", return_value={"done": True, "response": "invalid"}):
            row = run_eval.generate(None, "http://localhost", "qwen3.5:2b", CASES[0], "prompt", 3)
        self.assertIsNone(row["api_error"])
        self.assertIsNotNone(row["parse_error"])
        with patch("run_eval.api_json", side_effect=ValueError("HTTP 500")):
            row = run_eval.generate(None, "http://localhost", "qwen3.5:2b", CASES[0], "prompt", 3)
        self.assertIsNotNone(row["api_error"])
        self.assertIsNone(row["parse_error"])
        self.assertFalse(row["all_pass"])

    def test_not_run_reports(self):
        with tempfile.TemporaryDirectory() as folder, contextlib.redirect_stdout(io.StringIO()):
            with patch("run_eval.api_json", side_effect=AssertionError("must not call Ollama")):
                self.assertEqual(run_eval.main(["--init-reports", "--output-dir", folder]), 0)
            path = Path(folder)
            rows = csv_rows(path / "report.csv")
            self.assertEqual(len(rows), 3)
            self.assertTrue(all(r["status"] == "not_run" and r["avg_tokens_per_second"] == "" for r in rows))
            self.assertTrue(all(r["human score (1–5)"] == "" for r in rows))
            text = (path / "report.md").read_text(encoding="utf-8")
            self.assertEqual(text.count("### case_"), 3)
            self.assertIn("Not run", text)

    def test_setup_failure_produces_honest_reports(self):
        with tempfile.TemporaryDirectory() as folder, contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            with patch("run_eval.api_json", side_effect=ValueError("Ollama unavailable")):
                self.assertEqual(run_eval.main(["--output-dir", folder]), 1)
            path = Path(folder)
            metadata = json.loads((path / "run_info.json").read_text())
            self.assertEqual(metadata["status"], "setup_failed")
            rows = csv_rows(path / "report.csv")
            self.assertTrue(all(r["cases_attempted"] == "0" and r["valid_json_pass_rate_pct"] == "" for r in rows))

    def test_full_mock_http_run_and_archival(self):
        calls = []

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def send(self, value, status=200):
                raw = json.dumps(value).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def do_GET(self):
                if self.path == "/api/version":
                    self.send({"version": "mock-test-only"})
                elif self.path == "/api/tags":
                    self.send({"models": [{"name": m, "digest": "test-fixture"} for m in run_eval.DEFAULT_MODELS]})
                else:
                    self.send({"error": "unknown endpoint"}, 404)

            def do_POST(self):
                payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                calls.append(payload)
                prompt = payload.get("prompt", "")
                if not prompt or prompt == "Reply OK.":
                    self.send({"done": True, "response": "OK"})
                    return
                case = json.loads(prompt.split("CASE_JSON:\n", 1)[1])
                if payload["model"] == "phi4-mini:latest" and case["id"] == "case_20":
                    self.send({"error": "simulated generation failure"}, 500)
                    return
                raw = "not json" if payload["model"] == "qwen3.5:2b" and case["id"] == "case_02" else email_json()
                self.send({"done": True, "response": raw, "eval_count": 25,
                           "eval_duration": 2000000000, "total_duration": 3000000000,
                           "prompt_eval_duration": 500000000, "load_duration": 0})

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            url = "http://127.0.0.1:" + str(server.server_port)
            with tempfile.TemporaryDirectory() as folder, contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(run_eval.main(["--base-url", url, "--output-dir", folder]), 1)
                path = Path(folder)
                records = [json.loads(line) for line in (path / "outputs.jsonl").read_text(encoding="utf-8").splitlines()]
                self.assertEqual(len(records), 60)
                self.assertEqual(sum(bool(r["parse_error"]) for r in records), 1)
                self.assertEqual(sum(bool(r["api_error"]) for r in records), 1)
                self.assertEqual(sum(r["all_pass"] for r in records), 58)
                rows = csv_rows(path / "report.csv")
                self.assertEqual([r["all_checks_pass_rate_pct"] for r in rows], ["95.0", "100.0", "95.0"])
                self.assertEqual([r["avg_tokens_per_second"] for r in rows], ["12.5"] * 3)
                self.assertTrue(all(r["human score (1–5)"] == "" for r in rows))
                self.assertEqual(len(csv_rows(path / "outputs.csv")), 60)
                self.assertIn("simulated generation failure", (path / "report.md").read_text())
                scored = [p for p in calls if "CASE_JSON:" in p.get("prompt", "")]
                self.assertEqual(len(scored), 60)
                self.assertTrue(all(p["format"] == "json" and p["stream"] is False for p in scored))
                self.assertTrue(all(p["think"] is False for p in scored if p["model"].startswith("qwen")))
                self.assertTrue(all("think" not in p for p in scored if p["model"].startswith("phi")))
                # A second (subset) run archives measurements and regenerates exactly one case/model.
                self.assertEqual(run_eval.main(["--base-url", url, "--output-dir", folder,
                                               "--models", "qwen3.5:4b", "--case-ids", "case_01"]), 0)
                archive = list(path.glob("previous_*"))
                self.assertEqual(len(archive), 1)
                self.assertEqual(len((archive[0] / "outputs.jsonl").read_text().splitlines()), 60)
                self.assertEqual(len((path / "outputs.jsonl").read_text().splitlines()), 1)
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == "__main__":
    unittest.main(verbosity=2)
