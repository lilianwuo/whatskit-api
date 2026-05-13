/**
 * Hashes an API key using SHA-256 and returns it as a hex string.
 * Used to compare against the key_hash column in public.api_keys.
 * The plaintext key is never stored — only the hash is persisted.
 */
export async function hashApiKey(key: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(key);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  // Return as hex string matching postgres bytea hex format (\\x...)
  return "\\x" + hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Generates a cryptographically secure API key.
 * Format: "wk_" + 32 random hex bytes = "wk_" + 64 chars = 67 chars total.
 * Returns { key, key_prefix, key_hash } — store only key_prefix and key_hash.
 */
export async function generateApiKey(): Promise<{
  key: string;
  key_prefix: string;
  key_hash: string;
}> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const key = `wk_${hex}`;
  const key_prefix = key.slice(0, 10); // "wk_" + first 7 hex chars
  const key_hash = await hashApiKey(key);
  return { key, key_prefix, key_hash };
}
