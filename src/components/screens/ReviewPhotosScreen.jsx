import { useEffect, useState } from 'react';
import './ReviewPhotosScreen.css';
import PageHeader from '../PageHeader';
import { getShotImageSource, inspectDataUrl } from '../../lib/shotImageSource';

const IS_DEV = import.meta.env.DEV;

function formatPhotoList(indexes) {
  const labels = indexes.map((index) => `Photo ${index + 1}`);
  if (labels.length <= 1) return labels[0] || '';
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

export default function ReviewPhotosScreen({
  active,
  layout,
  shots = [],
  selectedFilterCss = '',
  retakeCompletedKey = 0,
  hasUsedRetakeChance = false,
  onRetakeShots,
  onContinue,
}) {
  const [reviewMode, setReviewMode] = useState('review');
  const [selectedRetakeIndexes, setSelectedRetakeIndexes] = useState([]);
  const [confirmRetakeOpen, setConfirmRetakeOpen] = useState(false);
  const [isStartingRetake, setIsStartingRetake] = useState(false);
  const cameraWidth = layout?.camera?.width;
  const cameraHeight = layout?.camera?.height;
  const shotRatio = cameraWidth && cameraHeight ? `${cameraWidth} / ${cameraHeight}` : '1 / 1';
  const selectedCount = selectedRetakeIndexes.length;
  const selectedSummary = formatPhotoList(selectedRetakeIndexes);
  const isRetakeMode = reviewMode === 'retake-select';
  const reviewStatusText = isRetakeMode
    ? selectedCount === 0
      ? 'Select at least one photo to retake.'
      : `${selectedCount} photo${selectedCount === 1 ? '' : 's'} selected. Only selected photos will be replaced.`
    : hasUsedRetakeChance
      ? 'Retake already used.'
      : retakeCompletedKey > 0
        ? 'Selected photos updated.'
        : 'Photos are arranged on the next screen.';

  useEffect(() => {
    if (!active) {
      queueMicrotask(() => {
        setConfirmRetakeOpen(false);
        setIsStartingRetake(false);
      });
      return;
    }
    queueMicrotask(() => {
      setReviewMode('review');
      setSelectedRetakeIndexes([]);
    });
  }, [active]);

  useEffect(() => {
    if (!active) return;
    const validIndexes = selectedRetakeIndexes.filter((index) => shots[index]);
    if (validIndexes.length !== selectedRetakeIndexes.length) {
      queueMicrotask(() => setSelectedRetakeIndexes(validIndexes));
    }
  }, [active, selectedRetakeIndexes, shots]);

  useEffect(() => {
    if (!IS_DEV || !active) return;
    console.log('[review-flow] mode changed', { reviewMode });
  }, [active, reviewMode]);

  useEffect(() => {
    if (!IS_DEV || !active) return;
    console.log('[review-flow] entered review screen', {
      photoCount: shots.length,
    });
    console.log('[DATA URL AUDIT Review first]', inspectDataUrl(getShotImageSource(shots?.[0])));
  }, [active, shots, retakeCompletedKey]);

  const enterRetakeMode = () => {
    if (hasUsedRetakeChance) {
      console.warn('[retake] blocked because retake chance already used');
      return;
    }
    setReviewMode('retake-select');
    setSelectedRetakeIndexes([]);
  };

  const cancelRetakeMode = () => {
    setReviewMode('review');
    setSelectedRetakeIndexes([]);
    setConfirmRetakeOpen(false);
    setIsStartingRetake(false);
  };

  const toggleRetakeSelection = (index) => {
    if (!isRetakeMode || isStartingRetake) return;
    setSelectedRetakeIndexes((current) => {
      const next = current.includes(index)
        ? current.filter((item) => item !== index)
        : [...current, index].sort((a, b) => a - b);
      if (IS_DEV) console.log('[retake-flow] selected indexes', { selectedRetakeIndexes: next });
      return next;
    });
  };

  const beginRetake = () => {
    if (selectedRetakeIndexes.length === 0 || isStartingRetake) return;
    if (hasUsedRetakeChance) {
      console.warn('[retake] blocked because retake chance already used');
      return;
    }
    const nextQueue = [...selectedRetakeIndexes].sort((a, b) => a - b);
    if (IS_DEV) console.log('[retake-flow] sequence started', { retakeQueue: nextQueue });
    for (const indexToReplace of nextQueue) {
      if (IS_DEV) console.log('[retake-flow] replacing photo', { activeRetakeIndex: indexToReplace });
    }
    setIsStartingRetake(true);
    setConfirmRetakeOpen(false);
    onRetakeShots?.(nextQueue);
  };

  if (!cameraWidth || !cameraHeight) {
    return null;
  }

  return (
    <div
      className={`screen ${active ? 'active' : ''} ${isRetakeMode ? 'review-screen--retake' : ''}`}
      id="s-review"
      data-screen-label="05 Review Photos"
    >
      <PageHeader
        step="Step 4 of 7"
        title={isRetakeMode ? 'Select Photos to Retake' : 'Review Your Photos'}
        subtitle={isRetakeMode ? 'Tap the photos you want to retake.' : 'Check your photos before continuing.'}
        pills={['done', 'done', 'done', 'active', '', '', '']}
      />

      <div className="review-photos-body">
        <div className="review-photos-panel">
          <div
            className="review-photos-grid"
            style={{
              '--shot-ratio': shotRatio,
              '--shot-count': shots.length,
            }}
          >
            {shots.map((shot, index) => {
              const isSelected = selectedRetakeIndexes.includes(index);
              const imageSrc = getShotImageSource(shot);
              return (
                <button
                  key={index}
                  type="button"
                  className={`review-photo-card ${isRetakeMode ? 'is-selectable' : ''} ${isSelected ? 'is-selected' : ''}`}
                  onClick={() => toggleRetakeSelection(index)}
                  disabled={!isRetakeMode || isStartingRetake}
                  aria-pressed={isRetakeMode ? isSelected : undefined}
                >
                  <span className="review-photo-label">Photo {index + 1}</span>
                  <span className="review-photo-image-wrap">
                    {imageSrc ? (
                      <img
                        src={imageSrc}
                        alt={`Captured photo ${index + 1}`}
                        decoding="async"
                        style={selectedFilterCss ? { filter: selectedFilterCss } : undefined}
                      />
                    ) : (
                      <span className="review-photo-missing">Missing photo</span>
                    )}
                  </span>
                  {isRetakeMode && (
                    <span className="review-photo-selected-copy">
                      {isSelected ? 'Selected' : 'Tap to select'}
                    </span>
                  )}
                  {isSelected && <span className="review-photo-check" aria-hidden="true">✓</span>}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div className="page-footer review-photos-footer">
        <div
          className={`review-footer-status ${selectedCount > 0 ? 'has-selection' : ''}`}
          role="status"
        >
          {reviewStatusText}
        </div>
        {isRetakeMode ? (
          <>
            <button
              type="button"
              className="btn-ghost review-secondary-btn"
              onClick={cancelRetakeMode}
              disabled={isStartingRetake}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary review-primary-btn"
              onClick={() => setConfirmRetakeOpen(true)}
              disabled={selectedCount === 0 || isStartingRetake}
            >
              {selectedCount === 0
                ? 'Retake Selected'
                : `Retake ${selectedCount} Photo${selectedCount === 1 ? '' : 's'}`}
            </button>
          </>
        ) : (
          <>
            {!hasUsedRetakeChance ? (
              <button
                type="button"
                className="btn-ghost review-secondary-btn"
                onClick={enterRetakeMode}
              >
                Retake Photos
              </button>
            ) : null}
            <button
              type="button"
              className="btn-primary review-primary-btn"
              onClick={onContinue}
            >
              Looks Good
            </button>
          </>
        )}
      </div>

      {confirmRetakeOpen && (
        <div className="review-retake-modal-backdrop" role="presentation">
          <div className="review-retake-modal" role="dialog" aria-modal="true" aria-labelledby="review-retake-title">
            <div className="review-retake-modal-title" id="review-retake-title">
              {selectedCount === 1 ? `Retake Photo ${selectedRetakeIndexes[0] + 1}?` : 'Retake selected photos?'}
            </div>
            <div className="review-retake-modal-copy">
              {selectedCount === 1
                ? `Only Photo ${selectedRetakeIndexes[0] + 1} will be replaced.`
                : `You selected ${selectedSummary}. Only these photos will be replaced.`}
            </div>
            <div className="review-retake-modal-actions">
              <button
                type="button"
                className="btn-ghost"
                onClick={() => setConfirmRetakeOpen(false)}
                disabled={isStartingRetake}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={beginRetake}
                disabled={isStartingRetake}
              >
                {selectedCount === 1
                  ? `Retake Photo ${selectedRetakeIndexes[0] + 1}`
                  : `Retake ${selectedCount} Photos`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
