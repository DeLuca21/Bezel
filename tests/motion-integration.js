// Run inside a disposable GNOME Shell using GSETTINGS_BACKEND=memory.
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {saveBars} from '../bezel@deluca21/lib/config.js';
import {LOGIN_THEMES} from '../bezel@deluca21/lib/loginMotion.js';

const assert = (value, message) => { if (!value) throw new Error(message); };
const settle = (delay = 40) => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
    resolve(); return GLib.SOURCE_REMOVE;
}));
const snapshot = actor => [actor.opacity, actor.scale_x, actor.scale_y, actor.translation_x, actor.translation_y, ...actor.get_pivot_point()];
const same = (a, b) => a.every((value, i) => Math.abs(value - b[i]) < 1e-5);
const descendants = actor => [actor, ...actor.get_children().flatMap(descendants)];
const edges = ['left', 'top', 'right', 'bottom'];
const modules = [{id: 'logo', place: 'start', group: ''}, {id: 'apps', place: 'start', group: ''},
    {id: 'clock', place: 'center', group: ''}, {id: 'power', place: 'end', group: ''}];

export async function run(overlay, capture = null) {
    if (GLib.getenv('GSETTINGS_BACKEND') !== 'memory')
        throw new Error('Motion integration requires an isolated Shell with GSETTINGS_BACKEND=memory');
    const settings = overlay._settings;
    const keys = ['config', 'show-frame', 'login-animation-theme', 'hide-gnome-panel', 'power-position', 'animation-duration', 'slider-style'];
    const saved = new Map(keys.map(key => [key, settings.get_value(key)]));
    let logins = 0, drawers = 0, autohides = 0, wifi = 0;
    try {
        Main.overview.hide();
        // Every edge subset, paired with alternating full, floating and dock bars.
        for (const border of [false, true]) {
            settings.set_boolean('show-frame', border);
            settings.set_boolean('hide-gnome-panel', border);
            for (let mask = 1; mask < 16; mask++) {
                saveBars(settings, edges.filter((_edge, i) => mask & (1 << i)).map((edge, i) => ({edge,
                    kind: i % 3 === 2 ? 'dock' : 'panel', margin: i % 3 === 1 ? 12 : 0,
                    length: i % 3 === 1 ? 70 : 100, thickness: 48, modules})));
                await settle(120);
                // Force pending debounced layout work to finish before taking snapshots.
                if (overlay._rebuildId) {
                    GLib.source_remove(overlay._rebuildId); overlay._rebuildId = 0; overlay.rebuild();
                }
                await settle();
                for (const [theme] of LOGIN_THEMES) {
                    settings.set_string('login-animation-theme', theme);
                    const actors = overlay._bars.flatMap(bar => descendants(bar._actor));
                    const originals = new Map(actors.map(actor => [actor, snapshot(actor)]));
                    overlay.previewLoginAnimation();
                    const animation = overlay._loginAnimation;
                    assert(animation?._timeline, `${theme}/${mask}: preview started`);
                    animation._timeline.stop();
                    for (const progress of [.3, .6, 1]) {
                        animation._paint(progress);
                        await settle(20);
                        for (const actor of actors) assert(snapshot(actor).every(Number.isFinite), `${theme}/${mask}: finite transforms`);
                        if (capture && mask === 15 && border && progress === .6) await capture(theme);
                    }
                    animation.destroy();
                    for (const actor of actors) assert(same(snapshot(actor), originals.get(actor)), `${theme}/${mask}: restore ${actor}`);
                    assert(!animation._surfaces.length && !animation._timeline && !animation._watchdog, `${theme}/${mask}: cleanup`);
                    logins++;
                }
            }
        }
        console.log(`BEZEL_LOGIN_INTEGRATION_PASS ${logins}`);
        // Reproduce a separate Wi-Fi button beside an edge-style volume control.
        // Its first drawer must use its own button and monitor on every edge.
        for (const edge of edges) {
            for (const border of [false, true]) {
                for (const style of ['drawer', 'edge', 'module-edge']) {
                    settings.set_boolean('show-frame', border);
                    settings.set_string('slider-style', style === 'edge' ? 'edge' : 'drawer');
                    saveBars(settings, [{edge, modules: [
                        {id: 'volume', place: 'start', group: '', ...(style === 'module-edge' ? {sliderStyle: 'edge'} : {})},
                        {id: 'network', place: 'end', group: ''},
                    ]}]);
                    await settle(150);
                    for (const bar of overlay._bars) {
                        const button = bar._order.find(item => item.id === 'network').actor;
                        button.emit('clicked', 1);
                        await settle(40);
                        assert(bar._popoutId === 'status' && bar._popupEdge === edge && bar._anchor === button,
                            `${edge}/${style}: Wi-Fi keeps its sidebar anchor`);
                        const g = bar._popupGeometry, m = bar._monitor;
                        assert(g && g.width > 100 && g.x >= m.x && g.y >= m.y
                            && g.x + g.width <= m.x + m.width + 1 && g.y + g.height <= m.y + m.height + 1,
                            `${edge}/${style}: Wi-Fi drawer fits its monitor`);
                        bar._close(); wifi++;
                    }
                }
            }
        }
        // Real layout and clipping at every supported power drawer location.
        for (const edge of edges) {
            for (const border of [false, true]) {
                settings.set_boolean('show-frame', border);
                saveBars(settings, [{edge, kind: 'panel', modules, autohide: true}]);
                await settle(150);
                const bar = overlay._bars[0];
                for (const show of [true, false, true]) {
                    bar._slide(show, true); await settle(50);
                }
                bar._slide(true, false);
                assert(bar._actor.opacity === 255 && !bar._revealTimeline, `${edge}/${border}: autohide reversal`);
                autohides++;
                for (const location of ['icon', 'top-left', 'top-center', 'top-right', 'bottom-left', 'bottom-center', 'bottom-right', 'left-center', 'right-center']) {
                    settings.set_string('power-position', location);
                    // This setting rebuilds; let it settle before using the new bar.
                    await settle(150);
                    const live = overlay._bars[0];
                    live._open('power', live._actor, () => { const box = new St.BoxLayout(); box.add_child(new St.Label({text: 'Motion regression'})); return box; });
                    await settle(30);
                    live._animatePopup(0); await settle(30); live._animatePopup(1);
                    await settle(400);
                    assert(live._popupProgress === 1 && !live._popupTimeline, `${edge}/${location}: drawer reversal settles`);
                    const g = live._popupGeometry, m = live._monitor;
                    assert(g && g.x >= m.x && g.y >= m.y && g.x + g.width <= m.x + m.width + 1
                        && g.y + g.height <= m.y + m.height + 1, `${edge}/${location}: drawer stays on monitor`);
                    live._close();
                    drawers++;
                }
            }
        }
        return {logins, drawers, autohides, wifi, monitors: Main.layoutManager.monitors.length};
    } finally {
        overlay._loginAnimation?.destroy();
        for (const bar of overlay._bars) bar._close();
        for (const [key, value] of saved) settings.set_value(key, value);
        await settle(200);
    }
}
