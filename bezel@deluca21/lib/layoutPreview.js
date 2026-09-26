import Gtk from 'gi://Gtk';
import {readBars} from './config.js';
import {resolveTheme} from './theme.js';

export function layoutPreview(settings, bars = null, frame = null, height = 170, selection = null) {
    const area = new Gtk.DrawingArea({content_height: height, hexpand: true});
    let targets = [];
    if (selection) {
        const click = new Gtk.GestureClick();
        click.connect('released', (_gesture, _n, x, y) => {
            const target = targets.findLast(item => x >= item.x && x <= item.x + item.w && y >= item.y && y <= item.y + item.h);
            if (target) { selection.select(target.index); area.queue_draw(); }
        });
        area.add_controller(click);
        area.tooltip_text = 'Click a bar to select and edit it';
    }
    area.set_draw_func((_area, cr, width, h) => {
        const theme = resolveTheme(settings);
        const color = hex => cr.setSourceRGB(...[1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255));
        const rect = (x, y, w, hh, radius, hex) => {
            const r = Math.min(radius, w / 2, hh / 2);
            cr.newSubPath();
            cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
            cr.arc(x + w - r, y + hh - r, r, 0, Math.PI / 2);
            cr.arc(x + r, y + hh - r, r, Math.PI / 2, Math.PI);
            cr.arc(x + r, y + r, r, Math.PI, Math.PI * 1.5);
            cr.closePath(); color(hex); cr.fill();
        };
        const x = 8, y = 8, w = width - 16, hh = h - 16;
        const framed = frame ?? settings.get_boolean('show-frame');
        rect(x, y, w, hh, 14, framed ? theme.bg : theme.border);
        if (framed)
            rect(x + 6, y + 6, w - 12, hh - 12, 10, theme.border);
        rect(x + w * .16, y + hh * .20, w * .64, hh * .55, 6, theme.surface);
        const current = bars ?? readBars(settings);
        targets = [];
        for (const [index, bar] of current.entries()) {
            const vertical = ['left', 'right'].includes(bar.edge);
            const thickness = Math.max(12, Math.round(h * 0.22));
            const margin = Math.min(12, (bar.margin ?? 0) / 2);
            const length = bar.kind === 'dock' && bar.fitContent !== false ? .46 : (bar.length ?? 100) / 100;
            const bw = vertical ? thickness : (w - 12) * length;
            const bh = vertical ? (hh - 12) * length : thickness;
            const bx = vertical ? bar.edge === 'left' ? x + margin : x + w - thickness - margin : x + (w - bw) / 2;
            const by = vertical ? y + (hh - bh) / 2 : bar.edge === 'top' ? y + margin : y + hh - thickness - margin;
            targets.push({x: bx - 4, y: by - 4, w: bw + 8, h: bh + 8, index});
            if (selection?.selected() === index) rect(bx - 3, by - 3, bw + 6, bh + 6, 6, theme.accent);
            rect(bx, by, bw, bh, bar.kind === 'dock' || margin ? 6 : 0, theme.bg);
            for (let i = 0; i < 5; i++) {
                const ix = vertical ? bx + 4 : bx + bw / 2 + (i - 2) * 10 - 3;
                const iy = vertical ? by + bh / 2 + (i - 2) * 10 - 3 : by + 4;
                rect(ix, iy, 6, 6, 2, theme.accent);
            }
        }
    });
    return area;
}
