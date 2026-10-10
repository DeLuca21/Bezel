import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {allowsMotion, chromeOptions} from './compat.js';
import * as Config from 'resource:///org/gnome/shell/misc/config.js';
import {LiquidMaterial, liquidEnabled} from './liquidMaterial.js';
import {liquidSample, unit, settle, shiftSample, frameShiftSample} from './liquidGeometry.js';
import {pour} from './liquidShapes.js';

function addLayer(material) {
    Main.layoutManager.addChrome(material.actor, chromeOptions(Config.PACKAGE_VERSION, false));
    material.actor.hide();
}
function removeLayer(material) {
    Main.layoutManager.removeChrome(material.actor);
    material.actor.destroy();
}
function hostBox(bar) {
    let actor = bar._anchor;
    while (actor && actor !== bar._actor) {
        if (actor._bezelPlate) break;
        actor = actor.get_parent();
    }
    actor ??= bar._actor;
    const [x, y] = actor.get_transformed_position();
    const [width, height] = actor.get_transformed_size();
    return {x, y, width, height};
}
function edgePoint(g) {
    return g.edge === 'top' ? [g.x + g.width / 2, g.y]
        : g.edge === 'bottom' ? [g.x + g.width / 2, g.y + g.height]
            : g.edge === 'left' ? [g.x, g.y + g.height / 2] : [g.x + g.width, g.y + g.height / 2];
}

export class LiquidDrawer {
    constructor(bar) {
        this.bar = bar;
        this.style = bar._overlay._settings.get_string('liquid-open-style');
        this.layer = new LiquidMaterial(bar._monitor, bar._overlay._settings, bar._theme.bg, bar._popupGlass || bar._liquidGlass);
        // Travelling liquid is part of the surface, not a raised card.
        this.layer.mask.set('shadow', [0]);
        this.layer.mask.set('highlight', [0]);
        addLayer(this.layer);
        bar._liquidLayer = this.layer.actor;
    }
    clipAtLip(g) {
        const a = this.layer.actor;
        const [sx, sy] = edgePoint(g);
        const x = g.edge === 'left' ? sx - a.x : 0;
        const y = g.edge === 'top' ? sy - a.y : 0;
        const right = g.edge === 'right' ? sx - a.x : a.width;
        const bottom = g.edge === 'bottom' ? sy - a.y : a.height;
        a.set_clip(x, y, Math.max(0, right - x), Math.max(0, bottom - y));
    }
    update(progress) {
        const bar = this.bar;
        const g = bar._popupGeometry;
        const motion = allowsMotion(St.Settings.get(), St.ReducedMotion) && bar._state.animationDuration > 0;
        if (motion && this.style === 'drip') return this.flowFromEdge(progress, g);
        if (motion && this.style === 'drop-expand') return this.centerDrop(progress, g);
        bar._popupBox.opacity = 255;
        const sample = motion ? liquidSample(this.style, progress) : {growth: unit(progress), drop: 0, reach: 0};
        const a = this.layer.actor;
        bar._popout.set_pivot_point(g.edge === 'right' ? 1 : g.edge === 'left' ? 0 : 0.5,
            g.edge === 'bottom' ? 1 : g.edge === 'top' ? 0 : 0.5);
        const bounce = Math.max(1, sample.growth);
        const breadth = this.style === 'grow' ? Math.max(0.04, Math.min(1, sample.growth)) : 1;
        bar._popout.set_scale(g.edge === 'left' || g.edge === 'right' ? bounce : breadth,
            g.edge === 'top' || g.edge === 'bottom' ? bounce : breadth);
        if (!(sample.drop > 0)) {
            a.hide();
            return sample.growth;
        }
        const [tx, ty] = edgePoint(g);
        // The seed is on the chrome's outside edge, not the clicked control.
        const vertical = g.edge === 'left' || g.edge === 'right';
        const [sx, sy] = edgePoint(g);
        const direction = g.edge === 'top' || g.edge === 'left' ? 1 : -1;
        const excursion = 48 * sample.reach;
        const dx = vertical ? sx + direction * excursion : sx;
        const dy = vertical ? sy : sy + direction * excursion;
        const x = Math.min(sx, dx) - 52, y = Math.min(sy, dy) - 52;
        const w = Math.abs(dx - sx) + 104, h = Math.abs(dy - sy) + 104;
        a.set_position(x, y); a.set_size(w, h);
        this.clipAtLip(g);
        this.layer.rectangle(w, h, 0);
        const m = this.layer.mask;
        // A broad root begins inside the host and narrows with the moving mass.
        // It has the same frost and disappears with the drop, never a resting neck.
        const root = 10 + 22 * sample.drop;
        m.set('rect', vertical
            ? [sx - x - (direction > 0 ? 10 : 0), sy - y - root, 10, root * 2]
            : [sx - x - root, sy - y - (direction > 0 ? 10 : 0), root * 2, 10]);
        const radius = 18 * sample.drop;
        m.set('drop', [dx - x, dy - y, vertical ? radius * 1.25 : radius, vertical ? radius : radius * 1.25]);
        m.set('stream', [sx - x, sy - y, dx - x, dy - y]);
        m.set('join', [0, 0, 0, Math.max(2, (16 - 6 * sample.reach) * sample.drop)]);
        a.show();
        return sample.growth;
    }
    // Atelier's overflow phases: swell at the lip, rise, let go, then spread.
    // Apply them along the drawer's normal for all four screen edges.
    flowFromEdge(progress, g) {
        const t = unit(progress), a = this.layer.actor, m = this.layer.mask;
        const [sx, sy] = edgePoint(g);
        const away = {top: [0, 1], bottom: [0, -1], left: [1, 0], right: [-1, 0]}[g.edge];
        const ease = u => 1 - (1 - unit(u)) ** 3;
        const swell = ease(t / 0.3), rise = ease((t - 0.2) / 0.3);
        const open = ease((t - 0.42) / 0.46);
        const r = 18 * swell;
        const cx = g.x + g.width / 2, cy = g.y + g.height / 2;
        const px = sx + away[0] * (r * 0.4 + 30 * rise);
        const py = sy + away[1] * (r * 0.4 + 30 * rise);
        const x = Math.min(g.x, sx) - 40, y = Math.min(g.y, sy) - 40;
        a.set_position(x, y);
        a.set_size(Math.max(g.x + g.width, sx) - x + 40, Math.max(g.y + g.height, sy) - y + 40);
        this.clipAtLip(g);
        this.layer.rectangle(a.width, a.height, 0);
        const bx = px + (cx - px) * open, by = py + (cy - py) * open;
        const hw = r + (g.width / 2 - r) * open ** 0.9;
        const hh = r + (g.height / 2 - r) * open;
        m.set('shapes', [1]);
        m.set('boxes[0]', [bx - x, by - y, hw, hh, 0, 0, 0, 0, 0, 0, 0, 0]);
        m.set('corners', [Math.min(r + ((this.bar._popupPaintRadius ?? 18) - r) * open, hw, hh), 0, 0]);
        m.set('stream', [sx - x, sy - y, px - x, py - y]);
        m.set('join', [0, 0, 0, r * 0.55 * (1 - unit((t - 0.38) / 0.22))]);
        this.bar._popupBox.opacity = t >= 0.88 ? 255 : 0;
        const bounce = t >= 0.88 ? 1 + 0.055 * Math.sin(Math.PI * unit((t - 0.88) / 0.12)) : 1;
        this.bar._popout.set_pivot_point(g.edge === 'right' ? 1 : g.edge === 'left' ? 0 : 0.5, g.edge === 'bottom' ? 1 : g.edge === 'top' ? 0 : 0.5);
        this.bar._popout.set_scale(g.edge === 'left' || g.edge === 'right' ? bounce : 1, g.edge === 'top' || g.edge === 'bottom' ? bounce : 1);
        if (t > 0 && t < 0.88) a.show(); else a.hide();
        return t >= 0.88 ? bounce : 0;
    }
    centerDrop(progress, g) {
        const t = unit(progress), a = this.layer.actor, m = this.layer.mask;
        const vertical = g.edge === 'left' || g.edge === 'right';
        const cx = g.x + g.width / 2, cy = g.y + g.height / 2;
        const [sx, sy] = edgePoint(g);
        const travel = Math.min(1, t / 0.4);
        const ease = travel * travel * (3 - 2 * travel);
        const expand = unit((t - 0.4) / 0.4);
        const e = expand * expand * (3 - 2 * expand);
        const x = Math.min(g.x, sx) - 40, y = Math.min(g.y, sy) - 40;
        a.set_position(x, y);
        a.set_size(Math.max(g.x + g.width, sx) - x + 40, Math.max(g.y + g.height, sy) - y + 40);
        this.clipAtLip(g);
        this.layer.rectangle(a.width, a.height, 0);
        const px = sx + (cx - sx) * ease, py = sy + (cy - sy) * ease;
        const width = 36 + (g.width - 36) * e, height = 36 + (g.height - 36) * e;
        m.set('rect', [px - x - width / 2, py - y - height / 2, width, height]);
        m.set('radius', [18 + (this.bar._popupPaintRadius - 18) * e]);
        m.set('drop', [0, 0, 0, 0]);
        m.set('stream', [sx - x, sy - y, px - x, py - y]);
        m.set('join', [0, 0, 0, t < 0.4 ? 12 * Math.sin(Math.PI * travel) : 0]);
        const bounce = 1 + 0.055 * Math.sin(Math.PI * unit((t - 0.8) / 0.2));
        this.bar._popupBox.opacity = t >= 0.8 ? 255 : 0;
        this.bar._popout.set_pivot_point(g.edge === 'right' ? 1 : g.edge === 'left' ? 0 : 0.5,
            g.edge === 'bottom' ? 1 : g.edge === 'top' ? 0 : 0.5);
        this.bar._popout.set_scale(vertical ? bounce : 1, vertical ? 1 : bounce);
        if (t > 0 && t < 0.8) a.show(); else a.hide();
        return t >= 0.8 ? bounce : 0;
    }
    destroy() {
        removeLayer(this.layer);
        this.bar._liquidLayer = null;
    }
}

// Drain the old real card before opening the new one. A travelling stream
// carries its material between chrome edges, so Pour is distinct from Grow.
export function pourToDrawer(bar, id, anchor, build, edge, hover) {
    const settings = bar._overlay._settings;
    const shift = liquidEnabled(settings, 'shift');
    if (!(shift || liquidEnabled(settings, 'pour')) || !allowsMotion(St.Settings.get(), St.ReducedMotion)
        || !bar._state.animationDuration || bar._overlay._liquidPour) return false;
    const old = bar._overlay._bars.find(item => item._popout && item._popupProgress > 0);
    if (!old || old._popoutId === id || !old._popupGeometry) return false;
    const oldGeometry = {...old._popupGeometry};
    const sourceFrame = old._popupFrame;
    let shiftContent = null;
    if (shift && !sourceFrame) {
        try { shiftContent = old._popupBox.paint_to_content(null); } catch { /* An unpainted card has no snapshot yet. */ }
    }
    const color = old._theme.bg;
    const glass = old._popupGlass || old._liquidGlass;
    // Build and measure the destination first, so Atelier's stream fills the
    // actual destination card during the same transition.
    old._close();
    bar._liquidPourOpening = true;
    try { bar._open(id, anchor, build, edge, hover); }
    finally { bar._liquidPourOpening = false; }
    if (!bar._popupGeometry) return true;
    bar._popupTimeline?.stop(); bar._popupTimeline = null;
    const target = {...bar._popupGeometry};
    const attachedFrame = shift && sourceFrame && sourceFrame === bar._popupFrame ? sourceFrame : null;
    bar._clipPopup(0);
    const from = [oldGeometry.x, oldGeometry.y, oldGeometry.width, oldGeometry.height];
    const to = [target.x, target.y, target.width, target.height];
    const x = Math.min(from[0], to[0]) - 64, y = Math.min(from[1], to[1]) - 64;
    const w = Math.max(from[0] + from[2], to[0] + to[2]) - x + 64;
    const h = Math.max(from[1] + from[3], to[1] + to[3]) - y + 64;
    const material = attachedFrame ? null : new LiquidMaterial(bar._monitor, settings, color, glass);
    const actor = material?.actor ?? attachedFrame.actor;
    if (material) {
        actor.set_position(x, y); actor.set_size(w, h);
        addLayer(material);
        material.rectangle(w, h, 0);
        material.mask.set('shapes', [1]);
        actor.show();
    }
    const movingContent = shiftContent ? new Clutter.Actor({content: shiftContent, reactive: false}) : null;
    if (movingContent) actor.add_child(movingContent);
    const duration = Math.max(1, Math.round(bar._state.animationDuration * settings.get_int('liquid-duration-scale') / 100));
    const timeline = new Clutter.Timeline({duration, actor});
    const overlay = bar._overlay;
    let done = false;
    const finish = open => {
        if (done) return;
        done = true;
        timeline.stop();
        if (material) removeLayer(material);
        overlay._liquidPour = null;
        if (!bar._destroyed) {
            if (open) { bar._popupTarget = 1; bar._popupProgress = 1; bar._outsideSince = 0; bar._clipPopup(1); }
            else bar._close();
        }
    };
    const paint = t => {
        if (bar._destroyed) { finish(false); return; }
        let shape;
        if (attachedFrame) {
            const sides = attachedFrame.sides, monitor = attachedFrame.monitor;
            const geometry = frameShiftSample(oldGeometry, target, t, {
                x: monitor.x + sides.left, y: monitor.y + sides.top,
                width: monitor.width - sides.left - sides.right,
                height: monitor.height - sides.top - sides.bottom,
            });
            attachedFrame.setPopup({...geometry, progress: 1, glass});
            return;
        }
        if (shift) {
            const sample = shiftSample(from, to, t, bar._popupPaintRadius ?? 18);
            const [sx, sy, sw, sh] = sample.rect;
            if (movingContent) {
                movingContent.set_position(sx - x, sy - y);
                movingContent.set_size(sw, sh);
                movingContent.opacity = Math.round(255 * (1 - unit((t - 0.55) / 0.4)));
            }
            shape = {boxes: [[sx + sw / 2, sy + sh / 2, sw / 2, sh / 2, sample.radius]], capsules: []};
        } else shape = pour(from, to, t, {radius: bar._popupPaintRadius ?? 18, blend: 24});
        const boxes = Array(12).fill(0), corners = [0, 0, 0];
        shape.boxes.forEach((box, i) => {
            boxes.splice(i * 4, 4, box[0] - x, box[1] - y, box[2], box[3]);
            corners[i] = box[4];
        });
        material.mask.set('boxes[0]', boxes);
        material.mask.set('corners', corners);
        const stream = shape.capsules[0];
        material.mask.set('join', [0, 0, 0, stream?.[4] ?? 0]);
        if (stream) material.mask.set('stream', [stream[0] - x, stream[1] - y, stream[2] - x, stream[3] - y]);
    };
    overlay._liquidPour = {actor, frame: attachedFrame, source: old, destination: bar, timeline, paint, finish: () => finish(true), cancel: () => finish(false)};
    timeline.connect('new-frame', () => paint(timeline.get_progress()));
    timeline.connect('completed', () => finish(true));
    paint(0);
    timeline.start();
    return true;
}
