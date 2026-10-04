import St from 'gi://St';
import {paintFrame} from './drawing.js';
import {frameRegions} from './frame-regions.js';

export class DesktopFrame {
    constructor(monitor, theme, sides, state) {
        this.monitor = monitor;
        this.popup = null;
        this.notification = null;
        this.sides = sides;
        this.baseSides = {...sides};
        this.reveals = new Map();
        this.padding = state.radius + state.shadow + 2;
        this.state = state;
        this.theme = theme;
        this.fade = 1;
        this.spread = 1;
        this.actor = new St.Widget({reactive: false, x: monitor.x, y: monitor.y,
            width: monitor.width, height: monitor.height});
        this.actor.connect('destroy', () => { this.destroyed = true; });
        this.surfaces = new Map();
        this.areas = [];
        this.repaint();
    }

    repaint() {
        if (this.destroyed) return;
        const {width, height} = this.monitor;
        // Both holes belong on the same opening; dropping one leaves a
        // transparent banner sitting on the wallpaper.
        const {popup, notification} = this;
        const regions = frameRegions(width, height, this.sides, this.padding, popup, notification);
        const retained = new Map();
        this.lastDirty = [];
        for (const {rect, dynamic} of regions) {
            const key = JSON.stringify(rect);
            let area = this.surfaces.get(key);
            if (!area) {
                area = new St.DrawingArea({reactive: false});
                area.set_position(rect[0], rect[1]);
                area.set_size(rect[2], rect[3]);
                this.actor.add_child(area);
                area.connect('repaint', () => {
                    const cr = area.get_context();
                    try {
                        const [w, h] = area.get_surface_size();
                        cr.scale(w / area.width, h / area.height);
                        cr.translate(-area.x, -area.y);
                        const spread = this.spread ?? 1;
                        const sides = {
                            top: this.sides.top * spread, right: this.sides.right * spread,
                            bottom: this.sides.bottom * spread, left: this.sides.left * spread,
                        };
                        paintFrame(cr, width, height, sides, this.state.radius * spread, this.theme.bg,
                            this.state.shadow * spread, this.popup, this.notification);
                    } finally { cr.$dispose(); }
                });
            }
            area.opacity = Math.round((this.fade ?? 1) * 255);
            const content = JSON.stringify([this.sides, this.spread, dynamic ? popup : null, dynamic ? notification : null]);
            if (area._frameContent !== content) {
                area._frameContent = content;
                area.queue_repaint();
                const [x, y, w, h] = rect;
                this.lastDirty.push({x, y, width: w, height: h});
            }
            retained.set(key, area);
        }
        for (const [key, area] of this.surfaces)
            if (!retained.has(key)) area.destroy();
        this.surfaces = retained;
        this.areas = [...retained.values()];
    }

    setFade(alpha) {
        const next = Math.max(0, Math.min(1, Number.isFinite(alpha) ? alpha : 0));
        const opacity = Math.round(next * 255);
        this.fade = next;
        for (const area of this.areas)
            area.opacity = opacity;
    }

    // shown 1 is the resting border. shown 0 has grown the opening out to the
    // screen edge, so the border is gone. The actor itself does not move.
    setSpread(shown) {
        const next = Math.max(0, Math.min(1, Number.isFinite(shown) ? shown : 1));
        if (this.spread === next)
            return;
        this.spread = next;
        for (const area of this.areas) {
            area._frameContent = null;
            area.queue_repaint();
        }
    }

    setReveal(id, edge, thickness, progress) {
        const previous = this.reveals.get(id);
        if (previous && previous.edge === edge && previous.thickness === thickness && previous.progress === progress)
            return;
        this.reveals.set(id, {edge, thickness, progress});
        Object.assign(this.sides, this.baseSides);
        for (const item of this.reveals.values()) {
            const base = this.baseSides[item.edge];
            this.sides[item.edge] = Math.max(this.sides[item.edge], base + (item.thickness - base) * item.progress);
        }
        this.repaint();
        this.onSidesChange?.();
    }

    setNotification(notification) {
        if (JSON.stringify(this.notification) === JSON.stringify(notification)) return;
        this.notification = notification;
        this.repaint();
        this.onJoinChange?.();
    }

    setPopup(popup) {
        const next = popup ? {...popup, x: popup.x - this.monitor.x, y: popup.y - this.monitor.y} : null;
        if (JSON.stringify(this.popup) === JSON.stringify(next)) return;
        this.popup = next;
        this.repaint();
        this.onJoinChange?.();
    }
}
