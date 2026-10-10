import Gtk from 'gi://Gtk';
import {readBars, barGroups, groupAppearance, groupFillColor} from './config.js';
import {resolveTheme} from './theme.js';

export function layoutPreview(settings, bars = null, frame = null, height = 170, selection = null, palette = null) {
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
        const theme = palette ?? resolveTheme(settings);
        const color = (hex, alpha = 1) => cr.setSourceRGBA(...[1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255), alpha);
        const rect = (x, y, w, hh, radius, hex, alpha = 1, outline = false) => {
            const r = Math.min(radius, w / 2, hh / 2);
            cr.newSubPath();
            cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
            cr.arc(x + w - r, y + hh - r, r, 0, Math.PI / 2);
            cr.arc(x + r, y + hh - r, r, Math.PI / 2, Math.PI);
            cr.arc(x + r, y + r, r, Math.PI, Math.PI * 1.5);
            cr.closePath(); color(hex, alpha);
            if (outline) { cr.setLineWidth(2); cr.stroke(); } else cr.fill();
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
            const surface = !framed && bar.ownColors && bar.ownSurface ? bar.ownSurface : theme.bg;
            const accent = !framed && bar.ownColors && bar.ownAccent ? bar.ownAccent : theme.accent;
            if (selection?.selected() === index) rect(bx - 3, by - 3, bw + 6, bh + 6, 6, accent, 1, true);
            const mods = bar.modules ?? [];
            const occupied = ['start', 'center', 'end'].filter(place => mods.some(item =>
                (item.place || 'center') === place && item.id !== 'spacer' && !String(item.id).startsWith('spacer')));
            const sections = {};
            if (bar.sections === 'pills' && occupied.length) {
                const gap = 4;
                const along = vertical ? bh : bw;
                const counts = Object.fromEntries(occupied.map(place => [place, Math.max(1, mods.filter(item => item.place === place).length)]));
                const share = occupied.reduce((sum, place) => sum + counts[place], 0);
                const widths = {};
                for (const place of occupied)
                    widths[place] = Math.max(vertical ? 14 : 36, (along - gap * (occupied.length - 1)) * counts[place] / share * 0.62);
                const at = {};
                const origin = vertical ? by : bx;
                if (occupied.includes('start')) at.start = origin;
                if (occupied.includes('end')) at.end = origin + along - widths.end;
                if (occupied.includes('center')) at.center = origin + (along - widths.center) / 2;
                if (occupied.length === 3 && (at.center < at.start + widths.start + gap || at.center + widths.center + gap > at.end)) {
                    const extra = Math.max(0, along - widths.start - widths.center - widths.end - gap * 2);
                    at.start = origin;
                    at.center = origin + widths.start + gap + extra / 2;
                    at.end = at.center + widths.center + gap + extra / 2;
                }
                for (const place of occupied) {
                    const px = vertical ? bx : at[place];
                    const py = vertical ? at[place] : by;
                    const pw = vertical ? bw : widths[place];
                    const ph = vertical ? widths[place] : bh;
                    rect(px, py, pw, ph, 6, surface, (bar.barOpacity ?? 100) / 100);
                    sections[place] = {x: px, y: py, w: pw, h: ph};
                }
            } else {
                rect(bx, by, bw, bh, bar.kind === 'dock' || margin ? (bar.rounding ?? 20) * .3 : 0, surface, (bar.barOpacity ?? 100) / 100);
                const third = (vertical ? bh : bw) / 3;
                for (const [index, place] of ['start', 'center', 'end'].entries()) {
                    sections[place] = vertical
                        ? {x: bx, y: by + index * third, w: bw, h: third}
                        : {x: bx + index * third, y: by, w: third, h: bh};
                }
            }
            const apps = mods.find(item => item.id === 'apps');
            if (apps) {
                const home = sections[apps.place || 'start'] ?? sections.center ?? {x: bx, y: by, w: bw, h: bh};
                const group = barGroups(bar).find(item => item.id === apps.group);
                const fill = groupFillColor(group, bar, theme);
                if (apps.group && fill) {
                    const look = groupAppearance(group, bar);
                    const along = 32 + look.padding * .4;
                    const cross = 6 + look.inset * .4;
                    rect(home.x + home.w / 2 - (vertical ? cross : along) / 2,
                        home.y + home.h / 2 - (vertical ? along : cross) / 2,
                        vertical ? cross : along, vertical ? along : cross, look.rounding * .3, fill, look.opacity / 100);
                }
                for (let i = 0; i < 4; i++) {
                    const ix = vertical ? home.x + home.w / 2 - 3 : home.x + home.w / 2 + (i - 1.5) * 8 - 3;
                    const iy = vertical ? home.y + home.h / 2 + (i - 1.5) * 8 - 3 : home.y + home.h / 2 - 3;
                    rect(ix, iy, 6, 6, 2, accent);
                }
            } else {
                for (const place of (occupied.length ? occupied : ['center'])) {
                    const home = sections[place] ?? {x: bx, y: by, w: bw, h: bh};
                    rect(home.x + home.w / 2 - 3, home.y + home.h / 2 - 3, 6, 6, 2, accent);
                }
            }
        }
    });
    return area;
}
