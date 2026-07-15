export const HEIGHT_LOCKED_FIT_MODE = 'height-locked';

export function getCameraDrawRect({
  sourceWidth,
  sourceHeight,
  targetWidth,
  targetHeight,
  framing = {},
}) {
  const sourceAspect = sourceWidth / sourceHeight;
  const targetAspect = targetWidth / targetHeight;
  const fitMode = framing.fitMode || HEIGHT_LOCKED_FIT_MODE;

  // Height-locked mode always preserves full source height and aspect ratio.
  // Width may overflow and be clipped horizontally, which avoids vertical
  // cropping and prevents independent width/height scaling.
  const drawHeight = targetHeight;
  const drawWidth = drawHeight * sourceAspect;
  const drawX = (targetWidth - drawWidth) / 2;
  const drawY = 0;

  return {
    fitMode,
    sourceX: 0,
    sourceY: 0,
    sourceWidth,
    sourceHeight,
    sourceAspect,
    targetWidth,
    targetHeight,
    targetAspect,
    drawX,
    drawY,
    drawWidth,
    drawHeight,
    fullSourceHeightVisible: true,
  };
}
