// Record Bezel's existing openingPath as lines and circular arcs for the GPU.
// This is a path adapter, not a second implementation of the drawer shoulders.
const TAU = Math.PI * 2;
export const MAX_PATH_PARTS = 64;
export class LiquidPath {
    constructor() {
        this.parts = [];
        this.matrix = [1, 0, 0, 1, 0, 0];
        this.stack = [];
        this.current = null;
        this.first = null;
    }
    point(x, y) {
        const [a, b, c, d, e, f] = this.matrix;
        return [a * x + c * y + e, b * x + d * y + f];
    }
    save() { this.stack.push([...this.matrix]); }
    restore() { this.matrix = this.stack.pop(); }
    transform(a, b, c, d, e, f) {
        const [aa, bb, cc, dd, ee, ff] = this.matrix;
        this.matrix = [aa * a + cc * b, bb * a + dd * b, aa * c + cc * d,
            bb * c + dd * d, aa * e + cc * f + ee, bb * e + dd * f + ff];
    }
    translate(x, y) { this.transform(1, 0, 0, 1, x, y); }
    rotate(angle) { this.transform(Math.cos(angle), Math.sin(angle), -Math.sin(angle), Math.cos(angle), 0, 0); }
    scale(x, y) { this.transform(x, 0, 0, y, 0, 0); }
    newPath() { this.parts = []; this.current = null; this.first = null; }
    moveTo(x, y) { this.current = this.point(x, y); this.first = [...this.current]; }
    lineTo(x, y) { this.line(this.point(x, y)); }
    line(end) {
        if (this.current && Math.hypot(end[0] - this.current[0], end[1] - this.current[1]) > 1e-7)
            this.parts.push({geometry: [...this.current, ...end], kind: 0, sweep: 0});
        this.current = end;
    }
    arc(x, y, radius, start, end) { this.circle(x, y, radius, start, end, 1); }
    arcNegative(x, y, radius, start, end) { this.circle(x, y, radius, start, end, -1); }
    circle(x, y, radius, start, end, direction) {
        const center = this.point(x, y);
        const first = this.point(x + radius * Math.cos(start), y + radius * Math.sin(start));
        this.line(first);
        let sweep = end - start;
        while (direction > 0 && sweep < 0) sweep += TAU;
        while (direction < 0 && sweep > 0) sweep -= TAU;
        const [a, b, c, d] = this.matrix;
        sweep *= Math.sign(a * d - b * c);
        const r = Math.hypot(first[0] - center[0], first[1] - center[1]);
        const angle = Math.atan2(first[1] - center[1], first[0] - center[0]);
        if (r > 0 && Math.abs(sweep) > 1e-8)
            this.parts.push({geometry: [...center, r, angle], kind: 1, sweep});
        this.current = this.point(x + radius * Math.cos(end), y + radius * Math.sin(end));
    }
    closePath() { if (this.first) this.line([...this.first]); }
    uniforms() {
        if (this.parts.length > MAX_PATH_PARTS) throw new Error('Liquid opening path exceeds GPU capacity');
        const geometry = [], types = [];
        for (let i = 0; i < MAX_PATH_PARTS; i++) {
            geometry.push(...(this.parts[i]?.geometry ?? [0, 0, 0, 0]));
            types.push(this.parts[i]?.kind ?? 0, this.parts[i]?.sweep ?? 0);
        }
        return {geometry, types, count: this.parts.length};
    }
    // Same primitive evaluator as the shader, for Cairo pixel comparisons.
    contains(x, y) {
        let crossings = 0;
        y += 0.000137;
        for (const part of this.parts) {
            const [a, b, c, d] = part.geometry;
            if (!part.kind) {
                if ((b > y) !== (d > y) && a + (y - b) * (c - a) / (d - b) > x) crossings++;
            } else if (Math.abs(y - b) < c) {
                const theta = Math.asin((y - b) / c);
                for (const angle of [theta, Math.PI - theta]) {
                    const along = ((Math.sign(part.sweep) * (angle - d)) % TAU + TAU) % TAU;
                    if (along < Math.abs(part.sweep) && a + c * Math.cos(angle) > x) crossings++;
                }
            }
        }
        return crossings % 2 !== 0;
    }
}
