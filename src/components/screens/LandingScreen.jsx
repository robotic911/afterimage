import './LandingScreen.css';
import typoWhite from '../../assets/ai-typo-white.png';
import {
  buildThemeStyle,
  resolveEventColorTheme,
} from '../../constants/colorThemes';

export default function LandingScreen({
  active,
  settings = { mode: 'daily', activeEventId: null, testModeEnabled: false },
  events = [],
  onStart,
}) {
  const activeEvent = settings.mode === 'event'
    ? events.find((event) => event.id === settings.activeEventId) || null
    : null;
  const theme = resolveEventColorTheme(activeEvent);
  const eventBackground = activeEvent?.landingBackground || { type: 'none', src: null };
  const hasEventBranding = settings.mode === 'event' && activeEvent;
  const hasEventBackground = hasEventBranding
    && eventBackground.src
    && ['image', 'video'].includes(eventBackground.type);
  const themeStyle = hasEventBranding ? buildThemeStyle(theme) : undefined;
  const testModeEnabled = settings.testModeEnabled === true;

  return (
    <div
      className={`screen ${active ? 'active' : ''} ${hasEventBranding ? 'event-branded' : ''}`}
      id="s-landing"
      data-screen-label="01 Landing"
      style={themeStyle}
    >
      {hasEventBackground && eventBackground.type === 'image' && (
        <img className="landing-event-bg" src={eventBackground.src} alt="" aria-hidden="true" />
      )}
      {hasEventBackground && eventBackground.type === 'video' && (
        <video
          className="landing-event-bg"
          src={eventBackground.src}
          autoPlay
          muted
          loop
          playsInline
          aria-hidden="true"
        />
      )}
      {hasEventBackground && <div className="landing-event-scrim" aria-hidden="true" />}
      {testModeEnabled && (
        <div className="landing-test-badge">
          TEST MODE
        </div>
      )}
      <div className="landing-top">
        {hasEventBranding && (
          <div className="landing-event-kicker">{activeEvent.name}</div>
        )}
        <div className="afterimage-wordmark">
          <img src={typoWhite} alt="Afterimage" />
        </div>
        {/* <p className="landing-desc">Step in, choose your frame, and walk away with photos worth keeping.</p> */}

        {/* <h1 className="landing-headline">Strike a <em>pose.</em></h1> */}

        <button className="btn-landing landing-shutter-start" onClick={onStart} aria-label="Tap to begin photo session">
          <span className="shutter-target" aria-hidden="true">
            <span className="shutter-core" />
          </span>
          <span className="shutter-copy">Tap to Begin</span>
        </button>
      </div>
    </div>
  );
}
