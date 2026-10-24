"""Deterministic output checks. Standard library only; no JSON repair."""

import json
import re
from decimal import Decimal, InvalidOperation

ALLOWED_MERGE_FIELDS = {"first_name", "preferred_area", "budget", "realtor_name"}
CHECK_NAMES = (
    "valid_json", "word_count", "allowed_merge_fields", "no_urls",
    "no_new_currency_amounts", "no_unsubscribe", "no_bracket_placeholders",
)
FIELD = re.compile(r"\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}")
WORD = re.compile(r"\b\w+(?:['’\-]\w+)*\b", re.UNICODE)
URL = re.compile(
    r"(?:\b[a-z][a-z0-9+.-]*://|\bwww\.|\bmailto:|"
    r"\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+"
    r"(?:[a-z]{2,63}|xn--[a-z0-9-]+)\b|"
    r"\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?(?:/\S*)?)", re.I,
)
UNSUBSCRIBE = re.compile(
    r"\b(?:unsubscrib\w*|opt[\s-]*out|stop (?:receiving|sending|emailing|contacting)|"
    r"do not (?:email|contact)|don't (?:email|contact)|"
    r"remove (?:me|you|yourself|my (?:name|email)|your (?:name|email)) "
    r"from|take (?:me|you) off|no (?:more|further) (?:emails|messages)|"
    r"reply\s+[\"']?stop|stop these (?:emails|messages))\b", re.I,
)
PLACEHOLDER = re.compile(r"\[[^\]\n]+\]|<[^>\n]+>|\$\{[^}\n]+\}")

# Compare currency + normalized value, so USD 450k equals $450,000 but EUR
# 450,000 does not. Bare "450k" is treated as an implied USD amount in these US cases.
NUMBER = r"\d+(?:,\d{3})*(?:\.\d+)?(?:\s*(?:thousand|million|billion|[kmb])\b)?"
CURRENCY = r"US\$|CA\$|C\$|A\$|USD|CAD|AUD|EUR|GBP|PKR|INR|\$|€|£|₨|₹"
MONEY = re.compile(
    rf"(?P<prefix>{CURRENCY})\s*(?P<value>{NUMBER})"
    rf"|(?P<suffix_value>{NUMBER})\s*(?P<suffix>{CURRENCY}|dollars?|euros?|pounds?|rupees?)(?!\w)"
    rf"|(?P<bare>\d+(?:\.\d+)?\s*(?:[kmb]|thousand|million|billion))\b",
    re.I,
)
NUMBER_WORD = (r"zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|"
               r"thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|"
               r"thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion")
MONEY_WORDS = re.compile(
    r"(?:\b(?:USD|CAD|AUD|EUR|GBP|PKR|INR)\b|[$€£₨₹])\s*"
    rf"(?:{NUMBER_WORD})\b|\b(?:{NUMBER_WORD})"
    rf"(?:[\s-]+(?:{NUMBER_WORD}|and)){{0,12}}\s+(?:dollars?|euros?|pounds?|rupees?)\b", re.I,
)


def _pairs_no_duplicates(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key: " + key)
        result[key] = value
    return result


def _reject_constant(value):
    raise ValueError("non-JSON constant: " + value)


def parse_email(raw):
    """Return (email, error); reject fences, trailing text, duplicate keys, NaN."""
    try:
        email = json.loads(raw, object_pairs_hook=_pairs_no_duplicates,
                           parse_constant=_reject_constant)
        if not isinstance(email, dict) or set(email) != {"subject", "body"}:
            raise ValueError("expected exactly subject and body")
        if any(not isinstance(email[k], str) or not email[k].strip()
               for k in ("subject", "body")):
            raise ValueError("subject and body must be nonempty strings")
        return email, None
    except (ValueError, TypeError) as exc:
        return None, str(exc)


def count_words(body):
    return len(WORD.findall(FIELD.sub("MERGEFIELD", body)))


def _normalize_amount(text):
    text = text.lower().replace(",", "").replace(" ", "")
    factors = {"thousand": 1000, "million": 1000000, "billion": 1000000000,
               "k": 1000, "m": 1000000, "b": 1000000000}
    for suffix, factor in factors.items():
        if text.endswith(suffix):
            return Decimal(text[:-len(suffix)]) * factor
    return Decimal(text)


def _currency(marker):
    marker = marker.upper()
    return {"$": "USD", "US$": "USD", "DOLLAR": "USD", "DOLLARS": "USD",
            "CA$": "CAD", "C$": "CAD", "A$": "AUD", "€": "EUR",
            "EURO": "EUR", "EUROS": "EUR", "£": "GBP", "POUND": "GBP",
            "POUNDS": "GBP", "₨": "PKR", "RUPEE": "PKR", "RUPEES": "PKR",
            "₹": "INR"}.get(marker, marker)


def currency_amounts(text):
    found = set()
    for match in MONEY.finditer(text):
        value = match.group("value") or match.group("suffix_value") or match.group("bare")
        marker = match.group("prefix") or match.group("suffix") or "USD"
        try:
            found.add((_currency(marker), _normalize_amount(value)))
        except InvalidOperation:
            pass
    return found


def _case_amounts(case):
    amounts = currency_amounts(json.dumps(case, ensure_ascii=False))
    budget = case["lead"]["budget"]
    amounts.add((budget["currency"].upper(), Decimal(str(budget["amount"]))))
    return amounts


def check_output(raw, case):
    email, error = parse_email(raw)
    checks = dict.fromkeys(CHECK_NAMES, False)
    details = {}
    if email is None:
        return {"checks": checks, "all_pass": False, "word_count": None,
                "parse_error": error, "email": None, "details": details}
    checks["valid_json"] = True
    body = email["body"]
    text = email["subject"] + "\n" + body
    words = count_words(body)
    checks["word_count"] = 60 <= words <= 140
    fields = FIELD.findall(text)
    # Exact syntax, no unsupported/malformed single or double curly placeholders.
    bad_fields = [m.group(0) for m in FIELD.finditer(text)
                  if m.group(1) not in ALLOWED_MERGE_FIELDS
                  or m.group(0) != "{{" + m.group(1) + "}}"]
    remaining = FIELD.sub("", text)
    literal_name = bool(re.search(r"\b" + re.escape(case["lead"]["first_name"]) + r"\b", text, re.I))
    checks["allowed_merge_fields"] = (
        not bad_fields and "{" not in remaining and "}" not in remaining
        and "first_name" in fields and not literal_name
    )
    checks["no_urls"] = not URL.search(text)
    new_amounts = currency_amounts(text) - _case_amounts(case)
    # Conservatively flag spelled-out money for manual review; the prompt forbids amounts.
    checks["no_new_currency_amounts"] = not new_amounts and not MONEY_WORDS.search(text)
    checks["no_unsubscribe"] = not UNSUBSCRIBE.search(text)
    checks["no_bracket_placeholders"] = not PLACEHOLDER.search(text)
    if bad_fields or literal_name or not checks["allowed_merge_fields"]:
        details["merge_fields"] = {"fields": fields, "invalid": bad_fields,
                                    "literal_first_name": literal_name}
    if new_amounts:
        details["new_currency_amounts"] = sorted(c + " " + str(v) for c, v in new_amounts)
    return {"checks": checks, "all_pass": all(checks.values()), "word_count": words,
            "parse_error": None, "email": email, "details": details}
