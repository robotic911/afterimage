export const DEFAULT_UI_COLOR_THEME_ID = 'editorialMono';

export const UI_COLOR_THEMES = {
  editorialMono: {
    id: 'editorialMono',
    name: 'Editorial Mono',
    description: 'Minimal black, white, and grayscale.',
    colors: {
      bg: '#0b0b0b',
      surface: '#151515',
      surfaceSoft: '#202020',
      text: '#f5f5f5',
      muted: '#a3a3a3',
      border: 'rgba(255,255,255,0.16)',
      accent: '#ffffff',
      accentText: '#0b0b0b',
    },
  },
  champagneNoir: {
    id: 'champagneNoir',
    name: 'Champagne Noir',
    description: 'Premium black and champagne event styling.',
    colors: {
      bg: '#0b0908',
      surface: '#17120f',
      surfaceSoft: '#241c16',
      text: '#fff7ed',
      muted: '#c7b9a6',
      border: 'rgba(244, 211, 148, 0.22)',
      accent: '#d6b36a',
      accentText: '#15100c',
    },
  },
  roseVelvet: {
    id: 'roseVelvet',
    name: 'Rose Velvet',
    description: 'Romantic rose and blush tones.',
    colors: {
      bg: '#140a0f',
      surface: '#211018',
      surfaceSoft: '#331923',
      text: '#fff1f5',
      muted: '#d7aebd',
      border: 'rgba(255, 182, 193, 0.22)',
      accent: '#f3a6bd',
      accentText: '#1a0b11',
    },
  },
  oceanMist: {
    id: 'oceanMist',
    name: 'Ocean Mist',
    description: 'Cool blue-gray modern event look.',
    colors: {
      bg: '#081116',
      surface: '#101c23',
      surfaceSoft: '#172a34',
      text: '#eef8fb',
      muted: '#9fb8c3',
      border: 'rgba(142, 202, 230, 0.22)',
      accent: '#8ecae6',
      accentText: '#061017',
    },
  },
  forestFilm: {
    id: 'forestFilm',
    name: 'Forest Film',
    description: 'Earthy green film-inspired palette.',
    colors: {
      bg: '#08110c',
      surface: '#111c15',
      surfaceSoft: '#1c2c21',
      text: '#f2f0e6',
      muted: '#b8b79e',
      border: 'rgba(181, 196, 148, 0.22)',
      accent: '#b5c494',
      accentText: '#0b120d',
    },
  },
};

export const UI_COLOR_THEME_LIST = Object.values(UI_COLOR_THEMES);

export function resolveEventColorTheme(event = {}) {
  return UI_COLOR_THEMES[event?.colorThemeId] || UI_COLOR_THEMES[DEFAULT_UI_COLOR_THEME_ID];
}

export function buildThemeStyle(theme) {
  const resolved = theme || UI_COLOR_THEMES[DEFAULT_UI_COLOR_THEME_ID];
  return {
    '--event-bg': resolved.colors.bg,
    '--event-surface': resolved.colors.surface,
    '--event-surface-soft': resolved.colors.surfaceSoft,
    '--event-text': resolved.colors.text,
    '--event-muted': resolved.colors.muted,
    '--event-border': resolved.colors.border,
    '--event-accent': resolved.colors.accent,
    '--event-accent-text': resolved.colors.accentText,
  };
}
