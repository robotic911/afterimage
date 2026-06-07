import { useCallback, useEffect, useState } from 'react';
import './AdminPinScreen.css';

// 4-digit PIN pad. On submit we hand the PIN to Electron's hashed
// checker via adminApi.checkPin; correct → onUnlock(), wrong → shake
// the display and clear. No click-through for customers.

const PIN_LENGTH = 4;

export default function AdminPinScreen({ active, onUnlock, onCancel }) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState(false);
  const [checking, setChecking] = useState(false);

  // Reset whenever the screen (de)activates
  useEffect(() => {
    if (!active) return;
    queueMicrotask(() => {
      setPin('');
      setError(false);
      setChecking(false);
    });
  }, [active]);

  const press = useCallback((d) => {
    if (checking) return;
    setError(false);
    setPin(p => (p.length >= PIN_LENGTH ? p : p + d));
  }, [checking]);

  const backspace = useCallback(() => {
    if (checking) return;
    setError(false);
    setPin(p => p.slice(0, -1));
  }, [checking]);

  const submit = useCallback(async () => {
    if (pin.length !== PIN_LENGTH || checking) return;
    if (!window.adminApi?.checkPin) {
      setError(true);
      return;
    }
    setChecking(true);
    try {
      const res = await window.adminApi.checkPin(pin);
      if (res?.ok) {
        onUnlock?.();
      } else {
        setError(true);
        setPin('');
      }
    } catch {
      setError(true);
      setPin('');
    } finally {
      setChecking(false);
    }
  }, [checking, onUnlock, pin]);

  // Allow physical keyboard entry for admin access:
  // digits append, Backspace deletes, Enter submits, Esc cancels.
  useEffect(() => {
    if (!active) return;
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel?.();
        return;
      }
      if (/^\d$/.test(e.key)) {
        e.preventDefault();
        press(e.key);
        return;
      }
      if (e.key === 'Backspace') {
        e.preventDefault();
        backspace();
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        submit();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, backspace, onCancel, press, submit]);

  // Auto-submit when the 4th digit is entered
  useEffect(() => {
    if (!active || pin.length !== PIN_LENGTH) return;
    queueMicrotask(() => {
      submit();
    });
  }, [active, pin.length, submit]);

  return (
    <div className={`screen admin-screen ${active ? 'active' : ''}`} id="s-admin-pin" data-screen-label="Admin PIN">
      <div className="pin-wrap">
        <div className="pin-title">Admin Access</div>
        <div className="pin-subtitle">Enter 4-digit PIN</div>

        <div className={`pin-dots ${error ? 'error' : ''}`}>
          {Array.from({ length: PIN_LENGTH }).map((_, i) => (
            <div key={i} className={`pin-dot ${i < pin.length ? 'filled' : ''}`} />
          ))}
        </div>

        <div className="pin-error-text">{error ? 'Incorrect PIN — try again' : '\u00A0'}</div>

        <div className="pin-pad">
          {[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => (
            <button key={n} className="pin-key" onClick={() => press(String(n))} disabled={checking}>
              {n}
            </button>
          ))}
          <button className="pin-key ghost" onClick={backspace} disabled={checking || !pin}>
            ⌫
          </button>
          <button className="pin-key" onClick={() => press('0')} disabled={checking}>0</button>
          <button className="pin-key ghost" onClick={onCancel} disabled={checking}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
