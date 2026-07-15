import { useEffect, useRef, useState } from 'react';
import './EndScreen.css';

/**
 * Shows a thank-you screen, then returns to the landing screen after 15 seconds.
 */
export default function EndScreen({ active, onReturn }) {
  const RESET_DELAY_SECONDS = 15;
  const [remaining, setRemaining] = useState(RESET_DELAY_SECONDS);
  const intervalRef = useRef(null);

  useEffect(() => {
    if (!active) return;
    queueMicrotask(() => setRemaining(RESET_DELAY_SECONDS));

    intervalRef.current = setInterval(() => {
      setRemaining(prev => {
        const next = prev - 1;
        if (next <= 0) {
          clearInterval(intervalRef.current);
          intervalRef.current = null;
          onReturn();
          return 0;
        }
        return next;
      });
    }, 1000);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [active, onReturn]);

  const pct = Math.max(0, (remaining / RESET_DELAY_SECONDS) * 100);

  return (
    <div className={`screen ${active ? 'active' : ''}`} id="s-end" data-screen-label="06 Session End">
      <div className="end-bg-radial" />
      <div className="end-inner">
        <div className="end-tick">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </div>
        <div className="end-headline">Thank<br />You<span>!</span></div>
        <div className="end-sub">Exit on your right and wait for the photos to be printed.</div>
        <div className="end-progress-wrap">
          <div className="end-progress-bar" id="end-bar" style={{ width: `${pct}%` }} />
        </div>
        <div className="end-countdown-txt" id="end-txt">
          Returning home in {remaining} second{remaining !== 1 ? 's' : ''}.
        </div>
      </div>
    </div>
  );
}
