import { useEffect, useMemo } from 'react';
import './SelectionScreen.css';
import PageHeader from '../PageHeader';
import LayoutPreview from '../LayoutPreview';
import { FILTERS } from '../../constants/filters';
import {
  dedupeVisibleCustomerTemplates,
  isTemplateVisibleToCustomer,
} from '../../lib/templateVisibility';
import { versionTemplateAssetSrc } from '../../lib/templateAssetUrl';
import { preloadImageCached } from '../../lib/imageCache';

export default function SelectionScreen({
  active,
  layout,
  shots = [],
  templates = [],
  settings = { mode: 'daily', activeEventId: null },
  selectedFilter = 'none',
  onSelectFilter,
  selectedTmpl,
  onSelect,
  onBack,
  onNext,
}) {
  const layoutId = layout?.id;
  const visibilitySummary = useMemo(() => {
    const candidates = templates.filter((t) => {
      if (!t.layoutId || !layoutId || t.layoutId !== layoutId) return false;
      const mode = t.mode || 'daily';
      if (settings.mode === 'daily') return mode === 'daily';
      if (!settings.activeEventId) return false;
      return mode === 'event' && t.eventId === settings.activeEventId;
    });

    const hiddenByEnabled = candidates.filter((template) => template.enabled === false).length;
    const hiddenByHidden = candidates.filter((template) => template.hidden === true || template.deleted === true).length;
    const hiddenByInvalidLayout = templates.filter((template) => !template.layoutId).length;

    return {
      before: candidates.length,
      hiddenByEnabled,
      hiddenByHidden,
      hiddenByInvalidLayout,
    };
  }, [templates, layoutId, settings.mode, settings.activeEventId]);

  const visible = useMemo(() => (
    dedupeVisibleCustomerTemplates(
      templates
        .filter((t) => {
          if (!isTemplateVisibleToCustomer(t, layout, settings)) return false;
          if (!t.layoutId || !layoutId || t.layoutId !== layoutId) return false;

          const mode = t.mode || 'daily';
          if (settings.mode === 'daily') {
            return mode === 'daily';
          }

          if (!settings.activeEventId) return false;
          return mode === 'event' && t.eventId === settings.activeEventId;
        })
    )
      .sort((a, b) => {
        const typeA = a.type || 'Uncategorized';
        const typeB = b.type || 'Uncategorized';
        return typeA.localeCompare(typeB) || a.name.localeCompare(b.name);
      })
  ), [templates, layout, layoutId, settings]);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    console.log('[templates] customer visible templates', {
      before: visibilitySummary.before,
      after: visible.length,
      hiddenByEnabled: visibilitySummary.hiddenByEnabled,
      hiddenByLayout: visibilitySummary.hiddenByHidden,
      hiddenByInvalidLayout: visibilitySummary.hiddenByInvalidLayout,
    });
  }, [visibilitySummary, visible.length]);
  const selectedTemplate = selectedTmpl
    ? visible.find(t => t.id === selectedTmpl) || null
    : null;
  const selectedTemplateForLayout = selectedTemplate?.layoutId === layout?.id &&
    selectedTemplate?.layoutId === layoutId
    ? selectedTemplate
    : null;
  const selectedFilterMeta = FILTERS.find(f => f.id === selectedFilter) || FILTERS[0];

  useEffect(() => {
    if (!import.meta.env.DEV || !selectedTemplateForLayout) return;
    console.log('[background] selected template fields', {
      id: selectedTemplateForLayout.id,
      name: selectedTemplateForLayout.name,
      previewSrc: selectedTemplateForLayout.previewSrc || null,
      overlaySrc: selectedTemplateForLayout.overlaySrc || null,
      cardUses: selectedTemplateForLayout.previewSrc || null,
      mainPreviewUses: selectedTemplateForLayout.overlaySrc || null,
    });
  }, [selectedTemplateForLayout]);

  useEffect(() => {
    if (!active || !selectedTemplateForLayout) return;
    const overlaySrc = versionTemplateAssetSrc(
      selectedTemplateForLayout.overlaySrc || selectedTemplateForLayout.src,
      selectedTemplateForLayout,
    );
    preloadImageCached(overlaySrc).catch(() => {});
  }, [active, selectedTemplateForLayout]);

  return (
    <div className={`screen ${active ? 'active' : ''}`} id="s-selection" data-screen-label="06 Background">
      <PageHeader
        step="Step 5 of 6"
        title="Select Background"
        subtitle="Pick the frame, overlay or background for your photos"
        pills={['done', 'done', 'done', 'done', 'active', '']}
      />

      <div className="sel-body">
        <div className="sel-preview-panel">
          <div className="sel-card-header" />

          <LayoutPreview
            layout={layout}
            shots={shots}
            frameSrc={null}
            frameAlt=""
            templateSrc={versionTemplateAssetSrc(selectedTemplateForLayout?.overlaySrc, selectedTemplateForLayout)}
            templateAlt={selectedTemplateForLayout?.name}
            className="sel-preview-wrap"
            cellClassName="sel-preview-cell"
            frameClassName="sel-preview-frame-image"
            overlayClassName="sel-preview-template"
            photoFilter={selectedFilterMeta.css}
          />
        </div>

        <div className="sel-options-panel">
          <div className="sel-options-box">
            

            <div className="sel-filters-section">
              <div className="sel-filters-header">
                <div>
                  <div className="sel-card-kicker">Filters</div>
                  <div className="sel-filters-title">Choose a filter</div>
                </div>
              </div>

              <div className="sel-filter-grid">
                {FILTERS.map(filter => (
                  <button
                    key={filter.id}
                    type="button"
                    className={`sel-filter-card ${selectedFilter === filter.id ? 'active' : ''}`}
                    onClick={() => onSelectFilter?.(filter.id)}
                  >
                    <span
                      className="sel-filter-swatch"
                      style={{
                        background: filter.bg,
                        filter: filter.css || 'none',
                      }}
                    >
                      <span className="sel-filter-swatch-shine" />
                    </span>
                    <span className="sel-filter-copy">
                      <span className="sel-filter-name">{filter.name}</span>
                      <span className="sel-filter-desc">{filter.desc}</span>
                    </span>
                    <span className="sel-filter-check" aria-hidden="true">✓</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="sel-card-header">
              <div>
                <div className="sel-card-kicker">Backgrounds</div>
                <div className="sel-card-title">Choose a background</div>
                {/* {settings.mode === 'event' && activeEvent && (
                  <div className="sel-card-mode-note">
                    {activeEvent.name}
                  </div>
                )} */}
              </div>
              <div className="sel-card-count">{visible.length} options</div>
            </div>
            
            {settings.mode === 'event' && !settings.activeEventId && (
              <div className="sel-empty">
                No active event selected. Please ask the admin to select an event.
              </div>
            )}

            {visible.length === 0 && !(settings.mode === 'event' && !settings.activeEventId) && (
              <div className="sel-empty">
                {settings.mode === 'event' && settings.activeEventId
                  ? 'No event templates available for this layout. Please ask the admin to set one up.'
                  : 'No templates available. Please ask the attendant to set one up.'}
              </div>
            )}

            <div className="sel-grid">
              {visible.map(t => (
                <button
                  key={t.id}
                  id={`tmpl-${t.id}`}
                  type="button"
                  className={`tmpl-card ${selectedTemplateForLayout?.id === t.id ? 'selected' : ''}`}
                  onClick={() => onSelect(t.id)}
                  onMouseEnter={() => {
                    preloadImageCached(versionTemplateAssetSrc(t.overlaySrc || t.src, t)).catch(() => {});
                  }}
                  onFocus={() => {
                    preloadImageCached(versionTemplateAssetSrc(t.overlaySrc || t.src, t)).catch(() => {});
                  }}
                >                    
                  <div className="tmpl-name-center">{t.name}</div>
                  <div className="tmpl-img-wrap">
                    {t.previewSrc ? (
                      <img
                        src={versionTemplateAssetSrc(t.previewSrc, t)}
                        alt={t.name}
                        loading="lazy"
                        decoding="async"
                      />
                    ) : (
                      <div className="tmpl-preview-empty">{t.name.slice(0, 1)}</div>
                    )}

                    <div className="tmpl-overlay" />
                    <div className="tmpl-badge">✓ Selected</div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="page-footer">
        <button className="btn-ghost" onClick={onBack}>← Back</button>
        <button
          className="btn-primary"
          id="btn-sel-next"
          disabled={!selectedTemplateForLayout}
          onClick={onNext}
        >
          Continue →
        </button>
      </div>
    </div>
  );
}
