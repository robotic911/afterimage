import { memo } from 'react';
import './LayoutPreview.css';

function LayoutPreview({
  layout,
  shots = [],
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
  const canvasW = layout?.canvas?.w ?? 1200;
  const canvasH = layout?.canvas?.h ?? 1800;
  const slots = layout?.slots || [];
  const layoutClass = layout?.id ? `layout-preview--${layout.id}` : '';

  return (
    <div
      className={`layout-preview-frame ${layoutClass} ${className}`.trim()}
      style={{
        aspectRatio: `${canvasW} / ${canvasH}`,
        '--layout-aspect': canvasW / canvasH,
      }}
    >
      <div className="layout-preview-grid">
        {slots.map((slot, index) => {
          const shot = shots?.[slot.shotIndex];
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
              {shot ? (
                <img
                  src={shot}
                  alt={`Shot ${slot.shotIndex + 1}`}
                  decoding="async"
                  style={photoFilter ? { filter: photoFilter } : undefined}
                />
              ) : (
                renderPlaceholder?.(slot, index) || null
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

      {templateSrc && (
        <img
          className={`layout-preview-overlay ${overlayClassName}`.trim()}
          src={templateSrc}
          alt={templateAlt}
          loading="lazy"
          decoding="async"
        />
      )}
    </div>
  );
}

export default memo(LayoutPreview);
