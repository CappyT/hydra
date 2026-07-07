/**
 * Accountless mode flag.
 *
 * When `true`, every feature that requires a Hydra account/login is gated off
 * (auth UI, SSE, remote library/achievement sync, download-sources polling,
 * friends/profile/reviews/subscription surfaces). Anonymous features
 * (catalogue, download sources, achievements metadata, cloud-save UI, etc.)
 * keep working. This keeps the fork mergeable with upstream: everything is
 * disabled by gating, not by deletion.
 */
export const ACCOUNTLESS = true;
