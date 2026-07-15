import { useEffect } from 'react';
import './ArrangeScreen.css';
import PageHeader from '../PageHeader';
import LayoutPreview from '../LayoutPreview';
import { getShotImageSource, inspectDataUrl } from '../../lib/shotImageSource';

const IS_DEV = import.meta.env.DEV;

export default function ArrangeScreen({
  active,
  layout,
  shots = [],
  arrangedShotIndexes = [],
  selectedFilterCss = '',
  hasUsedRetakeChance = false,
  onChangeArrangement,
  onNext,
}) {
  const cameraWidth = layout?.camera?.width;
  const cameraHeight = layout?.camera?.height;
  const shotRatio = `${cameraWidth} / ${cameraHeight}`;
  const isPortraitShot = cameraHeight > cameraWidth;
  const requiredCount = layout?.shots || 0;
  const arrangedShots = arrangedShotIndexes.map(index => shots[index]);
  const canContinue = arrangedShotIndexes.length === requiredCount;
  const slots = layout?.slots || [];

  useEffect(() => {
    if (!active || arrangedShotIndexes.length === 0) return;
    const validIndexes = arrangedShotIndexes.filter((index) => shots[index]);
    if (validIndexes.length !== arrangedShotIndexes.length) {
      queueMicrotask(() => onChangeArrangement(validIndexes));
    }
  }, [active, arrangedShotIndexes, onChangeArrangement, shots]);

  useEffect(() => {
    if (!IS_DEV || !active) return;
    console.log('[arrange-flow] entering arrange with photos', {
      photoCount: shots.length,
      hasUsedRetakeChance,
    });
    console.log('[DATA URL AUDIT Arrange first]', inspectDataUrl(getShotImageSource(shots?.[0])));
    console.log('[DATA URL AUDIT Arrange first arranged]', inspectDataUrl(getShotImageSource(arrangedShots?.[0])));
  }, [active, arrangedShots, hasUsedRetakeChance, shots]);

  if (!cameraWidth || !cameraHeight) {
    return null;
  }

  const toggleShot = (index) => {
    if (arrangedShotIndexes.includes(index)) {
      onChangeArrangement(arrangedShotIndexes.filter(i => i !== index));
      return;
    }

    if (arrangedShotIndexes.length >= requiredCount) return;
    onChangeArrangement([...arrangedShotIndexes, index]);
  };

  const auditArrangePhoto = (event, index) => {
    if (!IS_DEV) return;
    const image = event.currentTarget;
    const displayRect = image.getBoundingClientRect();
    console.log('[arrange-photo] source audit', {
      shotIndex: index,
      sourceUsed: 'full captured data URL',
      imageWidth: image.naturalWidth,
      imageHeight: image.naturalHeight,
      aspectRatio: image.naturalWidth / image.naturalHeight,
      displayWidth: displayRect.width,
      displayHeight: displayRect.height,
    });
  };

  return (
    <div className={`screen ${active ? 'active' : ''}`} id="s-arrange" data-screen-label="05 Arrange">
      <PageHeader
        step="Step 5 of 7"
        title="Arrange Your Photos"
        subtitle="Tap photos in the order you want them to appear."
        pills={['done', 'done', 'done', 'done', 'active', '', '']}
      />

      <div className="arrange-body">
        <div className="arrange-preview-panel">
          <div className="arrange-frame-box">
            <LayoutPreview
              layout={layout}
              shots={arrangedShots}
              frameSrc={layout?.arrangeFrameSrc || layout?.frameSrc}
              frameAlt={layout?.name ? `${layout.name} frame` : 'Layout frame'}
              className="arrange-frame-wrap"
              cellClassName="arrange-frame-cell"
              frameClassName="arrange-frame-image"
              photoFilter={selectedFilterCss}
              renderPlaceholder={(slot, slotIndex) => {
                const firstSlotIndex = slots.findIndex(item => item.shotIndex === slot.shotIndex);
                if (firstSlotIndex !== slotIndex) {
                  return <div className="arrange-slot-placeholder" aria-hidden="true" />;
                }

                return (
                  <div className="arrange-slot-placeholder">
                    Slot {slot.shotIndex + 1}
                  </div>
                );
              }}
            />
          </div>
        </div>

        <div className="arrange-sidebar">
          <div className="arrange-sidebar-title">Tap Photos in Order</div>
          <div className="arrange-sidebar-copy">
            {arrangedShotIndexes.length} of {requiredCount} selected
          </div>

          <div
            className={`arrange-thumb-grid ${isPortraitShot ? 'arrange-thumb-grid--portrait' : 'arrange-thumb-grid--landscape'}`}
            style={{
              '--shot-ratio': shotRatio,
              '--shot-count': shots.length,
            }}
          >
            {shots.map((shot, index) => {
              const orderIndex = arrangedShotIndexes.indexOf(index);
              const isSelected = orderIndex !== -1;
              const orderLabel = isSelected ? orderIndex + 1 : null;
              const imageSrc = getShotImageSource(shot);

              return (
                <div className="arrange-thumb-cell" key={index}>
                  <div className="arrange-photo-label">Photo {index + 1}</div>
                  <button
                    type="button"
                    className={`arrange-thumb ${isSelected ? 'selected' : ''}`}
                    onClick={() => toggleShot(index)}
                  >
                    {imageSrc ? (
                      <img
                        src={imageSrc}
                        alt={`Captured shot ${index + 1}`}
                        decoding="async"
                        style={selectedFilterCss ? { filter: selectedFilterCss } : undefined}
                        onLoad={(event) => auditArrangePhoto(event, index)}
                      />
                    ) : (
                      <span className="arrange-photo-missing">Missing photo</span>
                    )}
                    {orderLabel && <span className="arrange-thumb-order">{orderLabel}</span>}
                  </button>
                </div>
              );
            })}
          </div>

          <button
            type="button"
            className="btn-ghost arrange-reset-btn"
            onClick={() => onChangeArrangement([])}
            disabled={arrangedShotIndexes.length === 0}
          >
            Start Over
          </button>
        </div>
      </div>

      <div className="page-footer arrange-footer">
        <button
          className="btn-primary arrange-continue-btn"
          disabled={!canContinue}
          onClick={onNext}
        >
          Choose Background →
        </button>
      </div>
    </div>
  );
}
