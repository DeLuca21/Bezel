import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {allowsMotion} from './compat.js';
import {edgeClearance, fadeCoverage, monitorClip, shownAt, slideOut} from './layoutMotion.js';

// Bars keep their shape and slide off. The frame opening grows out to the
// screen edge until the border is gone. Fade uses the same coverage for both.
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
        for (const item of this._items) {
            const {actor} = item;
            try {
                if (!actor.get_stage?.())
                    continue;
                actor.opacity = item.opacity;
                actor.translation_x = item.tx;
                actor.translation_y = item.ty;
                actor.remove_clip();
                actor.clip_to_allocation = item.clipToAllocation ?? false;
                actor.show();
                if (item.kind === 'frame') {
                    item.frame.setSpread(1);
                    item.frame.setFade(1);
                }
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
            bar._revealTimeline?.stop();
            bar._revealTimeline = null;
            items.push({
                kind: 'bar', actor, edge: bar._state.edge, box: barBox(bar),
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
                kind: 'frame', actor, frame,
                opacity: actor.opacity, clipToAllocation: actor.clip_to_allocation,
                tx: actor.translation_x, ty: actor.translation_y,
            });
        }
        return items;
    }

    _paint(items, style, shown) {
        for (const item of items) {
            const {actor} = item;
            try {
                if (!actor.get_stage?.())
                    continue;
                actor.remove_clip();
                if (style !== 'retreat') {
                    const coverage = fadeCoverage(shown, item.kind === 'frame' ? 255 : item.opacity);
                    if (item.kind === 'frame')
                        item.frame.setFade(coverage.alpha);
                    else
                        actor.opacity = coverage.opacity;
                    continue;
                }
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
        const timeline = new Clutter.Timeline({duration, actor: items[0].actor});
        this._timeline = timeline;
        timeline.set_progress_mode(Clutter.AnimationMode.EASE_IN_OUT_CUBIC);
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
            rebuild();
            this._items = [];
            this._play(style, 0, 1, duration, () => this.cancel());
        });
    }
}
