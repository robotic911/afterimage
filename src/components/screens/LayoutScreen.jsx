import './LayoutScreen.css';
import PageHeader from '../PageHeader';
import { LAYOUTS } from '../../constants/layouts';

// First step in the customer flow — pick the photo arrangement
// (number of shots + how they're laid out on the print). The chosen
// layout drives:
//   • how many captures the camera takes
//   • where photos land on the printed strip (slot coordinates)
//   • the canvas aspect ratio (portrait vs landscape)
//
// The decorative design / background / frame is picked LATER, after
// the camera session, on SelectionScreen — so the customer can see
// their actual photos before committing to a look.
export default function LayoutScreen({
  active,
  selectedLayout,
  layouts = LAYOUTS,
  onSelect,
  onBack,
  onNext,
}) {
  const availableLayouts = layouts.length ? layouts : [];

  return (
    <div className={`screen ${active ? 'active' : ''}`} id="s-layout" data-screen-label="02 Layout">
      <PageHeader
        step="Step 1 of 6"
        title="Choose Your Layout"
        subtitle="Pick how your photos will be arranged"
        pills={['active', '', '', '', '', '']}
      />

      <div className="layout-body">
        {availableLayouts.length === 0 ? (
          <div className="layout-empty-state">
            <div className="layout-empty-title">No layouts are currently available.</div>
            <div className="layout-empty-copy">Please enable a layout in Admin.</div>
          </div>
        ) : availableLayouts.map((l) => (
          <button
            type="button"
            key={l.id}
            id={`lay-${l.id}`}
            className={`layout-card ${selectedLayout === l.id ? 'selected' : ''}`}
            onClick={() => onSelect(l.id)}
            aria-pressed={selectedLayout === l.id}
          >
            <div className="layout-img-wrap">
              <img src={l.previewSrc || l.frameSrc} alt={l.name} loading="lazy" decoding="async" />
              <div className="layout-badge">✓ Selected</div>
            </div>
            <div className="layout-info">
              <div className="layout-name">{l.name}</div>
              <div className="layout-desc">{l.desc}</div>
              <div className="layout-meta">
                {l.tags.map((tag) => (
                  <span className="layout-tag" key={tag}>{tag}</span>
                ))}
              </div>
            </div>
          </button>
        ))}
      </div>

      <div className="page-footer">
        <button className="btn-ghost" onClick={onBack}>← Back</button>
        <button
          className="btn-primary"
          id="btn-layout-next"
          disabled={!selectedLayout || availableLayouts.length === 0}
          onClick={onNext}
        >
          Continue to Instructions →
        </button>
      </div>
    </div>
  );
}
