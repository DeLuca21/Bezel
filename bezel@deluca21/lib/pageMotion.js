import Clutter from 'gi://Clutter';
import St from 'gi://St';
import {allowsMotion} from './compat.js';

export function preparePage(actor) {
    if (!actor.get_stage()) return;
    actor._prepareDevicePanel?.();
    for (const child of actor.get_children()) preparePage(child);
}

export function motionDuration(bar) {
    return bar?._popupProgress === 1 && allowsMotion(St.Settings.get(), St.ReducedMotion)
        ? bar._state.animationDuration : 0;
}

// Pages retain their own allocation; only the surrounding frame changes size.
export function pageMotion(stage, bar, controllers) {
    let timeline = null;
    let disposed = false;
    const dispose = page => { page?._releasePage?.(); page?.destroy(); };
    const controller = {
        get moving() { return timeline !== null; },
        stop() { timeline?.stop(); timeline = null; },
        show(view, direction, duration = motionDuration(bar)) {
            controller.stop();
            while (stage.get_n_children() > 1) dispose(stage.get_first_child());
            const previous = stage.get_first_child();
            stage.add_child(view);
            view.x_expand = false;
            view.y_expand = true;
            view.y_align = Clutter.ActorAlign.START;
            view.x_align = Clutter.ActorAlign.CENTER;
            if (!stage.get_stage()) { dispose(previous); return; }
            preparePage(view);
            // Turn the existing allocation into an explicit height request.
            if (previous) previous.height = previous.height;
            view.height = Math.ceil(view.get_preferred_height(view.width)[1]);
            // Exclude the outgoing page from the single target measurement.
            previous?.hide();
            stage.height = view.height;
            for (let parent = stage.get_parent(); parent; parent = parent.get_parent()) {
                parent._refreshPageHeight?.();
                if (parent === bar?._popupContent) break;
            }
            if (bar) bar._popupLockedHeight = false;
            const height = bar?._fitPopup(true);
            previous?.show();
            if (Number.isFinite(height)) bar._setDashboardSize(bar._popupWidth, height, duration);
            if (!previous || !duration) { dispose(previous); return; }
            const distance = (previous.width + view.width) / 2 + 48;
            const from = previous.translation_x;
            const incoming = from + direction * distance;
            view.translation_x = incoming;
            timeline = new Clutter.Timeline({duration, actor: stage});
            timeline.set_progress_mode(Clutter.AnimationMode.EASE_OUT_CUBIC);
            timeline.connect('new-frame', () => {
                const p = timeline.get_progress();
                previous.translation_x = from + (-direction * distance - from) * p;
                view.translation_x = incoming * (1 - p);
            });
            timeline.connect('completed', () => {
                timeline = null;
                view.translation_x = 0;
                dispose(previous);
            });
            timeline.start();
        },
        destroy() {
            if (disposed) return;
            disposed = true;
            controller.stop();
            for (const page of stage.get_children()) page._releasePage?.();
            controllers?.delete(controller);
        },
    };
    controllers?.add(controller);
    stage.connect('destroy', () => controller.destroy());
    return controller;
}
