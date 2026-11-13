// Colour maths for the colour checks: WCAG contrast, and how far apart two colours look as
// OKLab ΔE ×100 (Björn Ottosson, 2020), with full colour vision or as protanopia or
// deuteranopia sees them (Machado, Oliveira and Fernandes, 2009, at full severity).

// prettier-ignore
const DEFICIENCIES = {
  protanopia: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deuteranopia: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
};

export const VISIONS = Object.keys(DEFICIENCIES);

const clamp = (value) => Math.min(1, Math.max(0, value));

// Linear-light red, green and blue of a colour written #rrggbb.
function linear(hex) {
  return [1, 3, 5].map((index) => {
    const channel = parseInt(hex.slice(index, index + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
}

function oklab([r, g, b]) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function seen(hex, vision) {
  const rgb = linear(hex);
  if (!vision) return oklab(rgb);
  return oklab(
    DEFICIENCIES[vision].map((row) => clamp(row[0] * rgb[0] + row[1] * rgb[1] + row[2] * rgb[2])),
  );
}

// How far apart two colours look. With no vision given, it is full colour vision.
export function difference(a, b, vision) {
  const [p, q] = [seen(a, vision), seen(b, vision)];
  return 100 * Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

function luminance(hex) {
  const [r, g, b] = linear(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a, b) {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}
