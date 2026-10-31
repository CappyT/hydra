/**
 * Returns the remote prefix with exactly one separator before the next path
 * segment. `name:` stays `name:` (a `/` would make it an absolute path on
 * local, sftp and ftp remotes); `name:dir/` stays `name:dir/`.
 */
export const rcloneRemoteBase = (remote: string): string =>
  remote.endsWith(":") || remote.endsWith("/") ? remote : `${remote}/`;
