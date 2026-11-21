// randomUUID is unavailable on the HTTP demo origin; getRandomValues still works.
export function requestId(source = globalThis.crypto) {
  if (typeof source?.randomUUID === 'function') return source.randomUUID();
  const bytes = new Uint8Array(16);
  source.getRandomValues(bytes);
  return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
}
