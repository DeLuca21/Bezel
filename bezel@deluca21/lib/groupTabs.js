import Clutter from 'gi://Clutter';
import St from 'gi://St';
import {motionDuration, pageMotion, preparePage} from './pageMotion.js';

export function groupTabs(bar, entries, build, initial = 0, selected = () => {}) {
    const theme = bar._theme;
    const width = Math.max(160, bar._popupWidth - 36);
    const root = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style: 'spacing: 10px;',
        y_align: Clutter.ActorAlign.START, x_expand: true});
    const strip = new St.BoxLayout({style: `spacing: 8px; border-bottom: 1px solid ${theme.border}; padding-bottom: 10px;`});
    const scroll = new St.ScrollView({width, hscrollbar_policy: St.PolicyType.AUTOMATIC, vscrollbar_policy: St.PolicyType.NEVER});
    scroll.set_child(strip);
    const layer = new St.Widget({layout_manager: new Clutter.BinLayout(), clip_to_allocation: true});
    const overlay = new St.Widget({width: 0, height: 0, x_align: Clutter.ActorAlign.START, y_align: Clutter.ActorAlign.START});
    const highlight = new St.Widget({name: 'bezel-group-tab-highlight', x_align: Clutter.ActorAlign.START, y_align: Clutter.ActorAlign.START, width: 1, height: 1, opacity: 0,
        style: `background-color: ${theme.surface}; border-radius: 12px;`});
    overlay.add_child(highlight); layer.add_child(overlay); layer.add_child(scroll); root.add_child(layer);
    const stage = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true, y_align: Clutter.ActorAlign.START});
    root.add_child(stage);
    bar._groupTabControllers ??= new Set();
    const motion = pageMotion(stage, bar, bar._groupTabControllers);
    let current = -1, highlightTimeline = null, closed = false;
    const buttons = entries.map((entry, index) => {
        // Share spare row space while retaining each label's natural width.
        const button = new St.Button({label: entry.title, can_focus: true, x_expand: true});
        button.connect('clicked', () => select(index)); strip.add_child(button); return button;
    });
    const syncHighlight = () => {
        if (closed || highlightTimeline || current < 0 || !buttons[current].get_stage()) return;
        const b = buttons[current];
        const [x, y] = b.get_transformed_position(), [ox, oy] = overlay.get_transformed_position();
        if (![x, y, ox, oy, b.width, b.height].every(Number.isFinite) || b.width <= 0) return;
        highlight.set_position(x - ox, y - oy); highlight.set_size(b.width, b.height); highlight.opacity = 255;
    };
    const moveHighlight = duration => {
        highlightTimeline?.stop(); highlightTimeline = null;
        if (!duration || !highlight.opacity) { syncHighlight(); return; }
        const from = [highlight.x, highlight.y, highlight.width, highlight.height];
        const b = buttons[current];
        const [x, y] = b.get_transformed_position(), [ox, oy] = overlay.get_transformed_position();
        const to = [x - ox, y - oy, b.width, b.height];
        if (!to.every(Number.isFinite)) return;
        const t = new Clutter.Timeline({duration, actor: layer}); highlightTimeline = t;
        t.set_progress_mode(Clutter.AnimationMode.EASE_OUT_CUBIC);
        t.connect('new-frame', () => {
            const v = to.map((value, i) => from[i] + (value - from[i]) * t.get_progress());
            highlight.set_position(v[0], v[1]); highlight.set_size(v[2], v[3]);
        });
        t.connect('completed', () => { highlightTimeline = null; syncHighlight(); }); t.start();
    };
    const select = index => {
        if (closed || index === current || !entries[index]) return;
        // Return native lists before constructing the incoming page (which may
        // borrow the same list). Keep the outgoing fixed allocation for the slide.
        for (const page of stage.get_children()) page._releasePage?.();
        const page = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, width,
            style: 'spacing: 10px;', clip_to_allocation: true});
        const cleanups = [];
        page._groupCleanups = cleanups;
        page._refreshPageHeight = () => {
            page.height = -1;
            page.height = Math.ceil(page.get_preferred_height(width)[1]);
            stage.height = page.height;
        };
        page._releasePage = () => cleanups.splice(0).forEach(fn => fn());
        build(entries[index], page, cleanups);
        const direction = index >= current ? 1 : -1;
        current = index;
        buttons.forEach((b, i) => b.style = `padding: 12px 18px; border-radius: 12px; color: ${i === index ? theme.accent : theme.muted};`);
        motion.show(page, direction);
        selected(index);
        moveHighlight(motionDuration(bar));
    };
    root._selectGroupTab = select;
    root._preparePopup = () => {
        const page = stage.get_last_child();
        if (page?.get_stage()) { preparePage(page); page.height = Math.ceil(page.get_preferred_height(width)[1]); stage.height = page.height; }
        syncHighlight();
    };
    const stop = () => { motion.stop(); highlightTimeline?.stop(); highlightTimeline = null; };
    motion.stopTabs = () => {
        stop();
        for (const page of stage.get_children()) page._releasePage?.();
    };
    const dispose = () => { if (closed) return; closed = true; stop(); motion.destroy(); };
    bar._popupCleanups.push(dispose);
    root.connect('destroy', dispose);
    strip.connect('notify::allocation', syncHighlight);
    scroll.hadjustment.connectObject('notify::value', syncHighlight, root);
    select(initial);
    return root;
}
