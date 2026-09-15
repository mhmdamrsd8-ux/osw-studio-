/**
 * What `session_start` carries about where the session came from.
 *
 * Referrer and campaign are the two things the funnel could not answer: 94% of arrivals were
 * "the HF Space" and nothing said what sent them there. Only the referrer's hostname is kept,
 * never its path or query, and only the three standard UTM keys, truncated. No URLs.
 */
type SessionStartFields = Record<string, string> & {
  referrer_host?: string;
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
};

const MAX_UTM = 64;

export function sessionStartFields(referrer: string, search: string, ownHost: string): SessionStartFields {
  const fields: SessionStartFields = {};
  if (referrer) {
    try {
      const host = new URL(referrer).hostname;
      // A same-origin referrer is an in-app navigation, not an arrival.
      if (host && host !== ownHost) fields.referrer_host = host;
    } catch { /* not a URL; carry nothing */ }
  }
  const params = new URLSearchParams(search);
  for (const key of ['utm_source', 'utm_medium', 'utm_campaign'] as const) {
    const value = params.get(key)?.trim();
    if (value) fields[key] = value.slice(0, MAX_UTM);
  }
  return fields;
}
