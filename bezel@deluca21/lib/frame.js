import St from 'gi://St';
import {paintFrame} from './drawing.js';
import {frameRegions} from './frame-regions.js';

export class DesktopFrame {
    constructor(monitor, theme, sides, state) {
        this.monitor = monitor;
        this.popup = null;
        this.sides = sides;
        this.baseSides = {...sides};
        this.reveals = new Map();
        this.padding = state.radius + state.shadow + 2;
        this.state = state;
        this.theme = theme;
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
        const popup = this.popup?.corner ? null : this.popup;
        const notification = this.popup?.corner ? this.popup : this.popup ? null : this.notification;
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
                        paintFrame(cr, width, height, this.sides, this.state.radius, this.theme.bg,
                            this.state.shadow, this.popup?.corner ? null : this.popup,
                            this.popup?.corner ? this.popup : this.popup ? null : this.notification);
                    } finally { cr.$dispose(); }
                });
            }
            const content = JSON.stringify([this.sides, dynamic ? popup : null, dynamic ? notification : null]);
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

    setReveal(id, edge, thickness, progress) {
        this.reveals.set(id, {edge, thickness, progress});
        Object.assign(this.sides, this.baseSides);
        for (const item of this.reveals.values()) {
            const base = this.baseSides[item.edge];
            this.sides[item.edge] = Math.max(this.sides[item.edge], base + (item.thickness - base) * item.progress);
        }
        this.repaint();
    }

    setNotification(notification) {
        if (JSON.stringify(this.notification) === JSON.stringify(notification)) return;
        this.notification = notification;
        this.repaint();
    }

    setPopup(popup) {
        const next = popup ? {...popup, x: popup.x - this.monitor.x, y: popup.y - this.monitor.y} : null;
        if (JSON.stringify(this.popup) === JSON.stringify(next)) return;
        this.popup = next;
        this.repaint();
    }
}
