// Pure colour math shared by the server and the colour picker UI (src/colorMath.ts).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    barycentric,
    clampToTriangle,
    cssHsl,
    cssRgb,
    describeHex,
    formatHex,
    hslToHsv,
    hslToRgb,
    hsvToHsl,
    hsvToRgb,
    hueAt,
    normalizeHex,
    parseHex,
    pointAtHue,
    rgbToHsl,
    rgbToHsv,
    svToTrianglePoint,
    trianglePointToSv,
    triangleVertices
} from '../../dist/colorMath.js';

const near = (a, b, eps = 1e-9, msg) => assert.ok(Math.abs(a - b) <= eps, msg ?? `${a} ≈ ${b}`);
const rounded = c => ({ r: Math.round(c.r), g: Math.round(c.g), b: Math.round(c.b) });

describe('hex parsing and formatting', () => {
    it('parses #rrggbb and #rrggbbaa in either case', () => {
        assert.deepEqual(parseHex('#FF8800'), { r: 255, g: 136, b: 0, a: 1 });
        const c = parseHex('#ff880080');
        assert.equal(c.a, 128 / 255);
        for (const bad of ['red', '#fff', '#ffff', '#12345g', '#1234567', '#123456789', '', 'ff8800', null, undefined, 42]) {
            assert.equal(parseHex(bad), null, String(bad));
        }
    });

    it('formats lowercase and drops an opaque alpha byte', () => {
        assert.equal(formatHex({ r: 255, g: 136, b: 0 }), '#ff8800');
        assert.equal(formatHex({ r: 255, g: 136, b: 0, a: 1 }), '#ff8800');
        assert.equal(formatHex({ r: 255, g: 136, b: 0, a: 0.5 }), '#ff880080');
        assert.equal(formatHex({ r: 255, g: 136, b: 0, a: 0 }), '#ff880000');
        assert.equal(formatHex({ r: 300, g: -5, b: 127.6 }), '#ff0080', 'clamped and rounded');
    });

    it('normalizes', () => {
        assert.equal(normalizeHex('#ABCDEF'), '#abcdef');
        assert.equal(normalizeHex('#ABCDEFFF'), '#abcdef', 'opaque alpha dropped');
        assert.equal(normalizeHex('#ABCDEF7F'), '#abcdef7f');
        assert.equal(normalizeHex('#abc'), null);
    });

    it('describes a colour as CSS rgb()/hsl() with alpha', () => {
        assert.deepEqual(describeHex('#123ABC'), { hex: '#123abc', rgb: 'rgb(18, 58, 188)', hsl: 'hsl(226, 83%, 40%)', alpha: 1 });
        assert.deepEqual(describeHex('#ff000080'), { hex: '#ff000080', rgb: 'rgba(255, 0, 0, 0.502)', hsl: 'hsla(0, 100%, 50%, 0.502)', alpha: 0.502 });
        assert.equal(cssRgb({ r: 0, g: 0, b: 0, a: 0 }), 'rgba(0, 0, 0, 0)');
        assert.equal(cssHsl({ r: 255, g: 255, b: 255, a: 1 }), 'hsl(0, 0%, 100%)');
        assert.equal(describeHex('nope'), null);
    });
});

describe('HSV / HSL / RGB conversions', () => {
    const known = [
        // rgb, hsv, hsl
        [{ r: 255, g: 0, b: 0 }, { h: 0, s: 1, v: 1 }, { h: 0, s: 1, l: 0.5 }],
        [{ r: 0, g: 255, b: 0 }, { h: 120, s: 1, v: 1 }, { h: 120, s: 1, l: 0.5 }],
        [{ r: 0, g: 0, b: 255 }, { h: 240, s: 1, v: 1 }, { h: 240, s: 1, l: 0.5 }],
        [{ r: 255, g: 255, b: 0 }, { h: 60, s: 1, v: 1 }, { h: 60, s: 1, l: 0.5 }],
        [{ r: 255, g: 0, b: 255 }, { h: 300, s: 1, v: 1 }, { h: 300, s: 1, l: 0.5 }],
        [{ r: 255, g: 255, b: 255 }, { h: 0, s: 0, v: 1 }, { h: 0, s: 0, l: 1 }],
        [{ r: 0, g: 0, b: 0 }, { h: 0, s: 0, v: 0 }, { h: 0, s: 0, l: 0 }],
        [{ r: 128, g: 128, b: 128 }, { h: 0, s: 0, v: 128 / 255 }, { h: 0, s: 0, l: 128 / 255 }]
    ];

    it('rgb → hsv and hsl for primaries, greys, black and white', () => {
        for (const [rgb, hsv, hsl] of known) {
            const got = rgbToHsv(rgb);
            near(got.h, hsv.h, 1e-9, `h of ${JSON.stringify(rgb)}`);
            near(got.s, hsv.s);
            near(got.v, hsv.v);
            const gl = rgbToHsl(rgb);
            near(gl.h, hsl.h);
            near(gl.s, hsl.s);
            near(gl.l, hsl.l);
        }
    });

    it('hsv → rgb and hsl → rgb for known colours', () => {
        assert.deepEqual(rounded(hsvToRgb({ h: 0, s: 1, v: 1 })), { r: 255, g: 0, b: 0 });
        assert.deepEqual(rounded(hsvToRgb({ h: 360, s: 1, v: 1 })), { r: 255, g: 0, b: 0 }, 'hue wraps');
        assert.deepEqual(rounded(hsvToRgb({ h: 210, s: 0.5, v: 0.8 })), { r: 102, g: 153, b: 204 });
        assert.deepEqual(rounded(hslToRgb({ h: 210, s: 0.5, l: 0.6 })), { r: 102, g: 153, b: 204 });
        assert.deepEqual(rounded(hslToRgb({ h: 30, s: 1, l: 0.5 })), { r: 255, g: 128, b: 0 });
    });

    it('round-trips every 8-bit colour on a grid exactly (rgb → hsv → rgb, rgb → hsl → rgb)', () => {
        for (let r = 0; r <= 255; r += 15)
            for (let g = 0; g <= 255; g += 17)
                for (let b = 0; b <= 255; b += 51) {
                    const c = { r, g, b };
                    assert.deepEqual(rounded(hsvToRgb(rgbToHsv(c))), c);
                    assert.deepEqual(rounded(hslToRgb(rgbToHsl(c))), c);
                }
    });

    it('hsv ↔ hsl are inverses', () => {
        for (const hsv of [{ h: 10, s: 0.3, v: 0.7 }, { h: 200, s: 1, v: 0.5 }, { h: 300, s: 0.05, v: 0.95 }]) {
            const back = hslToHsv(hsvToHsl(hsv));
            near(back.s, hsv.s, 1e-12);
            near(back.v, hsv.v, 1e-12);
            assert.equal(back.h, hsv.h);
        }
        assert.deepEqual(hsvToHsl({ h: 50, s: 0.4, v: 0 }), { h: 50, s: 0, l: 0 }, 'black');
        assert.deepEqual(hslToHsv({ h: 50, s: 0.4, l: 0 }), { h: 50, s: 0, v: 0 });
    });
});

describe('hue ring geometry', () => {
    it('red right, hue grows counter-clockwise on screen (y down)', () => {
        near(hueAt(110, 100, 100, 100), 0);
        near(hueAt(100, 90, 100, 100), 90, 1e-9, 'up is 90°');
        near(hueAt(90, 100, 100, 100), 180);
        near(hueAt(100, 110, 100, 100), 270, 1e-9, 'down is 270°');
    });

    it('pointAtHue is the inverse of hueAt', () => {
        for (const h of [0, 33, 90, 179.5, 270, 359]) {
            const p = pointAtHue(h, 50, 60, 40);
            near(hueAt(p.x, p.y, 50, 60), h, 1e-9);
            near(Math.hypot(p.x - 50, p.y - 60), 40, 1e-9);
        }
    });
});

describe('S/V triangle', () => {
    const t = triangleVertices(100, 100, 80, 30);

    it('puts the pure hue at the tip, then white and black', () => {
        near(hueAt(t.hue.x, t.hue.y, 100, 100), 30, 1e-9);
        near(hueAt(t.white.x, t.white.y, 100, 100), 150, 1e-9);
        near(hueAt(t.black.x, t.black.y, 100, 100), 270, 1e-9);
    });

    it('maps the corners and the centre', () => {
        assert.deepEqual(svToTrianglePoint(1, 1, t), t.hue);
        const w = svToTrianglePoint(0, 1, t);
        near(w.x, t.white.x);
        near(w.y, t.white.y);
        const k = svToTrianglePoint(0.7, 0, t);
        near(k.x, t.black.x);
        near(k.y, t.black.y);
        const sv = trianglePointToSv({ x: 100, y: 100 }, t); // centroid: weights 1/3 each
        near(sv.v, 2 / 3, 1e-12);
        near(sv.s, 0.5, 1e-12);
    });

    it('round-trips s/v through a point', () => {
        for (const [s, v] of [[0.2, 0.9], [1, 0.5], [0.5, 0.25], [0, 0.6], [0.99, 0.01]]) {
            const back = trianglePointToSv(svToTrianglePoint(s, v, t), t);
            near(back.s, s, 1e-9, `s ${s}`);
            near(back.v, v, 1e-9, `v ${v}`);
        }
    });

    it('clamps points outside onto the nearest edge or corner', () => {
        const far = pointAtHue(30, 100, 100, 300); // way beyond the hue tip
        const c = clampToTriangle(far, t);
        near(c.x, t.hue.x, 1e-9);
        near(c.y, t.hue.y, 1e-9);
        const top = trianglePointToSv(far, t);
        near(top.s, 1, 1e-9);
        near(top.v, 1, 1e-9);

        // beyond the white–black edge (opposite the tip): saturation 0
        const behind = pointAtHue(210, 100, 100, 70);
        const sv = trianglePointToSv(behind, t);
        near(sv.s, 0, 1e-9);
        near(sv.v, 0.5, 1e-9, 'middle of the white–black edge');

        const w = barycentric(clampToTriangle(behind, t), t);
        for (const x of Object.values(w)) assert.ok(x >= -1e-9);
        const inside = { x: 105, y: 95 };
        assert.equal(clampToTriangle(inside, t), inside, 'inside points are returned as is');
    });

    it('black (v = 0) has saturation 0', () => {
        assert.deepEqual(trianglePointToSv(t.black, t), { s: 0, v: 0 });
    });
});
