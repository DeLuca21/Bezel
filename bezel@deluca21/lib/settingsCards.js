import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import Cairo from 'cairo';

// Preview choices are independent of the live configuration until selected.
export function optionCards(options, selected, apply, columns = 2) {
    const grid = new Gtk.FlowBox({selection_mode: Gtk.SelectionMode.NONE, homogeneous: true,
        min_children_per_line: columns, max_children_per_line: columns, column_spacing: 12, row_spacing: 10});
    const buttons = new Map();
    for (const {id, title, preview} of options) {
        const body = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 8});
        body.append(preview);
        body.append(new Gtk.Label({label: title, css_classes: ['option-title']}));
        const button = new Gtk.Button({child: body, hexpand: true, css_classes: ['option-card'], tooltip_text: title});
        if (id === selected) button.add_css_class('selected');
        button.connect('clicked', () => {
            for (const [key, widget] of buttons) {
                if (key === id) widget.add_css_class('selected');
                else widget.remove_css_class('selected');
            }
            apply(id);
        });
        buttons.set(id, button);
        grid.insert(button, -1);
    }
    return grid;
}

function rounded(cr, x, y, w, h, radius) {
    const r = Math.min(radius, w / 2, h / 2);
    cr.newSubPath();
    cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, Math.PI * 1.5);
    cr.closePath();
}

export function barPicture({kind = 'panel', sections = 'one', margin = 8, edge = 'top', glass = false, opacity = 100,
    rounding = 10, frame = false, compact = false, indicator = 'line', focus = 'none', hover = 'none'} = {}) {
    const area = new Gtk.DrawingArea({content_width: compact ? 76 : 104, content_height: compact ? 34 : 46, halign: Gtk.Align.CENTER});
    area.set_draw_func((_area, cr, w, h) => {
        const paint = (x, y, width, height, radius, color, alpha = 1) => {
            rounded(cr, x, y, width, height, radius);
            cr.setSourceRGBA(...color, alpha); cr.fill();
        };
        rounded(cr, 0, 0, w, h, 8);
        cr.save(); cr.clip();
        const wallpaper = new Cairo.LinearGradient(0, 0, w, h);
        wallpaper.addColorStopRGB(0, .68, .62, .52);
        wallpaper.addColorStopRGB(1, .22, .31, .25);
        cr.setSource(wallpaper); cr.paint();
        if (frame) {
            cr.setSourceRGB(.08, .09, .11); cr.setLineWidth(6);
            rounded(cr, 2, 2, w - 4, h - 4, 7); cr.stroke();
        }
        const vertical = ['left', 'right'].includes(edge);
        const inset = margin ? 6 : 0;
        const length = kind === 'dock' ? (vertical ? h : w) * .65 : (vertical ? h : w) - inset * 2;
        const thick = kind === 'dock' ? 16 : 12;
        const x = vertical ? edge === 'left' ? inset : w - thick - inset : (w - length) / 2;
        const y = vertical ? (h - length) / 2 : edge === 'top' ? inset : h - thick - inset;
        const bw = vertical ? thick : length, bh = vertical ? length : thick;
        const surface = glass ? [.17, .2, .23] : [.04, .05, .06];
        const alpha = glass ? .58 : opacity / 100;
        if (sections === 'pills') {
            for (const [at, share] of [[0, .23], [.37, .26], [.77, .23]])
                paint(x + (vertical ? 0 : bw * at), y + (vertical ? bh * at : 0), vertical ? bw : bw * share, vertical ? bh * share : bh, rounding, surface, alpha);
        } else paint(x, y, bw, bh, margin ? rounding : 0, surface, alpha);
        if (glass) {
            rounded(cr, x + .5, y + .5, bw - 1, bh - 1, rounding);
            cr.setSourceRGBA(1, 1, 1, .25); cr.setLineWidth(1); cr.stroke();
        }
        for (let i = 0; i < (kind === 'dock' ? 4 : 6); i++) {
            const count = kind === 'dock' ? 4 : 6;
            const at = (i + .5) / count;
            const cx = x + (vertical ? bw / 2 : bw * at), cy = y + (vertical ? bh * at : bh / 2);
            const lifted = i === 1 && ['lift', 'both'].includes(hover) ? -3 : 0;
            if (i === 1 && (['background', 'both'].includes(focus) || ['highlight', 'both'].includes(hover)))
                paint(cx - 5, cy - 5, 10, 10, 3, [.3, .6, .95], .6);
            paint(cx - 2.5, cy - 2.5 + lifted, 5, 5, 1.5, i === 1 ? [.4, .7, 1] : [.9, .91, .9]);
            if (kind === 'dock' && indicator !== 'none')
                paint(cx - (indicator === 'dot' ? 1 : 3), cy + 5, indicator === 'dot' ? 2 : 6, 2, 1, [.9, .91, .9]);
            if (i === 1 && ['line', 'both'].includes(focus)) paint(cx - 4, cy + 5, 8, 2, 1, [.4, .7, 1]);
        }
        cr.restore();
    });
    return area;
}

export function palettePicture(palette) {
    const area = new Gtk.DrawingArea({content_width: 132, content_height: 80, halign: Gtk.Align.CENTER});
    area.set_draw_func((_area, cr) => {
        const paint = (x, y, w, h, radius, hex) => {
            const c = new Gdk.RGBA(); c.parse(hex);
            rounded(cr, x, y, w, h, radius); cr.setSourceRGBA(c.red, c.green, c.blue, 1); cr.fill();
        };
        paint(0, 0, 132, 80, 10, palette.bg);
        paint(7, 7, 118, 13, 6, palette.surface);
        paint(7, 28, 64, 9, 4, palette.muted ?? palette.fg);
        paint(7, 56, 57, 16, 8, palette.accent);
        paint(78, 56, 47, 16, 8, palette.group ?? palette.surface);
    });
    return area;
}
