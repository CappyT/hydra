/**
 * Navigation and IPC trust rules for the windows that carry the preload bridge.
 *
 * Game descriptions and other remote HTML are rendered inside those windows. A
 * link in that content must not move the window to another origin: the preload
 * would run there and hand the page every IPC call, sandbox toggles included.
 * Pure, so the rules are unit-testable.
 */

const parse = (value: string): URL | null => {
  try {
    return new URL(value);
  } catch {
    return null;
  }
};

export interface TrustedAppPages {
  /** Packaged documents, as `file:` URLs. Any other local file is foreign. */
  documents: string[];
  /** Renderer origins served over the network (the dev server). */
  origins: string[];
}

const withoutHash = (url: URL): string => {
  const copy = new URL(url.href);
  copy.hash = "";
  return copy.href;
};

/** The app's own pages. A local HTML file from a game folder is not one. */
export const isAppUrl = (value: string, trusted: TrustedAppPages): boolean => {
  const url = parse(value);
  if (!url) return false;
  if (url.protocol === "file:") {
    return trusted.documents.includes(withoutHash(url));
  }
  return trusted.origins.includes(url.origin);
};

/**
 * True when a window that shows an app page must refuse to navigate to
 * `target`. Routes live in the hash, so the only legitimate navigation is a
 * reload of the same document. Windows that show remote pages (login, hosters)
 * hold no bridge and are left alone.
 */
export const shouldBlockNavigation = (
  current: string,
  target: string,
  trusted: TrustedAppPages
): boolean => {
  if (!isAppUrl(current, trusted)) return false;
  const from = parse(current);
  const to = parse(target);
  if (!from || !to) return true;
  return withoutHash(from) !== withoutHash(to);
};
