// A reporter for people who only want the answer.
//
// Prints nothing while the suite runs. At the end: one line per failure -
// the test name, the file it is in, and the first line of its error - then
// the counts. That is the whole output, which makes it the thing to paste
// into a message when something breaks, and short enough to read in CI.
//
// Used by `npm run test:quiet`.
import path from "node:path";

const first = (text) => String(text || "").split("\n").map(s => s.trim()).filter(Boolean)[0] || "";

function errorLine(err) {
  if (!err) return "";
  // node:test wraps a thrown error once; the useful message is inside.
  const cause = err.cause || err;
  if (cause && cause.code === "ERR_TEST_FAILURE" && cause.cause) return errorLine(cause.cause);
  if (cause && cause.message) {
    const msg = first(cause.message);
    // An assertion's message is often the whole diff; its first line says
    // what kind of mismatch it was, which is enough to triage.
    if (cause.expected !== undefined && cause.actual !== undefined && !msg) {
      return "expected " + JSON.stringify(cause.expected) + ", got " + JSON.stringify(cause.actual);
    }
    return msg;
  }
  return first(String(cause));
}

export default async function* quiet(source) {
  const failures = [];
  let pass = 0;
  let fail = 0;
  let skip = 0;
  let todo = 0;

  for await (const event of source) {
    switch (event.type) {
      case "test:pass":
        if (event.data.skip) skip++;
        else if (event.data.todo) todo++;
        else pass++;
        break;
      case "test:fail": {
        // A failing file reports both the test and its parent suite, and a
        // suite with no name of its own is noise.
        fail++;
        const file = event.data.file ? path.relative(process.cwd(), event.data.file) : "";
        failures.push({
          name: event.data.name,
          file,
          line: event.data.line,
          message: errorLine(event.data.details && event.data.details.error)
        });
        break;
      }
      case "test:stderr": {
        // Only our own guard lines (skip-reason.mjs prints
        // "SKIP <library> unavailable - ..."): they explain a skipped count
        // that would otherwise look wrong. Everything else a dependency
        // decides to print - jsdom's unimplemented navigation, deprecation
        // notices - is what this reporter exists to keep out of the way.
        const lines = String(event.data.message).split("\n");
        for (const line of lines) {
          const t = line.trim();
          if (t.startsWith("SKIP ")) yield t + "\n";
        }
        break;
      }
      default:
        break;
    }
  }

  if (failures.length) {
    yield "\nFAILURES\n";
    for (const f of failures) {
      yield `  ${f.name}\n    ${f.file}${f.line ? ":" + f.line : ""}\n    ${f.message}\n`;
    }
  }

  const parts = [`pass ${pass}`, `fail ${fail}`];
  if (skip) parts.push(`skipped ${skip}`);
  if (todo) parts.push(`todo ${todo}`);
  yield `\n${failures.length ? "FAILED" : "OK"} — ${parts.join(", ")}\n`;
}
