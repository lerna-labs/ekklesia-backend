// Escape PCRE metacharacters in a user-supplied string so it can be
// passed safely as the body of a MongoDB `$regex` filter (or to
// `new RegExp(...)`). This is NOT an HTML escape — see validator.escape
// for that. The character class covers every metachar the JavaScript
// RegExp engine treats as syntactic, so a partially-typed pattern like
// "(" or "[" stops throwing SyntaxError at compile time.

export function escapeRegex(input) {
  return String(input ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
