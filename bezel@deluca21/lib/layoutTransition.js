import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {allowsMotion} from './compat.js';
import {edgeClearance, fadeCoverage, monitorClip, shownAt, slideOut} from './layoutMotion.js';

// Bars keep their shape and slide off. The frame opening grows out to the
// screen edge until the border is gone. Fade composites overlapping surfaces
// before applying opacity, so bar backgrounds cannot double up with the frame.
const LEGACY = new Set(['slide', 'wipe']);

function barBox(bar) {
    const actor = bar._actor;
    const box = bar._box;
    return {
        x: box?.x ?? actor?.x ?? 0,
        y: box?.y ?? actor?.y ?? 0,
        width: box?.width || actor?.width || bar._state.thickness || 0,
        height: box?.height || actor?.height || bar._state.thickness || 0,
    };
}

export class LayoutTransition {
    constructor(overlay) {
        this.overlay = overlay;
        this._items = [];
        this._timeline = null;
        this._fadeGroups = [];
        this._generation = 0;
    }

    cancel() {
        this._generation++;
        this._timeline?.stop();
        this._timeline = null;
        this._restore();
        this._items = [];
    }

    _restore() {
        this._clearFade();
        for (const item of this._items) {
            const {actor} = item;
            try {
                if (!actor.get_stage?.())
                    continue;
                actor.opacity = item.opacity;
                actor.translation_x = item.tx;
                actor.translation_y = item.ty;
                if (item.clip) actor.set_clip(...item.clip);
                else actor.remove_clip();
                actor.clip_to_allocation = item.clipToAllocation ?? false;
                actor.show();
                if (item.kind === 'frame') {
                    item.frame.setSpread(1);
                    item.frame.setFade(1);
                }
                if (item.resumeReveal) item.bar._slide(item.bar._shown, true);
            } catch {
                /* Actor already left the stage. */
            }
        }
    }

    _capture() {
        const items = [];
        for (const bar of this.overlay._bars) {
            const actor = bar._actor;
            if (!actor?.visible || !actor.get_stage?.() || global.display.get_monitor_in_fullscreen(bar._monitor.index))
                continue;
            const resumeReveal = Boolean(bar._revealTimeline);
            bar._revealTimeline?.stop();
            bar._revealTimeline = null;
            items.push({
                kind: 'bar', actor, bar, resumeReveal, clip: actor.has_clip?.() ? actor.get_clip() : null, edge: bar._state.edge, box: barBox(bar),
                monitor: bar._monitor,
                opacity: actor.opacity, clipToAllocation: actor.clip_to_allocation,
                tx: actor.translation_x, ty: actor.translation_y,
            });
        }
        for (const [index, frame] of this.overlay._frames) {
            const actor = frame.actor;
            if (!actor?.visible || global.display.get_monitor_in_fullscreen(index))
                continue;
            items.push({
                kind: 'frame', actor, frame, clip: actor.has_clip?.() ? actor.get_clip() : null, monitor: frame.monitor,
                opacity: actor.opacity, clipToAllocation: actor.clip_to_allocation,
                tx: actor.translation_x, ty: actor.translation_y,
            });
        }
        return items;
    }

    _clearFade() {
        for (const group of this._fadeGroups)
            group.destroy();
        this._fadeGroups = [];
    }

    _prepareFade(items) {
        // Keep chrome actors in their original parents: reparenting them changes
        // Shell's input/strut tracking. Hidden sources still paint in Clutter.Clone.
        const siblings = Main.uiGroup.get_children();
        const ordered = [...items].sort((a, b) => siblings.indexOf(a.actor) - siblings.indexOf(b.actor));
        const groups = new Map();
        for (const item of ordered) {
            const {actor, monitor} = item;
            let group = groups.get(monitor.index);
            if (!group) {
                group = new Clutter.Actor({x: monitor.x, y: monitor.y,
                    width: monitor.width, height: monitor.height, reactive: false,
                    clip_to_allocation: true});
                group.set_offscreen_redirect(Clutter.OffscreenRedirect.ALWAYS);
                Main.uiGroup.add_child(group);
                groups.set(monitor.index, group);
                this._fadeGroups.push(group);
            }
            const clone = new Clutter.Clone({source: actor,
                x: actor.x - monitor.x, y: actor.y - monitor.y,
                width: actor.width, height: actor.height,
                translation_x: item.tx, translation_y: item.ty,
                scale_x: actor.scale_x, scale_y: actor.scale_y,
                opacity: item.opacity, reactive: false});
            const [pivotX, pivotY] = actor.get_pivot_point();
            clone.set_pivot_point(pivotX, pivotY);
            // Newly rebuilt bars can settle their indicator/content size on
            // the next allocation. Keep the visual copy aligned as they do.
            const allocationId = actor.connect('notify::allocation', () => {
                clone.set_position(actor.x - monitor.x, actor.y - monitor.y);
                clone.set_size(actor.width, actor.height);
            });
            clone.connect('destroy', () => {
                if (clone.get_source()) actor.disconnect(allocationId);
            });
            group.add_child(clone);
            Main.uiGroup.set_child_above_sibling(group, actor);
            actor.hide();
        }
    }

    _paint(items, style, shown) {
        if (style === 'fade') {
            const {opacity} = fadeCoverage(shown);
            for (const group of this._fadeGroups)
                group.opacity = opacity;
            return;
        }
        for (const item of items) {
            const {actor} = item;
            try {
                if (!actor.get_stage?.())
                    continue;
                actor.remove_clip();
                actor.opacity = item.opacity;
                if (item.kind === 'frame') {
                    item.frame.setFade(1);
                    item.frame.setSpread(shown);
                    actor.clip_to_allocation = true;
                    continue;
                }
                const slide = slideOut(item.edge, edgeClearance(item.edge, item.box, item.monitor), shown);
                const translation = {x: item.tx + slide.x, y: item.ty + slide.y};
                actor.translation_x = translation.x;
                actor.translation_y = translation.y;
                const clip = monitorClip(item.box, item.monitor, translation);
                actor.set_clip(clip.x, clip.y, clip.width, clip.height);
                actor.show();
            } catch {
                /* Actor was destroyed mid-frame. */
            }
        }
    }

    _play(style, from, to, duration, done) {
        const generation = ++this._generation;
        this._timeline?.stop();
        this._timeline = null;
        const items = this._capture();
        this._items = items;
        if (style === 'fade') this._prepareFade(items);
        const finish = () => {
            if (generation !== this._generation)
                return;
            this._paint(items, style, to);
            try {
                done?.();
            } catch (error) {
                this.cancel();
                console.error('Bezel layout transition failed', error);
            }
        };
        this._paint(items, style, from);
        if (!items.length || !duration || from === to) {
            finish();
            return;
        }
        const timeline = new Clutter.Timeline({duration, actor: this._fadeGroups[0] ?? items[0].actor});
        this._timeline = timeline;
        // Opacity needs a wider, gentler middle than the positional retreat:
        // sine spreads the visible fade across more of the same duration.
        timeline.set_progress_mode(style === 'fade'
            ? Clutter.AnimationMode.EASE_IN_OUT_SINE
            : Clutter.AnimationMode.EASE_IN_OUT_CUBIC);
        timeline.connect('new-frame', () => {
            if (generation !== this._generation)
                return;
            this._paint(items, style, shownAt(from, to, timeline.get_progress()));
        });
        timeline.connect('completed', () => {
            if (this._timeline === timeline)
                this._timeline = null;
            finish();
        });
        timeline.start();
    }

    run(rebuild) {
        this.cancel();
        const settings = this.overlay._settings;
        let style = settings.get_string('layout-transition');
        if (LEGACY.has(style))
            style = 'fade';
        const duration = Math.round(settings.get_int('layout-transition-duration') / 2);
        if (style === 'none' || !duration || !allowsMotion(St.Settings.get(), St.ReducedMotion) || Main.overview.visible) {
            rebuild();
            return;
        }
        for (const bar of this.overlay._bars)
            bar._close(true);
        this._play(style, 1, 0, duration, () => {
            this._clearFade();
            rebuild();
            this._items = [];
            this._play(style, 0, 1, duration, () => this.cancel());
        });
    }
}
