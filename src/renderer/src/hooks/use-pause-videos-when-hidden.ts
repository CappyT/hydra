import { useEffect } from "react";

/**
 * Pauses every playing <video> while the window is hidden (minimized or fully
 * occluded) and resumes them when it becomes visible again.
 *
 * Without this, Chromium suspends decoding of muted videos in hidden windows
 * while their reference clock keeps running, so on restore the video visibly
 * fast-forwards ("catches up") to where the clock says it should be. Pausing
 * freezes the clock too, so playback resumes exactly where it left off.
 */
export function usePauseVideosWhenHidden() {
  useEffect(() => {
    const pausedByVisibility = new Set<HTMLVideoElement>();

    const onVisibilityChange = () => {
      if (document.hidden) {
        for (const video of document.querySelectorAll("video")) {
          if (!video.paused && !video.ended) {
            video.pause();
            pausedByVisibility.add(video);
          }
        }
      } else {
        for (const video of pausedByVisibility) {
          if (video.isConnected) {
            video.play().catch(() => {});
          }
        }
        pausedByVisibility.clear();
      }
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);
}
