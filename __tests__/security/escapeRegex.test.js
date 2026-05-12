// Regression coverage for issue #50 — `new RegExp(user_input)` used to
// throw a SyntaxError on unbalanced metacharacters and reflect the
// failing pattern in a 500. The escapeRegex helper neutralises every
// metachar so the pattern compiles to a literal substring match.

import { escapeRegex } from "../../helper/escapeRegex.js";

describe("escapeRegex (security)", () => {
  test("escapes every PCRE metacharacter", () => {
    const meta = ".*+?^${}()|[]\\";
    const escaped = escapeRegex(meta);
    // Each metachar is now preceded by exactly one backslash.
    expect(escaped).toBe(
      "\\.\\*\\+\\?\\^\\$\\{\\}\\(\\)\\|\\[\\]\\\\"
    );
  });

  test.each([
    "(",
    "[",
    "*",
    "(a",
    "(?P<x>a)",
    "a{99999}",
    "$()",
  ])("compiles cleanly for unbalanced input %p", (input) => {
    // The previous code path threw SyntaxError on these. After the
    // fix the escaped output must always produce a valid RegExp.
    expect(() => new RegExp(escapeRegex(input))).not.toThrow();
  });

  test("treats the escaped pattern as a literal match", () => {
    const re = new RegExp(escapeRegex("a(b)c"));
    expect(re.test("a(b)c")).toBe(true);
    // Without escaping the parens would have made `abc` match.
    expect(re.test("abc")).toBe(false);
  });

  test("coerces non-string input safely", () => {
    expect(escapeRegex(null)).toBe("");
    expect(escapeRegex(undefined)).toBe("");
    expect(escapeRegex(42)).toBe("42");
  });
});
