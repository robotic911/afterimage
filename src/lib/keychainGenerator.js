const IS_DEV = import.meta.env.DEV;

export const KEYCHAIN_4X6_LAYOUT_IDS = new Set([
  'classic-strip-4',
  'classic-strip-3',
  'portrait-grid',
  'studio-quad',
]);

const KEYCHAIN_CANVAS = Object.freeze({
  width: 1200,
  height: 1800,
});

const KEYCHAIN_SAFE_AREA = Object.freeze({
  top: 33,
  right: 33,
  bottom: 76,
  left: 32,
});

const KEYCHAIN_CONTENT_TOP_MARGIN = KEYCHAIN_SAFE_AREA.top;
const DEFAULT_KEYCHAIN_COPIES = 3;
const VALID_KEYCHAIN_COPIES = new Set([2, 3]);

const LATEST_REFERENCE_LAYOUT = Object.freeze({
  sheetBackgroundColor: '#f1f1f1',
  horizontalGutter: 0,
  verticalGutter: 0,
});

const DRAW_KEYCHAIN_SAFE_AREA_DEBUG = false;

function canvasToBlob(canvas, mimeType = 'image/png') {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error('Could not encode keychain canvas.'));
      }
    }, mimeType);
  });
}

function keychainTimestamp(date = new Date()) {
  const pad = number => String(number).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '-',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('');
}

function normalizeKeychainCopyCount(value = DEFAULT_KEYCHAIN_COPIES) {
  const count = Number(value);
  return VALID_KEYCHAIN_COPIES.has(count) ? count : DEFAULT_KEYCHAIN_COPIES;
}

function makeKeychainFilename(sessionId = '', keychainCopies = DEFAULT_KEYCHAIN_COPIES) {
  const cleanSessionId = String(sessionId || 'session')
    .replace(/[^A-Za-z0-9_-]+/g, '')
    .slice(0, 48) || 'session';
  const copyCount = normalizeKeychainCopyCount(keychainCopies);

  return `Afterimage-keychain-4x6-${copyCount}copies-${keychainTimestamp()}-${cleanSessionId}.png`;
}

function makeStep3KeychainFilename() {
  return `Afterimage-STEP3-keychain-4x6-${keychainTimestamp()}.png`;
}

function createCanvas(width, height, backgroundColor = '#ffffff') {
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width);
  canvas.height = Math.round(height);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = backgroundColor;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  return { canvas, ctx };
}

function loadCanvasImage(src, label = 'keychain image') {
  return new Promise((resolve, reject) => {
    if (!src || typeof src !== 'string') {
      reject(new Error(`Invalid ${label} source.`));
      return;
    }

    const image = new Image();
    if (/^https?:\/\//i.test(src)) {
      image.crossOrigin = 'anonymous';
    }
    image.onload = () => resolve(image);
    image.onerror = () => {
      reject(new Error(`Failed to load ${label}: ${src.slice(0, 120)}`));
    };
    image.src = src;
  });
}

function resolveFinalArtworkSource({
  finalArtworkDataUrl = '',
  sourceArtworkDataUrl = '',
  sourceStripDataUrl = '',
} = {}) {
  return finalArtworkDataUrl || sourceArtworkDataUrl || sourceStripDataUrl || '';
}

function getSourceType(source = '') {
  if (source.startsWith('data:image/')) return 'data-url';
  if (source.startsWith('blob:')) return 'blob-url';
  if (/^https?:\/\//i.test(source)) return 'remote-url';
  if (source) return 'string';
  return 'missing';
}

async function loadFinalArtworkImage(source) {
  if (!source || typeof source !== 'string') {
    throw new Error('No final rendered session artwork available for keychain generation.');
  }

  console.log('[KEYCHAIN FINAL ARTWORK SOURCE]', {
    hasSource: true,
    prefix: source.slice(0, 120),
    isDataUrl: source.startsWith('data:image/'),
    isBlobUrl: source.startsWith('blob:'),
    length: source.length,
  });

  const image = await loadCanvasImage(source, 'final rendered session artwork');
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;

  if (!width || !height) {
    throw new Error('Final rendered session artwork decoded without dimensions.');
  }

  console.log('[KEYCHAIN FINAL ARTWORK LOAD OK]', {
    width,
    height,
    aspect: Number((width / height).toFixed(6)),
  });

  return image;
}

const KEYCHAIN_PER_COPY_INSET = 0;

function getKeychainSourceCropRect(image) {
  const sourceWidth = image.naturalWidth || image.width;
  const sourceHeight = image.naturalHeight || image.height;
  const left = Math.round((KEYCHAIN_SAFE_AREA.left / KEYCHAIN_CANVAS.width) * sourceWidth);
  const top = Math.round((KEYCHAIN_SAFE_AREA.top / KEYCHAIN_CANVAS.height) * sourceHeight);
  const right = Math.round((KEYCHAIN_SAFE_AREA.right / KEYCHAIN_CANVAS.width) * sourceWidth);
  const bottom = Math.round((KEYCHAIN_SAFE_AREA.bottom / KEYCHAIN_CANVAS.height) * sourceHeight);
  const width = Math.max(1, sourceWidth - left - right);
  const height = Math.max(1, sourceHeight - top - bottom);

  return {
    x: left,
    y: top,
    width,
    height,
    margins: {
      top,
      right,
      bottom,
      left,
    },
  };
}

function drawFinishedArtworkCopy(ctx, image, placement, sourceCrop) {
  const { x, y, width, height, rotationDegrees = 0 } = placement;

  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, width, height);
  ctx.clip();

  if (rotationDegrees === 90) {
    ctx.translate(x + width, y);
    ctx.rotate(Math.PI / 2);
    ctx.drawImage(
      image,
      sourceCrop.x,
      sourceCrop.y,
      sourceCrop.width,
      sourceCrop.height,
      0,
      0,
      height,
      width,
    );
  } else {
    ctx.drawImage(
      image,
      sourceCrop.x,
      sourceCrop.y,
      sourceCrop.width,
      sourceCrop.height,
      x,
      y,
      width,
      height,
    );
  }

  ctx.restore();
}

function getKeychainSafeArea(canvasWidth, canvasHeight) {
  const safeX = KEYCHAIN_SAFE_AREA.left;
  const safeY = KEYCHAIN_SAFE_AREA.top;
  const safeWidth = canvasWidth - KEYCHAIN_SAFE_AREA.left - KEYCHAIN_SAFE_AREA.right;
  const safeHeight = canvasHeight - KEYCHAIN_SAFE_AREA.top - KEYCHAIN_SAFE_AREA.bottom;

  return {
    ...KEYCHAIN_SAFE_AREA,
    safeX,
    safeY,
    safeWidth,
    safeHeight,
    safeRight: safeX + safeWidth,
    safeBottom: safeY + safeHeight,
  };
}

function getKeychainPlacementArea(canvasWidth, canvasHeight) {
  const sheetSafeArea = getKeychainSafeArea(canvasWidth, canvasHeight);
  const safeY = KEYCHAIN_CONTENT_TOP_MARGIN;

  return {
    ...sheetSafeArea,
    contentTopMargin: KEYCHAIN_CONTENT_TOP_MARGIN,
    sheetSafeTop: sheetSafeArea.safeY,
    safeY,
    safeHeight: sheetSafeArea.safeBottom - safeY,
    safeBottom: sheetSafeArea.safeBottom,
  };
}

function checkPlacementBounds(placement, safeArea) {
  const { x, y, width, height } = placement;
  return {
    id: placement.id,
    withinLeft: x >= safeArea.safeX,
    withinTop: y >= safeArea.safeY,
    withinRight: x + width <= safeArea.safeRight,
    withinBottom: y + height <= safeArea.safeBottom,
  };
}

function drawSafeAreaDebug(ctx, safeArea) {
  if (!IS_DEV || !DRAW_KEYCHAIN_SAFE_AREA_DEBUG) return;
  ctx.save();
  ctx.strokeStyle = 'rgba(0, 120, 255, 0.45)';
  ctx.lineWidth = 2;
  ctx.setLineDash([10, 6]);
  ctx.strokeRect(safeArea.safeX, safeArea.safeY, safeArea.safeWidth, safeArea.safeHeight);
  ctx.restore();
}

function serializeRect(rect) {
  if (!rect) return null;
  return {
    x: Number(rect.x.toFixed(2)),
    y: Number(rect.y.toFixed(2)),
    width: Number(rect.width.toFixed(2)),
    height: Number(rect.height.toFixed(2)),
  };
}

function serializePlacementMap(placements = []) {
  return placements.reduce((acc, placement) => {
    acc[placement.id] = serializeRect(placement);
    return acc;
  }, {});
}

function calculateCommonStripSize(safeArea, sourceAspect) {
  const { horizontalGutter, verticalGutter } = LATEST_REFERENCE_LAYOUT;
  const availableWidthPerBottomCopy = (safeArea.safeWidth - horizontalGutter) / 2;
  const availableHeightForSharedScale = safeArea.safeHeight - verticalGutter;
  const maxWidthByTopRotatedWidth = safeArea.safeWidth * sourceAspect;
  const maxWidthByStackHeight = availableHeightForSharedScale / (1 + (1 / sourceAspect));
  const stripWidth = Math.min(
    availableWidthPerBottomCopy,
    maxWidthByTopRotatedWidth,
    maxWidthByStackHeight,
  );
  const stripHeight = stripWidth / sourceAspect;

  return {
    stripWidth,
    stripHeight,
  };
}

function buildEqualScaleRegions(safeArea, stripSize) {
  const { horizontalGutter } = LATEST_REFERENCE_LAYOUT;
  const { stripWidth, stripHeight } = stripSize;
  const bottomY = safeArea.safeBottom - stripHeight;

  return {
    topRegion: {
      id: 'top-region',
      x: safeArea.safeX,
      y: safeArea.safeY,
      width: stripHeight,
      height: stripWidth,
    },
    bottomLeftRegion: {
      id: 'bottom-left-region',
      x: safeArea.safeX,
      y: bottomY,
      width: stripWidth,
      height: stripHeight,
    },
    bottomRightRegion: {
      id: 'bottom-right-region',
      x: safeArea.safeX + stripWidth + horizontalGutter,
      y: bottomY,
      width: stripWidth,
      height: stripHeight,
    },
  };
}

function buildTwoCopyRegions(safeArea, sourceAspect) {
  const { horizontalGutter } = LATEST_REFERENCE_LAYOUT;
  const availableWidth = (safeArea.safeWidth - horizontalGutter) / 2;
  const availableHeight = safeArea.safeHeight;
  const stripWidth = Math.min(availableWidth, availableHeight * sourceAspect);
  const stripHeight = stripWidth / sourceAspect;
  const y = safeArea.safeY + ((safeArea.safeHeight - stripHeight) / 2);

  return {
    stripSize: {
      stripWidth,
      stripHeight,
    },
    regions: {
      leftRegion: {
        id: 'left-region',
        x: safeArea.safeX,
        y,
        width: stripWidth,
        height: stripHeight,
      },
      rightRegion: {
        id: 'right-region',
        x: safeArea.safeX + stripWidth + horizontalGutter,
        y,
        width: stripWidth,
        height: stripHeight,
      },
    },
  };
}

function buildThreeCopyPlacements(placementArea, sourceAspect) {
  const rotatedAspect = 1 / sourceAspect;
  const stripSize = calculateCommonStripSize(placementArea, sourceAspect);
  const regions = buildEqualScaleRegions(placementArea, stripSize);
  const placements = [
    {
      id: 'top-left',
      group: 'top-left',
      keychainIndex: 0,
      copyIndex: 0,
      x: regions.topRegion.x,
      y: regions.topRegion.y,
      width: regions.topRegion.width,
      height: regions.topRegion.height,
      rotationDegrees: 90,
      orientation: 'rotated-clockwise',
      aspectRatio: rotatedAspect,
      stripWidth: stripSize.stripWidth,
      stripHeight: stripSize.stripHeight,
    },
    {
      id: 'bottom-left',
      group: 'bottom-left',
      keychainIndex: 1,
      copyIndex: 0,
      x: regions.bottomLeftRegion.x,
      y: regions.bottomLeftRegion.y,
      width: regions.bottomLeftRegion.width,
      height: regions.bottomLeftRegion.height,
      rotationDegrees: 0,
      orientation: 'upright',
      aspectRatio: sourceAspect,
      stripWidth: stripSize.stripWidth,
      stripHeight: stripSize.stripHeight,
    },
    {
      id: 'bottom-right',
      group: 'bottom-right',
      keychainIndex: 2,
      copyIndex: 0,
      x: regions.bottomRightRegion.x,
      y: regions.bottomRightRegion.y,
      width: regions.bottomRightRegion.width,
      height: regions.bottomRightRegion.height,
      rotationDegrees: 0,
      orientation: 'upright',
      aspectRatio: sourceAspect,
      stripWidth: stripSize.stripWidth,
      stripHeight: stripSize.stripHeight,
    },
  ];

  return {
    regions,
    placements,
    stripSize,
  };
}

function buildTwoCopyPlacements(placementArea, sourceAspect) {
  const { regions, stripSize } = buildTwoCopyRegions(placementArea, sourceAspect);
  const placements = [
    {
      id: 'left',
      group: 'left',
      keychainIndex: 0,
      copyIndex: 0,
      x: regions.leftRegion.x,
      y: regions.leftRegion.y,
      width: regions.leftRegion.width,
      height: regions.leftRegion.height,
      rotationDegrees: 0,
      orientation: 'upright',
      aspectRatio: sourceAspect,
      stripWidth: stripSize.stripWidth,
      stripHeight: stripSize.stripHeight,
    },
    {
      id: 'right',
      group: 'right',
      keychainIndex: 1,
      copyIndex: 0,
      x: regions.rightRegion.x,
      y: regions.rightRegion.y,
      width: regions.rightRegion.width,
      height: regions.rightRegion.height,
      rotationDegrees: 0,
      orientation: 'upright',
      aspectRatio: sourceAspect,
      stripWidth: stripSize.stripWidth,
      stripHeight: stripSize.stripHeight,
    },
  ];

  return {
    regions,
    placements,
    stripSize,
  };
}

function buildLatestReferencePlacements(canvasWidth, canvasHeight, sourceCrop, keychainCopies = DEFAULT_KEYCHAIN_COPIES) {
  const sourceAspect = sourceCrop?.width && sourceCrop?.height ? sourceCrop.width / sourceCrop.height : 2 / 3;
  const sheetSafeArea = getKeychainSafeArea(canvasWidth, canvasHeight);
  const placementArea = getKeychainPlacementArea(canvasWidth, canvasHeight);
  const copyCount = normalizeKeychainCopyCount(keychainCopies);
  const layout = copyCount === 2
    ? buildTwoCopyPlacements(placementArea, sourceAspect)
    : buildThreeCopyPlacements(placementArea, sourceAspect);

  return {
    safeArea: placementArea,
    sheetSafeArea,
    placementArea,
    regions: layout.regions,
    placements: layout.placements,
    stripSize: layout.stripSize,
    keychainCopies: copyCount,
  };
}

function summarizeGroups(placements) {
  return placements.reduce((groups, placement) => {
    const current = groups[placement.group] || {
      group: placement.group,
      keychainIndex: placement.keychainIndex,
      copyCount: 0,
      orientation: placement.orientation,
      rotationDegrees: placement.rotationDegrees,
      x: placement.x,
      y: placement.y,
      maxX: placement.x + placement.width,
      maxY: placement.y + placement.height,
    };

    current.copyCount += 1;
    current.x = Math.min(current.x, placement.x);
    current.y = Math.min(current.y, placement.y);
    current.maxX = Math.max(current.maxX, placement.x + placement.width);
    current.maxY = Math.max(current.maxY, placement.y + placement.height);
    current.width = current.maxX - current.x;
    current.height = current.maxY - current.y;
    groups[placement.group] = current;
    return groups;
  }, {});
}

function createTestFinalArtworkDataUrl() {
  const { canvas, ctx } = createCanvas(1200, 1800, '#ffffff');

  ctx.fillStyle = '#e9edf3';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#f8fafc';
  ctx.fillRect(48, 48, canvas.width - 96, canvas.height - 96);
  ctx.strokeStyle = '#1f2937';
  ctx.lineWidth = 10;
  ctx.strokeRect(48, 48, canvas.width - 96, canvas.height - 96);

  const photoBlocks = [
    [92, 120, 486, 320, '#f8d7da', '#842029', 'PHOTO 1'],
    [622, 120, 486, 320, '#d1e7dd', '#0f5132', 'PHOTO 1'],
    [92, 485, 486, 320, '#cff4fc', '#055160', 'PHOTO 2'],
    [622, 485, 486, 320, '#fff3cd', '#664d03', 'PHOTO 2'],
    [92, 850, 486, 320, '#e0cffc', '#3d0a91', 'PHOTO 3'],
    [622, 850, 486, 320, '#fde2e4', '#9f1239', 'PHOTO 3'],
    [92, 1215, 486, 320, '#dcfce7', '#166534', 'PHOTO 4'],
    [622, 1215, 486, 320, '#dbeafe', '#1d4ed8', 'PHOTO 4'],
  ];

  photoBlocks.forEach(([x, y, width, height, background, foreground, label]) => {
    ctx.fillStyle = background;
    ctx.fillRect(x, y, width, height);
    ctx.fillStyle = foreground;
    ctx.font = 'bold 58px sans-serif';
    ctx.fillText(label, x + 36, y + 180);
  });

  ctx.fillStyle = '#111827';
  ctx.font = 'bold 62px sans-serif';
  ctx.fillText('FINISHED SESSION ARTWORK', 92, 1650);
  ctx.font = '38px sans-serif';
  ctx.fillText('Template, photos, and branding are baked into this source.', 92, 1710);

  return canvas.toDataURL('image/png');
}

export async function generateKeychain4x6Png({
  layout = null,
  shots = null,
  photos = [],
  finalArtworkDataUrl = '',
  sourceArtworkDataUrl = '',
  sourceStripDataUrl = '',
  selectedTemplate = null,
  selectedTmpl = '',
  selectedFilterCss = '',
  templateAssets = null,
  layoutId = '',
  sessionId = '',
  keychainCopies = DEFAULT_KEYCHAIN_COPIES,
} = {}) {
  const resolvedLayoutId = layoutId || layout?.id || '';
  const resolvedKeychainCopies = normalizeKeychainCopyCount(keychainCopies);
  if (!KEYCHAIN_4X6_LAYOUT_IDS.has(resolvedLayoutId)) {
    console.warn('[keychain] skipped unsupported layout', { layoutId: resolvedLayoutId });
    return null;
  }

  const source = resolveFinalArtworkSource({
    finalArtworkDataUrl,
    sourceArtworkDataUrl,
    sourceStripDataUrl,
  });
  console.log('[keychain audit] source ready', {
    hasSource: Boolean(source),
    sourceType: getSourceType(source),
  });
  const legacyInputCount = Array.isArray(shots) ? shots.length : (photos?.length || 0);
  const artworkImage = await loadFinalArtworkImage(source);
  const sourceCrop = getKeychainSourceCropRect(artworkImage);
  const { canvas, ctx } = createCanvas(
    KEYCHAIN_CANVAS.width,
    KEYCHAIN_CANVAS.height,
    LATEST_REFERENCE_LAYOUT.sheetBackgroundColor,
  );
  const {
    safeArea,
    sheetSafeArea,
    placementArea,
    regions,
    placements,
    stripSize,
  } = buildLatestReferencePlacements(canvas.width, canvas.height, sourceCrop, resolvedKeychainCopies);
  const groups = summarizeGroups(placements);

  console.log('[KEYCHAIN MARGIN AUDIT] outerMargins', {
    top: KEYCHAIN_SAFE_AREA.top,
    right: KEYCHAIN_SAFE_AREA.right,
    bottom: KEYCHAIN_SAFE_AREA.bottom,
    left: KEYCHAIN_SAFE_AREA.left,
  });
  console.log('[KEYCHAIN MARGIN AUDIT] usableArea', {
    kind: 'keychain-placement-area',
    x: safeArea.safeX,
    y: safeArea.safeY,
    width: safeArea.safeWidth,
    height: safeArea.safeHeight,
    right: safeArea.safeRight,
    bottom: safeArea.safeBottom,
    sheetSafeTop: sheetSafeArea.safeY,
  });
  console.log('[KEYCHAIN MARGIN AUDIT] sourceCrop', {
    x: sourceCrop.x,
    y: sourceCrop.y,
    width: sourceCrop.width,
    height: sourceCrop.height,
    margins: sourceCrop.margins,
  });
  console.log('[KEYCHAIN MARGIN AUDIT] perCopyInset', KEYCHAIN_PER_COPY_INSET);
  console.log('[KEYCHAIN MARGIN AUDIT] strip placements', placements);
  console.log('[keychain page-margin] canvas', {
    width: canvas.width,
    height: canvas.height,
  });
  console.log('[keychain page-margin] safeArea', {
    top: KEYCHAIN_SAFE_AREA.top,
    right: KEYCHAIN_SAFE_AREA.right,
    bottom: KEYCHAIN_SAFE_AREA.bottom,
    left: KEYCHAIN_SAFE_AREA.left,
  });
  console.log('[keychain page-margin] contentRect', {
    x: safeArea.safeX,
    y: safeArea.safeY,
    width: safeArea.safeWidth,
    height: safeArea.safeHeight,
    right: safeArea.safeRight,
    bottom: safeArea.safeBottom,
  });
  console.log('[keychain page-margin] strip placements', {
    ...serializePlacementMap(placements),
  });
  console.log('[keychain layout] sheet safe area', {
    safeTop: KEYCHAIN_SAFE_AREA.top,
    safeRight: KEYCHAIN_SAFE_AREA.right,
    safeBottom: KEYCHAIN_SAFE_AREA.bottom,
    safeLeft: KEYCHAIN_SAFE_AREA.left,
  });
  console.log('[keychain margins] safe area', {
    top: KEYCHAIN_SAFE_AREA.top,
    right: KEYCHAIN_SAFE_AREA.right,
    bottom: KEYCHAIN_SAFE_AREA.bottom,
    left: KEYCHAIN_SAFE_AREA.left,
    safeX: safeArea.safeX,
    safeY: safeArea.safeY,
    safeWidth: safeArea.safeWidth,
    safeHeight: safeArea.safeHeight,
  });
  console.log('[keychain maximize] safe area', {
    safeX: safeArea.safeX,
    safeY: safeArea.safeY,
    safeWidth: safeArea.safeWidth,
    safeHeight: safeArea.safeHeight,
  });
  console.log('[keychain maximize] regions', {
    ...serializePlacementMap(Object.values(regions)),
  });
  console.log('[keychain layout] copy regions', {
    ...serializePlacementMap(Object.values(regions)),
  });
  console.log('[keychain layout] strip size', {
    stripWidth: Number(stripSize.stripWidth.toFixed(2)),
    stripHeight: Number(stripSize.stripHeight.toFixed(2)),
  });
  console.log('[keychain layout] placements', {
    ...serializePlacementMap(placements),
  });
  console.log('[keychain-layout] page margin applied', {
    configuredSheetSafeTop: KEYCHAIN_SAFE_AREA.top,
    effectiveTopMarginPx: placementArea.safeY,
    topY: placements[0]?.y ?? null,
    bottomRowY: placements[1]?.y ?? null,
    usableHeight: placementArea.safeHeight,
  });
  drawSafeAreaDebug(ctx, safeArea);
  console.log('[keychain audit] placements', placements);
  placements.forEach((placement) => {
    console.log('[keychain margins] placement', {
      id: placement.id,
      x: placement.x,
      y: placement.y,
      width: placement.width,
      height: placement.height,
    });
    console.log('[keychain margins] bounds check', checkPlacementBounds(placement, safeArea));
    console.log('[keychain maximize] fitted copy', {
      id: placement.id,
      aspectRatio: Number(placement.aspectRatio.toFixed(6)),
      fittedWidth: Number(placement.width.toFixed(2)),
      fittedHeight: Number(placement.height.toFixed(2)),
      x: Number(placement.x.toFixed(2)),
      y: Number(placement.y.toFixed(2)),
    });
    console.log('[keychain maximize] bounds check', checkPlacementBounds(placement, safeArea));
    console.log('[keychain audit] drawing strip once', {
      placementId: placement.id,
      rotate: placement.rotationDegrees,
      x: placement.x,
      y: placement.y,
      width: placement.width,
      height: placement.height,
    });
    drawFinishedArtworkCopy(ctx, artworkImage, placement, sourceCrop);
  });
  console.log('[keychain audit] total strips drawn', {
    count: placements.length,
  });

  console.log('[keychain-layout] latest reference final-artwork layout', {
    sessionId,
    layoutId: resolvedLayoutId,
    keychainCopies: resolvedKeychainCopies,
    selectedTmpl,
    selectedTemplateName: selectedTemplate?.name || null,
    selectedFilterCssBakedIntoSource: Boolean(selectedFilterCss),
    templateAssetsBakedIntoSource: Boolean(templateAssets),
    legacyShotInputIgnored: legacyInputCount,
    canvas: {
      width: canvas.width,
      height: canvas.height,
      backgroundColor: LATEST_REFERENCE_LAYOUT.sheetBackgroundColor,
    },
    safeArea,
    regions,
    sourceArtwork: {
      width: artworkImage.naturalWidth || artworkImage.width,
      height: artworkImage.naturalHeight || artworkImage.height,
      crop: sourceCrop,
    },
    groups,
    placements,
  });

  const blob = await canvasToBlob(canvas, 'image/png');
  const filename = makeKeychainFilename(sessionId, resolvedKeychainCopies);

  if (IS_DEV) {
    console.log('[keychain-layout] generated local-only PNG', {
      sessionId,
      filename,
      sizeBytes: blob.size,
      placementCount: placements.length,
      keychainCopies: resolvedKeychainCopies,
      source: 'final-rendered-session-artwork',
    });
  }

  return {
    kind: 'keychain4x6',
    name: filename,
    blob,
    width: canvas.width,
    height: canvas.height,
    filename,
    mimeType: 'image/png',
    placements,
    keychainCopies: resolvedKeychainCopies,
    groups,
    safeArea,
    source: 'final-rendered-session-artwork',
  };
}

export async function generateKeychain4x6TestPng() {
  console.log('[STEP 3 keychain test] generating latest-reference layout', {
    width: KEYCHAIN_CANVAS.width,
    height: KEYCHAIN_CANVAS.height,
    source: 'finished-session-artwork-test-image',
  });

  const result = await generateKeychain4x6Png({
    sourceStripDataUrl: createTestFinalArtworkDataUrl(),
    layoutId: 'classic-strip-4',
    sessionId: 'step3',
    selectedTmpl: 'step3-test',
  });
  const filename = makeStep3KeychainFilename();

  return {
    ...result,
    kind: 'keychain4x6',
    name: filename,
    filename,
  };
}
