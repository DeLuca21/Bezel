// Real BinLayout allocations catch scroll decorations drifting into the content.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {decorateScroll} from '../bezel@deluca21/lib/overflow.js';

const settle = () => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
    resolve(); return GLib.SOURCE_REMOVE;
}));
const near = (actual, expected, message) => {
    if (Math.abs(actual - expected) > 1)
        throw new Error(`${message}: expected ${expected}, got ${actual}`);
};

export async function run(_overlay, capture = null) {
    if (GLib.getenv('GSETTINGS_BACKEND') !== 'memory')
        throw new Error('Overflow integration requires an isolated Shell with memory settings');
    Main.overview.hide();
    let cases = 0;
    for (const showThumb of [true, false]) {
        const scroll = new St.ScrollView({x_expand: true, y_expand: true});
        const content = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL});
        for (let i = 0; i < 20; i++)
            content.add_child(new St.Label({text: `Result ${i + 1}`, height: 48}));
        scroll.set_child(content);
        const stack = decorateScroll(scroll, {bg: '#344b70', muted: '#eeeeee'}, showThumb);
        stack.style = 'background-color: #344b70; color: white;';
        Main.uiGroup.add_child(stack);
        stack.set_position(100, 100);
        try {
            for (const [width, height] of [[520, 300], [360, 460], [640, 240]]) {
                stack.set_size(width, height);
                await settle();
                const overlay = stack.get_children()[1];
                const [top, bottom, thumb] = overlay.get_children();
                for (const fraction of [0, 0.5, 1]) {
                    const adj = scroll.vadjustment;
                    adj.value = fraction * (adj.upper - adj.page_size);
                    await settle();
                    if (capture && showThumb && width === 520 && fraction === 0)
                        await capture('overflow-layout');
                    near(overlay.width, width, 'overlay fills viewport width');
                    near(overlay.height, height, 'overlay fills viewport height');
                    near(top.y, 0, 'top fade stays at top');
                    near(bottom.y + bottom.height, height, 'bottom fade stays at bottom');
                    near(top.width, width, 'top fade spans viewport');
                    near(bottom.width, width, 'bottom fade spans viewport');
                    if (top.opacity !== (fraction > 0 ? 255 : 0) || bottom.opacity !== (fraction < 1 ? 255 : 0))
                        throw new Error('Fades must indicate only available scroll directions');
                    if (thumb.visible !== showThumb)
                        throw new Error('Thumb visibility preference lost');
                    if (showThumb) {
                        near(thumb.x + thumb.width, width - 5, 'thumb stays inset from right edge');
                        near(thumb.y, 0, 'thumb track starts at top');
                        near(thumb.translation_y, 10 + fraction * (height - thumb.height - 20), 'thumb follows scroll position');
                    }
                    cases++;
                }
            }
            stack.set_height(1200);
            await settle();
            if (stack.get_children()[1].visible)
                throw new Error('Decorations remain visible when content fits');
        } finally {
            stack.destroy();
        }
    }
    return cases;
}
