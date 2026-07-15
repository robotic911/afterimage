import { useEffect, useMemo } from 'react';
import './SelectionScreen.css';
import PageHeader from '../PageHeader';
import LayoutPreview from '../LayoutPreview';
import {
  dedupeVisibleCustomerTemplates,
  isTemplateVisibleToCustomer,
} from '../../lib/templateVisibility';
import { versionTemplateAssetSrc } from '../../lib/templateAssetUrl';
import { preloadImageCached } from '../../lib/imageCache';
import { resolveTemplateRenderAssets } from '../../lib/templateRenderAssets';

export default function SelectionScreen({
  active,
  layout,
  shots = [],
  templates = [],
  settings = { mode: 'daily', activeEventId: null },
  selectedFilterCss = '',
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
  const templateAssets = useMemo(
    () => resolveTemplateRenderAssets(selectedTemplateForLayout),
    [selectedTemplateForLayout],
  );
  const selectedPreviewBackgroundSrc = templateAssets.backgroundSrc
    ? versionTemplateAssetSrc(templateAssets.backgroundSrc, selectedTemplateForLayout)
    : null;
  const selectedOverlaySrc = templateAssets.overlaySrc
    ? versionTemplateAssetSrc(templateAssets.overlaySrc, selectedTemplateForLayout)
    : null;
  useEffect(() => {
    if (!import.meta.env.DEV || !selectedTemplateForLayout) return;
    console.log('[background] selected template fields', {
      id: selectedTemplateForLayout.id,
      name: selectedTemplateForLayout.name,
      previewSrc: selectedTemplateForLayout.previewSrc || null,
      backgroundSrc: selectedTemplateForLayout.backgroundSrc || null,
      overlaySrc: selectedTemplateForLayout.overlaySrc || null,
      cardUses: selectedTemplateForLayout.previewSrc || null,
      mainPreviewUses: selectedTemplateForLayout.overlaySrc || null,
    });
  }, [selectedTemplateForLayout]);

  useEffect(() => {
    if (!active || !selectedTemplateForLayout) return;
    console.log('[SELECTION TEMPLATE ASSETS]', {
      selectedTmpl,
      templateId: selectedTemplateForLayout?.id || null,
      templateName: selectedTemplateForLayout?.name || null,
      assets: templateAssets,
    });
    console.log('[SELECTION PREVIEW RENDER]', {
      templateId: selectedTemplateForLayout?.id || null,
      templateName: selectedTemplateForLayout?.name || null,
      backgroundSrc: templateAssets.backgroundSrc,
      overlaySrc: templateAssets.overlaySrc,
      displaySrc: templateAssets.displaySrc,
      shotCount: shots.length,
    });
    console.log('[BACKGROUND PREVIEW] render', {
      selectedBackgroundId: selectedTemplateForLayout?.id || null,
      selectedBackgroundName: selectedTemplateForLayout?.name || null,
      previewBackgroundProp: selectedPreviewBackgroundSrc,
      overlaySrc: selectedOverlaySrc,
      displaySrc: templateAssets.displaySrc,
      templateAssets,
      layoutId: layout?.id || null,
      shotsLength: shots?.length || 0,
    });
    if (selectedOverlaySrc) {
      preloadImageCached(selectedOverlaySrc).catch(() => {});
    }
  }, [active, layout?.id, shots?.length, selectedOverlaySrc, selectedPreviewBackgroundSrc, selectedTemplateForLayout, selectedTmpl, templateAssets]);

  return (
    <div className={`screen ${active ? 'active' : ''}`} id="s-selection" data-screen-label="06 Background">
      <PageHeader
        step="Step 6 of 7"
        title="Choose Your Background"
        subtitle="Tap a design to preview it with your photos."
        pills={['done', 'done', 'done', 'done', 'done', 'active', '']}
      />

      <div className="sel-body">
        <div className="sel-preview-panel">
          <div className="sel-card-header" />

          <LayoutPreview
            layout={layout}
            shots={shots}
            background={selectedTemplateForLayout}
            backgroundSrc={selectedPreviewBackgroundSrc}
            frameSrc={null}
            frameAlt=""
            templateSrc={selectedOverlaySrc}
            templateAlt={selectedTemplateForLayout?.name}
            className="sel-preview-wrap"
            cellClassName="sel-preview-cell"
            frameClassName="sel-preview-frame-image"
            overlayClassName="sel-preview-template"
            photoFilter={selectedFilterCss}
          />
        </div>

        <div className="sel-options-panel">
          <div className="sel-options-box">
            <section className="sel-backgrounds-section">
              <div className="sel-card-header">
                <div>
                  <div className="sel-card-kicker">Backgrounds</div>
                  <div className="sel-card-title">Choose a Background</div>
                  <div className="sel-section-helper">
                    Tap one design to preview it
                  </div>
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
                {visible.map(t => {
                  const isSelected = selectedTemplateForLayout?.id === t.id;

                  return (
                    <button
                      key={t.id}
                      id={`tmpl-${t.id}`}
                      type="button"
                      className={`tmpl-card ${isSelected ? 'selected' : ''}`}
                      onClick={() => {
                        if (import.meta.env.DEV) {
                          console.log('[BACKGROUND SELECT] clicked', {
                            id: t?.id,
                            name: t?.name,
                            value: t,
                          });
                        }
                        onSelect(t.id);
                      }}
                      onMouseEnter={() => {
                        preloadImageCached(versionTemplateAssetSrc(t.overlaySrc || t.src, t)).catch(() => {});
                      }}
                      onFocus={() => {
                        preloadImageCached(versionTemplateAssetSrc(t.overlaySrc || t.src, t)).catch(() => {});
                      }}
                      aria-pressed={isSelected}
                    >
                      <span className="tmpl-img-wrap">
                        {t.previewSrc ? (
                          <img
                            src={versionTemplateAssetSrc(t.previewSrc, t)}
                            alt=""
                            aria-hidden="true"
                            loading="lazy"
                            decoding="async"
                          />
                        ) : (
                          <span className="tmpl-preview-empty">{t.name.slice(0, 1)}</span>
                        )}
                      </span>
                      <span className="tmpl-card-name">{t.name}</span>
                      <span className="tmpl-badge" aria-hidden="true">✓</span>
                    </button>
                  );
                })}
              </div>
            </section>
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
          Review & Print →
        </button>
      </div>
    </div>
  );
}
