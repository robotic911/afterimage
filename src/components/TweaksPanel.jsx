import { useEffect, useState } from 'react';
import './TweaksPanel.css';

const COLORS = ['#000000', '#1f1f1f', '#4a4a4a', '#7a7a7a', '#ffffff'];
const TIMERS = [1, 3, 5, 10];

/**
 * Floating design-mode panel that mirrors the original tweaks UI.
 * Listens for Claude Design edit-mode postMessages and forwards edits back.
 */
export default function TweaksPanel({ primaryColor, countdown, onColorChange, onCountdownChange }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    function handler(e) {
      if (!e?.data?.type) return;
      if (e.data.type === '__activate_edit_mode') setOpen(true);
      if (e.data.type === '__deactivate_edit_mode') setOpen(false);
    }
    window.addEventListener('message', handler);
    window.parent.postMessage({ type: '__edit_mode_available' }, '*');
    return () => window.removeEventListener('message', handler);
  }, []);

  function setColor(c) {
    onColorChange(c);
    window.parent.postMessage({ type: '__edit_mode_set_keys', edits: { primaryColor: c } }, '*');
  }

  function setTimer(val) {
    onCountdownChange(val);
    window.parent.postMessage({ type: '__edit_mode_set_keys', edits: { countdown: val } }, '*');
  }

  return (
    <div id="tweaks-panel" className={open ? 'open' : ''}>
      <div className="tw-title">Tweaks</div>

      <div className="tw-row">
        <div className="tw-lbl">Primary Color</div>
        <div className="tw-swatches">
          {COLORS.map(c => (
            <div
              key={c}
              className={`tw-swatch ${primaryColor === c ? 'active' : ''}`}
              style={{ background: c }}
              onClick={() => setColor(c)}
            />
          ))}
        </div>
      </div>

      <div className="tw-row">
        <div className="tw-lbl">Countdown</div>
        <div className="tw-btns">
          {TIMERS.map(v => (
            <div
              key={v}
              className={`tw-btn ${countdown === v ? 'active' : ''}`}
              onClick={() => setTimer(v)}
            >
              {v}s
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
