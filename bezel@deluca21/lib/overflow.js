import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

// St's overlay scrollbars paint under opaque children and show on 1px overflow.
// Hide them and put a fade + thumb on top so you can still tell the list moves.
export function decorateScroll(scroll, theme, showThumb = true) {
    scroll.add_style_class_name('bezel-popout-scroll');
    scroll.overlay_scrollbars = true;
    scroll.hscrollbar_policy = St.PolicyType.NEVER;
    scroll.vscrollbar_policy = St.PolicyType.NEVER;
    scroll.set_mouse_scrolling(true);
    const stack = new St.Widget({
        layout_manager: new Clutter.BinLayout(),
        x_expand: true,
        y_expand: true,
    });
    const fade = (end) => new St.Widget({
        reactive: false, x_expand: true, height: 28,
        y_align: end ? Clutter.ActorAlign.END : Clutter.ActorAlign.START,
        style: `background-gradient-direction: vertical; background-gradient-start: ${end ? 'rgba(0,0,0,0)' : theme.bg}; background-gradient-end: ${end ? theme.bg : 'rgba(0,0,0,0)'};`,
    });
    const fadeTop = fade(false);
    const fadeBottom = fade(true);
    const thumb = new St.Widget({
        reactive: false, width: 3, height: 36,
        x_align: Clutter.ActorAlign.END, y_align: Clutter.ActorAlign.START,
        style: `background-color: ${theme.muted}; border-radius: 99px; margin-right: 5px;`,
    });
    const overlay = new St.Widget({
        reactive: false, x_expand: true, y_expand: true,
        layout_manager: new Clutter.BinLayout(),
    });
    overlay.add_child(fadeTop);
    overlay.add_child(fadeBottom);
    thumb.visible = showThumb;
    overlay.add_child(thumb);
    overlay.visible = false;
    stack.add_child(scroll);
    stack.add_child(overlay);
    const adj = scroll.vadjustment;
    let dead = false;
    // ScrollView can dispose its adjustment before emitting destroy. A native
    // signal group handles either destruction order without touching that object.
    const signals = GObject.SignalGroup.new(St.Adjustment);
    scroll.connect('destroy', () => {
        dead = true;
        signals.set_target(null);
    });
    const sync = () => {
        if (dead)
            return;
        const upper = adj.upper;
        const page = adj.page_size;
        const value = adj.value;
        if (!Number.isFinite(upper) || !Number.isFinite(page) || !Number.isFinite(value))
            return;
        const overflow = upper > page + 2;
        overlay.visible = overflow;
        if (!overflow)
            return;
        const range = Math.max(1, upper - page);
        fadeTop.opacity = value > 4 ? 255 : 0;
        fadeBottom.opacity = value < range - 4 ? 255 : 0;
        const track = Math.max(0, (overlay.height || scroll.height) - thumb.height - 20);
        const shift = 10 + (value / range) * track;
        if (Number.isFinite(shift))
            thumb.translation_y = shift;
    };
    for (const signal of ['notify::value', 'notify::upper', 'notify::page-size'])
        signals.connect_data(signal, sync, 0);
    signals.set_target(adj);
    scroll.connect('notify::allocation', sync);
    overlay.connect('notify::allocation', sync);
    sync();
    stack._bezelSyncOverflow = sync;
    return stack;
}
