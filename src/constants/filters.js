// Filter presets used on the Camera screen.
// `css` is applied to previews and downstream print/softcopy render canvases.
export const FILTERS = [
  { id: 'none',    name: 'Natural',     desc: 'No filter',          bg: 'linear-gradient(135deg,#f4f4f4,#cfcfcf)', css: '' },
  { id: 'warm',    name: 'Golden Hour', desc: 'Warm & bright',      bg: 'linear-gradient(135deg,#fff1b8,#f59e0b)', css: 'sepia(0.3) saturate(1.4) brightness(1.05)' },
  { id: 'bw',      name: 'Noir',        desc: 'Black & white',      bg: 'linear-gradient(135deg,#f8f8f8,#111111)', css: 'grayscale(1) contrast(1.1)' },
  { id: 'cool',    name: 'Mist',        desc: 'Cool & airy',        bg: 'linear-gradient(135deg,#e7f0f4,#9bbdce)', css: 'hue-rotate(15deg) saturate(0.8) brightness(1.05)' },
  { id: 'vintage', name: 'Vintage',     desc: 'Faded film',         bg: 'linear-gradient(135deg,#d2b48c,#8a6f4d)', css: 'sepia(0.55) contrast(0.9) brightness(1.02)' },
  { id: 'vivid',   name: 'Vivid',       desc: 'Bold colors',        bg: 'linear-gradient(135deg,#ff4d4d,#4f46e5)', css: 'saturate(1.7) contrast(1.1)' },
  { id: 'lomo',    name: 'Lomo',        desc: 'Vignette film',      bg: 'radial-gradient(circle at 35% 30%,#8b5cf6 0%,#5b3fa0 38%,#111111 78%)', css: 'saturate(1.4) contrast(1.2) hue-rotate(-10deg)' },
  { id: 'blush',   name: 'Blush',       desc: 'Soft pink glow',     bg: 'linear-gradient(135deg,#ffd6e7,#f7a8c8)', css: 'sepia(0.16) saturate(1.2) brightness(1.08) hue-rotate(-8deg)' },
  { id: 'mocha',   name: 'Mocha',       desc: 'Rich cafe tones',    bg: 'linear-gradient(135deg,#c2a385,#6b4423)', css: 'sepia(0.42) saturate(1.05) contrast(1.08) brightness(0.98)' },
];

export const TOTAL_SHOTS = 4;

export const TWEAK_DEFAULTS = {
  primaryColor: '#000000',
  countdown: 3,
};
