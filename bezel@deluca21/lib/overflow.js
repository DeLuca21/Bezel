import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import Shell from 'gi://Shell';
import GObject from 'gi://GObject';
import St from 'gi://St';

const ScrollFade = GObject.registerClass(class BezelScrollFade extends Shell.GLSLEffect {
    vfunc_build_pipeline() {
        this.add_glsl_snippet(Cogl.SnippetHook.FRAGMENT, 'uniform vec3 fade_edges;',
            `float y = cogl_tex_coord_in[0].y * fade_edges.x;
             float a = fade_edges.y > 0.5 ? smoothstep(0.0, 28.0, y) : 1.0;
             if (fade_edges.z > 0.5) a *= smoothstep(0.0, 28.0, fade_edges.x - y);
             cogl_color_out *= a;`, false);
    }
    sync(height, top, bottom) {
        const values = [Math.max(1, height), top ? 1 : 0, bottom ? 1 : 0];
        if (this.values?.every((v, i) => v === values[i])) return;
        this.values = values;
        this.set_uniform_float(this.get_uniform_location('fade_edges'), 3, values);
        this.queue_repaint();
    }
});

// St's overlay scrollbars paint under opaque children and show on 1px overflow.
// Fade the content alpha into its backing and place an optional thumb above it.
export function decorateScroll(scroll, theme, showThumb = true, suppressOverflow = () => false, glass = false) {
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
    const thumb = new St.Widget({
        reactive: false, x_expand: true, y_expand: true, width: 3, height: 36,
        x_align: Clutter.ActorAlign.END, y_align: Clutter.ActorAlign.START,
        style: `background-color: ${theme.muted}; border-radius: 99px; margin-right: 5px;`,
    });
    const overlay = new St.Widget({
        reactive: false, x_expand: true, y_expand: true,
        layout_manager: new Clutter.BinLayout(),
    });
    thumb.visible = showThumb;
    overlay.add_child(thumb);
    overlay.visible = false;
    const content = new Clutter.Actor({layout_manager: new Clutter.BinLayout(), x_expand: true, y_expand: true});
    content.add_child(scroll);
    const contentFade = new ScrollFade();
    contentFade.sync(1, false, false);
    content.add_effect_with_name('bezel-scroll-fade', contentFade);
    stack.add_child(content);
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
        // A page transition temporarily keeps both pages in the scroll view.
        // Their combined extent is not user-scrollable overflow.
        const overflow = !suppressOverflow() && upper > page + 2;
        overlay.visible = overflow;
        if (content.mapped) contentFade.sync(content.height, overflow && value > 4, overflow && value < upper - page - 4);
        if (!overflow)
            return;
        const range = Math.max(1, upper - page);
        const track = Math.max(0, (overlay.height || scroll.height) - thumb.height - 20);
        const shift = 10 + (value / range) * track;
        if (Number.isFinite(shift))
            thumb.translation_y = shift;
    };
    for (const signal of ['notify::value', 'notify::upper', 'notify::page-size'])
        signals.connect_data(signal, sync, 0);
    signals.set_target(adj);
    content.connect('notify::mapped', sync);
    content.connect('notify::allocation', sync);
    scroll.connect('notify::allocation', sync);
    overlay.connect('notify::allocation', sync);
    sync();
    stack._bezelSyncOverflow = sync;
    return stack;
}
