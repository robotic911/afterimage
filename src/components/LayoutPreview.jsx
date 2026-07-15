import { memo, useEffect, useState } from 'react';
import './LayoutPreview.css';
import { getShotImageSource, inspectDataUrl } from '../lib/shotImageSource';
import { getTemplateOverlaySrc, getTemplatePreviewBackgroundSrc } from '../lib/templateAssetUrl';
import { resolveTemplateRenderAssets } from '../lib/templateRenderAssets';

function LayoutPreview({
  layout,
  shots = [],
  background = null,
  backgroundSrc = null,
  frameSrc,
  frameAlt = 'Layout frame',
  templateSrc,
  templateAlt = 'Selected background',
  className = '',
  cellClassName = '',
  frameClassName = '',
  overlayClassName = '',
  photoFilter = '',
  renderPlaceholder,
}) {
  const [failedPhotoSlots, setFailedPhotoSlots] = useState({});
  const canvasW = layout?.canvas?.w ?? 1200;
  const canvasH = layout?.canvas?.h ?? 1800;
  const slots = layout?.slots || [];
  const layoutClass = layout?.id ? `layout-preview--${layout.id}` : '';
  const templateAssets = resolveTemplateRenderAssets(background);
  const resolvedBackgroundSrc = backgroundSrc || getTemplatePreviewBackgroundSrc(background) || templateAssets.backgroundSrc;
  const resolvedOverlaySrc = templateSrc || getTemplateOverlaySrc(background) || templateAssets.overlaySrc;

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    console.log('[LAYOUT PREVIEW ASSETS]', {
      templateName: background?.name || null,
      backgroundSrc: resolvedBackgroundSrc,
      templateSrc: resolvedOverlaySrc,
      hasBackgroundSrc: Boolean(resolvedBackgroundSrc),
      hasTemplateSrc: Boolean(resolvedOverlaySrc),
    });
    console.log('[LAYOUT PREVIEW BACKGROUND] received', {
      background,
      backgroundId: background?.id || background,
      backgroundName: background?.name,
      layoutId: layout?.id,
      resolvedBackgroundSrc: resolvedBackgroundSrc ? resolvedBackgroundSrc.slice(0, 100) : null,
      resolvedOverlaySrc: resolvedOverlaySrc ? resolvedOverlaySrc.slice(0, 100) : null,
    });
  }, [background, layout?.id, resolvedBackgroundSrc, resolvedOverlaySrc]);

  return (
    <div
      className={`layout-preview-frame ${layoutClass} ${className}`.trim()}
      style={{
        aspectRatio: `${canvasW} / ${canvasH}`,
        '--layout-aspect': canvasW / canvasH,
      }}
    >
      {resolvedBackgroundSrc && (
        <img
          className={`layout-preview-background ${frameClassName}`.trim()}
          src={resolvedBackgroundSrc}
          alt={background?.name || 'Selected background'}
          loading="lazy"
          decoding="async"
          onLoad={(event) => {
            console.log('[LAYOUT BG IMG LOAD OK]', {
              backgroundName: background?.name || null,
              src: resolvedBackgroundSrc,
              naturalWidth: event.currentTarget.naturalWidth,
              naturalHeight: event.currentTarget.naturalHeight,
            });
          }}
          onError={(event) => {
            console.error('[LAYOUT BG IMG LOAD FAILED]', {
              backgroundName: background?.name || null,
              src: resolvedBackgroundSrc,
              currentSrc: event.currentTarget?.currentSrc,
            });
          }}
        />
      )}
      <div className="layout-preview-grid">
        {slots.map((slot, index) => {
          const shotIndex = Number.isInteger(slot?.shotIndex) ? slot.shotIndex : index;
          const shot = shots?.[shotIndex];
          const imageSrc = getShotImageSource(shot);
          if (index === 0) {
            console.log('[DATA URL AUDIT LayoutPreview first]', inspectDataUrl(imageSrc));
          }
          const failedKey = `${index}-${shotIndex}`;
          const failed = failedPhotoSlots[failedKey] === true;
          return (
            <div
              key={index}
              className={`layout-preview-cell ${cellClassName}`.trim()}
              style={{
                left: `${(slot.x / canvasW) * 100}%`,
                top: `${(slot.y / canvasH) * 100}%`,
                width: `${(slot.w / canvasW) * 100}%`,
                height: `${(slot.h / canvasH) * 100}%`,
              }}
            >
              {imageSrc && !failed ? (
                <img
                  src={imageSrc}
                  alt={`Shot ${shotIndex + 1}`}
                  decoding="async"
                  data-photo-index={shotIndex}
                  style={photoFilter ? { filter: photoFilter } : undefined}
                  onLoad={(event) => {
                    console.log('[PHOTO IMG LOAD OK]', {
                      index,
                      shotIndex,
                      srcPrefix: imageSrc?.slice(0, 80),
                      naturalWidth: event.currentTarget.naturalWidth,
                      naturalHeight: event.currentTarget.naturalHeight,
                    });
                    setFailedPhotoSlots((current) => (
                      current[failedKey]
                        ? { ...current, [failedKey]: false }
                        : current
                    ));
                  }}
                  onError={(event) => {
                    console.error('[PHOTO IMG LOAD FAILED]', {
                      index,
                      shotIndex,
                      srcPrefix: imageSrc?.slice(0, 120),
                      srcLength: imageSrc?.length,
                      currentSrc: event.currentTarget?.currentSrc,
                    });
                    setFailedPhotoSlots((current) => ({ ...current, [failedKey]: true }));
                  }}
                />
              ) : (
                renderPlaceholder?.(slot, index) || (
                  shot ? <div className="layout-preview-missing-photo">{failed ? 'Image failed to load' : 'Missing photo'}</div> : null
                )
              )}
            </div>
          );
        })}
      </div>

      {frameSrc && (
        <img
          className={`layout-preview-frame-image ${frameClassName}`.trim()}
          src={frameSrc}
          alt={frameAlt}
          loading="lazy"
          decoding="async"
        />
      )}

      {resolvedOverlaySrc && (
        <img
          className={`layout-preview-overlay ${overlayClassName}`.trim()}
          src={resolvedOverlaySrc}
          alt={templateAlt}
          loading="lazy"
          decoding="async"
          onLoad={(event) => {
            console.log('[LAYOUT OVERLAY IMG LOAD OK]', {
              backgroundName: background?.name || null,
              src: resolvedOverlaySrc,
              naturalWidth: event.currentTarget.naturalWidth,
              naturalHeight: event.currentTarget.naturalHeight,
            });
          }}
          onError={(event) => {
            console.error('[LAYOUT OVERLAY IMG LOAD FAILED]', {
              backgroundName: background?.name || null,
              src: resolvedOverlaySrc,
              currentSrc: event.currentTarget?.currentSrc,
            });
          }}
        />
      )}
    </div>
  );
}

export default memo(LayoutPreview);
