/** Replaces every secret value (and its JSON-escaped form) in `text`. */
export function redact(text: string, secrets: string[], minimumLength = 8): string {
  let out = text;
  for (const secret of secrets)
    if (secret && secret.length >= minimumLength) {
      out = out.split(JSON.stringify(secret).slice(1, -1)).join("[redacted]");
      out = out.split(secret).join("[redacted]");
    }
  return out;
}
