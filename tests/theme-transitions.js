import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {PRESETS} from '../bezel@deluca21/lib/theme.js';
import {applyPreset, PRESET_IDS, presetBars, saveBars} from '../bezel@deluca21/lib/config.js';

const settle = (delay = 500) => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
    resolve(); return GLib.SOURCE_REMOVE;
}));
const assert = (condition, message) => { if (!condition) throw new Error(message); };

export async function run(overlay, capture = null) {
    if (GLib.getenv('GSETTINGS_BACKEND') !== 'memory')
        throw new Error('Theme integration requires isolated memory settings');
    const settings = overlay._settings;
    const saved = new Map(settings.settings_schema.list_keys().map(key => [key, settings.get_value(key)]));
    let cases = 0;
    let layouts = 0;
    const check = id => {
        const theme = PRESETS.find(item => item.id === id);
        assert(overlay._bars.length && overlay._frames.size, 'Theme must reach real bars and frames');
        for (const bar of overlay._bars) {
            assert(bar._theme.bg === theme.bg && bar._theme.accent === theme.accent, `${id}: stale bar palette`);
            assert(bar._actor.visible && bar._actor.opacity === 255, `${id}: bar did not return after transition`);
        }
        for (const frame of overlay._frames.values()) {
            assert(frame.theme.bg === theme.bg, `${id}: stale frame palette`);
            assert(frame.fade === 1 && frame.spread === 1, `${id}: frame did not return after transition`);
        }
        assert(!overlay._layoutTransition._timeline && !overlay._layoutTransition._fadeGroups.length,
            `${id}: transition resources still active`);
        cases++;
    };
    try {
        Main.overview.hide();
        settings.set_boolean('show-frame', true);
        settings.set_int('layout-transition-duration', 200);
        saveBars(settings, [{edge: 'left', modules: [{id: 'clock', place: 'center', group: ''}]}]);
        await settle();
        for (const style of ['none', 'retreat', 'fade']) {
            settings.set_string('layout-transition', style);
            for (const id of ['bezel-sage', 'catppuccin-mocha']) {
                settings.set_string('theme', id);
                await settle();
                check(id);
                if (capture && style === 'retreat') await capture(`theme-${id}`);
            }
            settings.set_string('theme', 'bezel-sage');
            await settle(80);
            settings.set_string('theme', 'bezel-ocean');
            await settle();
            check('bezel-ocean');
        }
        for (const style of ['none', 'retreat', 'fade']) {
            settings.set_string('layout-transition', style);
            for (const id of PRESET_IDS) {
                applyPreset(settings, id);
                await settle(650);
                const expected = presetBars(id).map(bar => `${bar.edge}:${bar.kind ?? 'panel'}`).sort();
                for (const monitor of Main.layoutManager.monitors) {
                    const bars = overlay._bars.filter(bar => bar._monitor.index === monitor.index);
                    const actual = bars.map(bar => `${bar._state.edge}:${bar._state.kind}`).sort();
                    assert(JSON.stringify(actual) === JSON.stringify(expected), `${style}/${id}: stale layout`);
                    assert(bars.every(bar => bar._actor.visible && bar._actor.opacity === 255), `${style}/${id}: hidden bars`);
                }
                assert(!overlay._layoutTransition._timeline && !overlay._layoutTransition._fadeGroups.length,
                    `${style}/${id}: unfinished layout transition`);
                layouts++;
            }
        }
        return {palettes: cases, layouts};
    } finally {
        overlay._layoutTransition.cancel();
        settings.set_string('layout-transition', 'none');
        for (const [key, value] of saved) if (key !== 'layout-transition') settings.set_value(key, value);
        await settle();
        settings.set_value('layout-transition', saved.get('layout-transition'));
    }
}
