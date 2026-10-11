import St from 'gi://St';
import {LiquidMaterial, liquidEnabled} from './liquidMaterial.js';
import {paintFrame, paintFrameShadow} from './drawing.js';
import {frameRegions} from './frame-regions.js';

export class DesktopFrame {
    constructor(monitor, theme, sides, state, settings = null) {
        this.liquidSettings = settings;
        this.glass = settings ? liquidEnabled(settings, 'glass-frame') : false;
        // Panel glass belongs to the bar plate; it must not replace an entire
        // frame tile (including the border beside an otherwise solid desktop).
        this.glassEdges = [];
        this.monitor = monitor;
        this.popup = null;
        this.notification = null;
        this.sides = sides;
        this.baseSides = {...sides};
        this.regionSides = {...sides};
        for (const bar of state.bars ?? []) {
            if (bar.autohide && bar.kind !== 'dock' && !bar.margin && (bar.length ?? 100) === 100)
                this.regionSides[bar.edge] = Math.max(this.regionSides[bar.edge], bar.thickness);
        }
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
        this.spareSurfaces = [];
        this.areas = [];
        this.repaint();
    }

    repaint() {
        if (this.destroyed) return;
        const {width, height} = this.monitor;
        // Both holes belong on the same opening; dropping one leaves a
        // transparent banner sitting on the wallpaper.
        const {popup, notification} = this;
        const regions = frameRegions(width, height, this.regionSides, this.padding, popup?.bounds ? {...popup, ...popup.bounds} : popup, notification);
        const cramped = width - this.sides.left - this.sides.right < this.state.radius * 2
            || height - this.sides.top - this.sides.bottom < this.state.radius * 2
            || width <= this.regionSides.left + this.regionSides.right + this.padding * 2
            || height <= this.regionSides.top + this.regionSides.bottom + this.padding * 2;
        const retained = new Map();
        const available = [...this.surfaces.values(), ...this.spareSurfaces];
        for (const {rect, dynamic, edges} of regions) {
            const glass = this.glass || (dynamic && (popup?.glass || notification?.glass)) || edges?.some(edge => this.glassEdges.includes(edge));
            const drawerOnly = glass && !this.glass && !this.glassEdges.includes(popup?.edge)
                && !edges?.some(edge => this.glassEdges.includes(edge));
            const key = JSON.stringify([rect, Boolean(glass), drawerOnly]);
            let area = this.surfaces.get(key);
            if (area && [...retained.values()].includes(area)) area = null;
            const kind = JSON.stringify([Boolean(glass), drawerOnly, Boolean(dynamic), edges ?? []]);
            if (!area) area = available.find(candidate => candidate._frameKind === kind && ![...retained.values()].includes(candidate));
            if (area) available.splice(available.indexOf(area), 1);
            if (!area) {
                if (glass) {
                    const material = new LiquidMaterial(this.monitor, this.liquidSettings, this.theme.bg);
                    area = material.actor;
                    area._liquidMaterial = material;
                    if (drawerOnly) {
                        const base = new St.DrawingArea({reactive: false});
                        base.set_position(rect[0], rect[1]); base.set_size(rect[2], rect[3]);
                        this.actor.add_child(base);
                        base.connect('repaint', () => {
                            const cr = base.get_context();
                            try {
                                cr.translate(-area.x, -area.y);
                                paintFrame(cr, width, height, this.sides, this.state.radius, this.theme.bg, 0);
                            } finally { cr.$dispose(); }
                        });
                        area._liquidBase = base;
                    }

                } else area = new St.DrawingArea({reactive: false});
                area.set_position(rect[0], rect[1]);
                area.set_size(rect[2], rect[3]);
                this.actor.add_child(area);
                if (glass) {
                    const shadow = new St.DrawingArea({reactive: false});
                    shadow.set_position(rect[0], rect[1]); shadow.set_size(rect[2], rect[3]);
                    this.actor.add_child(shadow);
                    shadow.connect('repaint', () => {
                        const cr = shadow.get_context();
                        try {
                            cr.translate(-area.x, -area.y);
                            const spread = this.spread ?? 1;
                            const sides = Object.fromEntries(Object.entries(this.sides).map(([edge, value]) => [edge, value * spread]));
                            paintFrameShadow(cr, width, height, sides, this.state.radius * spread,
                                this.state.shadow * spread, this.popup, this.notification);
                        } finally { cr.$dispose(); }
                    });
                    area._liquidShadow = shadow;
                    area.connect('destroy', () => { area._liquidBase?.destroy(); shadow.destroy(); });
                }

                if (!glass) area.connect('repaint', () => {
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
            area.visible = true;
            if (area._liquidBase) area._liquidBase.visible = true;
            if (area._liquidShadow) area._liquidShadow.visible = true;
            area._frameKind = kind;
            if (area.x !== rect[0] || area.y !== rect[1]) area.set_position(rect[0], rect[1]);
            if (area.width !== rect[2] || area.height !== rect[3]) area.set_size(rect[2], rect[3]);
            for (const companion of [area._liquidBase, area._liquidShadow]) {
                if (companion && (companion.x !== rect[0] || companion.y !== rect[1])) companion.set_position(rect[0], rect[1]);
                if (companion && (companion.width !== rect[2] || companion.height !== rect[3])) companion.set_size(rect[2], rect[3]);
            }
            area.opacity = Math.round((this.fade ?? 1) * 255);
            if (area._liquidBase) area._liquidBase.opacity = area.opacity;
            if (area._liquidShadow) area._liquidShadow.opacity = area.opacity;
            const content = JSON.stringify([rect, dynamic || cramped ? this.sides : edges.map(edge => this.sides[edge]),
                this.spread, dynamic ? popup : null, dynamic ? notification : null, cramped]);
            if (area._frameContent !== content) {
                area._frameContent = content;
                if (glass) {
                    const spread = this.spread ?? 1;
                    const sides = Object.fromEntries(Object.entries(this.sides).map(([edge, value]) => [edge, value * spread]));
                    area._liquidMaterial.frame(rect, width, height, sides, this.state.radius * spread, dynamic || cramped ? this.popup : null, dynamic || cramped ? this.notification : null, drawerOnly);
                } else area.queue_repaint();
                area._liquidBase?.queue_repaint();
                area._liquidShadow?.queue_repaint();
            }
            retained.set(key, area);
        }
        // Keep inactive tiles through the droplet phase and after closing.
        // Native blur effects retain their resources for the next reveal.
        this.spareSurfaces = available.slice(0, 32);
        for (const area of available) {
            area.visible = false;
            if (area._liquidBase) area._liquidBase.visible = false;
            if (area._liquidShadow) area._liquidShadow.visible = false;
            area._frameContent = null;
            if (!this.spareSurfaces.includes(area)) area.destroy();
        }
        this.surfaces = retained;
        this.areas = [...retained.values()];
    }

    setFade(alpha) {
        const next = Math.max(0, Math.min(1, Number.isFinite(alpha) ? alpha : 0));
        const opacity = Math.round(next * 255);
        this.fade = next;
        for (const area of this.areas) {
            area.opacity = opacity;
            if (area._liquidBase) area._liquidBase.opacity = opacity;
            if (area._liquidShadow) area._liquidShadow.opacity = opacity;
        }
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
            if (!area._liquidMaterial) area.queue_repaint();
        }
        if (this.areas.some(area => area._liquidMaterial)) this.repaint();
    }

    setReveal(id, edge, thickness, progress) {
        const previous = this.reveals.get(id);
        if (previous && previous.edge === edge && previous.thickness === thickness && previous.progress === progress)
            return;
        this.regionSides[edge] = Math.max(this.regionSides[edge], thickness);
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
        // Drawing callbacks sample the current join. A tile can be repainted
        // while borrowed for the banner without changing its resting cache key.
        // Invalidate both active and pooled tiles before restoring the perimeter.
        for (const area of [...this.surfaces.values(), ...this.spareSurfaces]) area._frameContent = null;
        this.repaint();
        this.onJoinChange?.();
    }

    setPopup(popup) {
        const next = popup ? {...popup, x: popup.x - this.monitor.x, y: popup.y - this.monitor.y,
            bounds: popup.bounds ? {...popup.bounds, x: popup.bounds.x - this.monitor.x, y: popup.bounds.y - this.monitor.y} : null} : null;
        if (JSON.stringify(this.popup) === JSON.stringify(next)) return;
        this.popup = next;
        this.repaint();
        this.onJoinChange?.();
    }
}
