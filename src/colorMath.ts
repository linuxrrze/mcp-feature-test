/**
 * Pure colour math shared by the server (validation, pick_color_result text)
 * and the colour picker UI (ui/color-picker.ts bundles it with esbuild).
 * No DOM, no Node APIs, so it is unit-tested straight from dist/colorMath.js.
 *
 * Conventions: r, g, b in 0..255 (floats allowed, rounded when formatted),
 * alpha a in 0..1, hue h in degrees 0..360, s/v/l in 0..1.
 */

export interface Rgb {
    r: number;
    g: number;
    b: number;
}
export interface Rgba extends Rgb {
    a: number;
}
export interface Hsv {
    h: number;
    s: number;
    v: number;
}
export interface Hsl {
    h: number;
    s: number;
    l: number;
}
export interface Point {
    x: number;
    y: number;
}

/** #rrggbb or #rrggbbaa, either case. */
export const HEX_COLOR = /^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/;

export const clamp = (x: number, lo = 0, hi = 1): number => (x < lo ? lo : x > hi ? hi : x);
const mod = (x: number, m: number): number => ((x % m) + m) % m;
const hex2 = (n: number): string => Math.round(clamp(n, 0, 255)).toString(16).padStart(2, '0');

/** Parse #rrggbb / #rrggbbaa; null when invalid. Alpha defaults to 1 (opaque). */
export function parseHex(s: string): Rgba | null {
    if (typeof s !== 'string' || !HEX_COLOR.test(s)) return null;
    const n = (i: number) => parseInt(s.slice(i, i + 2), 16);
    return { r: n(1), g: n(3), b: n(5), a: s.length === 9 ? n(7) / 255 : 1 };
}

/** Lowercase hex; the alpha byte is left out when it is ff (backward compatible #rrggbb). */
export function formatHex(c: Rgb & { a?: number }): string {
    const a = Math.round(clamp(c.a ?? 1) * 255);
    return `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}${a === 255 ? '' : hex2(a)}`;
}

/** Validate and normalise (lowercase, #rrggbbff → #rrggbb); null when invalid. */
export function normalizeHex(s: string): string | null {
    const c = parseHex(s);
    return c ? formatHex(c) : null;
}

export function rgbToHsv({ r, g, b }: Rgb): Hsv {
    r /= 255;
    g /= 255;
    b /= 255;
    const max = Math.max(r, g, b);
    const d = max - Math.min(r, g, b);
    let h = 0;
    if (d > 0) {
        if (max === r) h = mod((g - b) / d, 6);
        else if (max === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
    }
    return { h: h * 60, s: max === 0 ? 0 : d / max, v: max };
}

export function hsvToRgb({ h, s, v }: Hsv): Rgb {
    const f = (n: number) => {
        const k = mod(n + h / 60, 6);
        return (v - v * s * Math.max(0, Math.min(k, 4 - k, 1))) * 255;
    };
    return { r: f(5), g: f(3), b: f(1) };
}

export function hsvToHsl({ h, s, v }: Hsv): Hsl {
    const l = v * (1 - s / 2);
    const sl = l === 0 || l === 1 ? 0 : (v - l) / Math.min(l, 1 - l);
    return { h, s: sl, l };
}

export function hslToHsv({ h, s, l }: Hsl): Hsv {
    const v = l + s * Math.min(l, 1 - l);
    return { h, s: v === 0 ? 0 : 2 * (1 - l / v), v };
}

export const rgbToHsl = (c: Rgb): Hsl => hsvToHsl(rgbToHsv(c));
export const hslToRgb = (c: Hsl): Rgb => hsvToRgb(hslToHsv(c));

const round = (x: number, digits = 0) => {
    const f = 10 ** digits;
    return Math.round(x * f) / f;
};
const alphaText = (a: number) => String(round(a, 3));

/** CSS rgb()/rgba() text with integer channels. */
export function cssRgb(c: Rgba): string {
    const [r, g, b] = [c.r, c.g, c.b].map(x => Math.round(clamp(x, 0, 255)));
    return c.a >= 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${alphaText(c.a)})`;
}

/** CSS hsl()/hsla() text, computed from the rounded 8-bit channels. */
export function cssHsl(c: Rgba): string {
    const hsl = rgbToHsl({ r: Math.round(c.r), g: Math.round(c.g), b: Math.round(c.b) });
    const body = `${Math.round(hsl.h) % 360}, ${Math.round(hsl.s * 100)}%, ${Math.round(hsl.l * 100)}%`;
    return c.a >= 1 ? `hsl(${body})` : `hsla(${body}, ${alphaText(c.a)})`;
}

/** Everything the server reports about a colour. */
export function describeHex(hex: string): { hex: string; rgb: string; hsl: string; alpha: number } | null {
    const c = parseHex(hex);
    if (!c) return null;
    const a = Math.round(c.a * 255) / 255;
    return { hex: formatHex(c), rgb: cssRgb(c), hsl: cssHsl(c), alpha: round(a, 3) };
}

// ------------------------------------------------------------ hue ring

/**
 * Hue at a point around a centre (screen coordinates, y down). Red (0°) points
 * right and hue grows counter-clockwise: yellow lower right, green below, blue upper left.
 */
export function hueAt(x: number, y: number, cx: number, cy: number): number {
    return mod((Math.atan2(-(y - cy), x - cx) * 180) / Math.PI, 360);
}

/** The point at a hue on a circle of radius r (inverse of hueAt). */
export function pointAtHue(h: number, cx: number, cy: number, r: number): Point {
    const t = (h * Math.PI) / 180;
    return { x: cx + r * Math.cos(t), y: cy - r * Math.sin(t) };
}

// ------------------------------------------------------- S/V triangle

/** Vertices of the S/V triangle: `hue` (s=1,v=1) points at the hue on the ring, then white (s=0,v=1) and black (v=0). */
export interface Triangle {
    hue: Point;
    white: Point;
    black: Point;
}

export function triangleVertices(cx: number, cy: number, r: number, h: number): Triangle {
    return { hue: pointAtHue(h, cx, cy, r), white: pointAtHue(h + 120, cx, cy, r), black: pointAtHue(h + 240, cx, cy, r) };
}

/** Barycentric weights of p for the triangle (sum 1; all ≥ 0 inside). */
export function barycentric(p: Point, t: Triangle): { hue: number; white: number; black: number } {
    const { hue: a, white: b, black: c } = t;
    const det = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y);
    const wa = ((b.y - c.y) * (p.x - c.x) + (c.x - b.x) * (p.y - c.y)) / det;
    const wb = ((c.y - a.y) * (p.x - c.x) + (a.x - c.x) * (p.y - c.y)) / det;
    return { hue: wa, white: wb, black: 1 - wa - wb };
}

function closestOnSegment(p: Point, a: Point, b: Point): Point {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / len2);
    return { x: a.x + t * dx, y: a.y + t * dy };
}

/** p itself when inside the triangle, else the nearest point on its edges. */
export function clampToTriangle(p: Point, t: Triangle): Point {
    const w = barycentric(p, t);
    if (w.hue >= 0 && w.white >= 0 && w.black >= 0) return p;
    let best = p;
    let bestD = Infinity;
    for (const [a, b] of [
        [t.hue, t.white],
        [t.white, t.black],
        [t.black, t.hue]
    ] as const) {
        const q = closestOnSegment(p, a, b);
        const d = (q.x - p.x) ** 2 + (q.y - p.y) ** 2;
        if (d < bestD) {
            bestD = d;
            best = q;
        }
    }
    return best;
}

/** Position of a saturation/value pair in the triangle: black + v·(white − black) + v·s·(hue − white). */
export function svToTrianglePoint(s: number, v: number, t: Triangle): Point {
    s = clamp(s);
    v = clamp(v);
    const wh = v * s;
    const ww = v * (1 - s);
    const wk = 1 - v;
    return { x: wh * t.hue.x + ww * t.white.x + wk * t.black.x, y: wh * t.hue.y + ww * t.white.y + wk * t.black.y };
}

/** Saturation/value at a point; points outside are clamped onto the triangle first. */
export function trianglePointToSv(p: Point, t: Triangle): { s: number; v: number } {
    const w = barycentric(clampToTriangle(p, t), t);
    const hue = Math.max(0, w.hue);
    const v = clamp(hue + Math.max(0, w.white));
    return { s: v < 1e-9 ? 0 : clamp(hue / v), v };
}
