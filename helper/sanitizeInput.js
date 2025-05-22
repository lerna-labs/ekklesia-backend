/**
 * Sanitizes user input by removing potentially harmful content while preserving URLs
 *
 * @param {string} text - The input text to sanitize
 * @returns {string|boolean} The sanitized text string, or false if input is not a string
 *
 * @description
 * This function performs the following sanitization steps:
 * 1. Validates that input is a string type
 * 2. Preserves URLs by temporarily replacing them with placeholders
 * 3. Removes HTML tags and HTML entities to prevent XSS attacks
 * 4. Removes potentially harmful special characters while keeping common useful ones
 * 5. Cleans up whitespace (trims and normalizes)
 * 6. Restores the preserved URLs
 *
 * This sanitization method allows safe formatting and URLs while preventing
 * common injection attacks and malformed inputs.
 */
export function sanitizeInput(text) {
  // Check if the input is a string
  if (typeof text !== "string") {
    return false;
  }

  // Store URLs temporarily to preserve them
  const urlPattern = /(https?:\/\/[^\s]+)/g;
  const urls = [];
  let tempText = text.replace(urlPattern, (match) => {
    urls.push(match);
    return `__URL_PLACEHOLDER_${urls.length - 1}__`;
  });

  // Remove HTML tags and decode HTML entities
  let sanitizedText = tempText
    .replace(/<[^>]*>/g, "")
    .replace(/&[a-zA-Z0-9#]+;/g, "");

  // Remove harmful special characters but preserve common useful characters
  const specialChars = /[^\w\s\n\r.,;:?!()[\]{}'"&$@#%*+=/\-_<>€£¥|~`^°]/g;
  sanitizedText = sanitizedText.replace(specialChars, "");

  // Remove leading and trailing whitespace
  sanitizedText = sanitizedText.trim();

  // Replace multiple spaces with a single space, but preserve line breaks
  sanitizedText = sanitizedText.replace(/[ \t]+/g, " ");

  // Restore URLs
  urls.forEach((url, index) => {
    sanitizedText = sanitizedText.replace(`__URL_PLACEHOLDER_${index}__`, url);
  });

  // Return the sanitized text
  return sanitizedText;
}
