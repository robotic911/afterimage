import { useEffect } from 'react';

/**
 * Scales the fixed 1920×1080 stage to fit the current viewport while preserving aspect ratio.
 * Apply the returned ref to the stage element.
 */
export function useStageScale(stageRef) {
  useEffect(() => {
    const scale = () => {
      const el = stageRef.current;
      if (!el) return;
      const s = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
      el.style.transform = `scale(${s})`;
    };
    scale();
    window.addEventListener('resize', scale);
    return () => window.removeEventListener('resize', scale);
  }, [stageRef]);
}
