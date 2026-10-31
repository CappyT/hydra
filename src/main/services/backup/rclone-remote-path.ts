/**
 * Returns the remote prefix with exactly one `/` before the next path segment.
 * A bare `name:` becomes `name:/`, the absolute form that earlier builds wrote
 * to: switching to `name:` (relative to the remote home) would hide their
 * backups. A remote that already ends with `/` is not doubled.
 */
export const rcloneRemoteBase = (remote: string): string =>
  remote.endsWith("/") ? remote : `${remote}/`;
