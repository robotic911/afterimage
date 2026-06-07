import './ArrangeScreen.css';
import PageHeader from '../PageHeader';
import LayoutPreview from '../LayoutPreview';

export default function ArrangeScreen({
  active,
  layout,
  shots = [],
  arrangedShotIndexes = [],
  retries = 0,
  onChangeArrangement,
  onRetry,
  onNext,
}) {
  const cameraWidth = layout?.camera?.width;
  const cameraHeight = layout?.camera?.height;
  const shotRatio = `${cameraWidth} / ${cameraHeight}`;
  const isPortraitShot = cameraHeight > cameraWidth;
  const requiredCount = layout?.shots || 0;
  const arrangedShots = arrangedShotIndexes.map(index => shots[index]);
  const canContinue = arrangedShotIndexes.length === requiredCount;
  const canRetake = retries > 0;
  const slots = layout?.slots || [];

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

  return (
    <div className={`screen ${active ? 'active' : ''}`} id="s-arrange" data-screen-label="05 Arrange">
      <PageHeader
        step="Step 4 of 6"
        title="Arrange Pictures"
        subtitle="Select your photos in the order you want them to appear. Tap a selected photo again to remove it."
        pills={['done', 'done', 'done', 'active', '', '']}
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
          <div className="arrange-sidebar-title">Select order</div>
          <div className="arrange-sidebar-copy">
            Choose {requiredCount} photo{requiredCount === 1 ? '' : 's'} to fill the layout.
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

              return (
                <div className="arrange-thumb-cell" key={index}>
                  <button
                    type="button"
                    className={`arrange-thumb ${isSelected ? 'selected' : ''}`}
                    onClick={() => toggleShot(index)}
                  >
                    <img
                      src={shot}
                      alt={`Captured shot ${index + 1}`}
                      decoding="async"
                    />
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
            Reset Arrangement
          </button>
        </div>
      </div>

      <div className="page-footer arrange-footer">
        <button
          type="button"
          className="btn-ghost arrange-retake-btn"
          onClick={onRetry}
          disabled={!canRetake}
          title={canRetake ? 'Retake the full photo set. This can only be used once.' : 'The one allowed retake has already been used.'}
        >
          {canRetake ? 'Retake All Photos (One Time Only)' : 'Retake Already Used'}
        </button>
        <button
          className="btn-primary arrange-continue-btn"
          disabled={!canContinue}
          onClick={onNext}
        >
          Continue →
        </button>
      </div>
    </div>
  );
}
