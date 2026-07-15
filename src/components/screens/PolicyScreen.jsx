import './PolicyScreen.css';

const RULES = [
  { title: 'Stay inside the frame', body: 'Make sure everyone is visible on the screen before the countdown starts.' },
  { title: 'You have one retake', body: 'You can retake the full photo set once if needed.' },
  { title: 'Review before printing', body: 'Check your photos and background carefully before pressing Print Photos.' },
];

export default function PolicyScreen({ active, countdown, totalShots = 4, onBack, onNext }) {
  return (
    <div className={`screen ${active ? 'active' : ''}`} id="s-policy" data-screen-label="03 Policy">
      <div className="policy-body">
        <div className="policy-left">
          <div className="policy-left-title">
            Before You <span>Start</span>
          </div>

          <div className="policy-stat-card">
            <div className="pstat-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
            </div>
            <div>
              <div className="pstat-val" id="p-timer">{countdown}s</div>
              <div className="pstat-lbl">Countdown per shot</div>
            </div>
          </div>

          <div className="policy-stat-card">
            <div className="pstat-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                <circle cx="12" cy="13" r="4" />
              </svg>
            </div>
            <div>
              <div className="pstat-val">{totalShots} shots</div>
              <div className="pstat-lbl">Per session</div>
            </div>
          </div>

          <div className="policy-stat-card">
            <div className="pstat-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="1 4 1 10 7 10" />
                <path d="M3.51 15a9 9 0 1 0 .49-4.5" />
              </svg>
            </div>
            <div>
              <div className="pstat-val">1 retry</div>
              <div className="pstat-lbl">Allowed per session</div>
            </div>
          </div>

          <div className="policy-rules" aria-label="Photo session instructions">
            {RULES.map((rule, index) => (
              <div className="rule-card" key={rule.title}>
                <div className="rule-num">{index + 1}</div>
                <div className="rule-content">
                  <h4>{rule.title}</h4>
                  <p>{rule.body}</p>
                </div>
              </div>
            ))}
          </div>

          <div className="policy-actions">
            <button className="btn-ghost" onClick={onBack}>← Back</button>
            <button className="btn-primary" onClick={onNext}>Start Camera →</button>
          </div>
        </div>
      </div>
    </div>
  );
}
