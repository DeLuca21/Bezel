// Integration test: run inside an isolated GNOME Shell with
// GSETTINGS_BACKEND=memory and Bezel enabled, then call run(overlay).
// Requires a real Clutter stage: mocked clicks cannot detect pick-region bugs.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {readBars, saveBars} from '../bezel@deluca21/lib/config.js';
import {deleteGroup, nudgeUnit, removeModule} from '../bezel@deluca21/lib/settingsModel.js';

const settle = () => new Promise(resolve => {
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    });
});

export async function run(overlay) {
    if (GLib.getenv('GSETTINGS_BACKEND') !== 'memory')
        throw new Error('Run only in an isolated Shell with GSETTINGS_BACKEND=memory');
    const settings = overlay._settings;
    const saved = settings.get_string('config');
    const results = [];
    Main.overview.hide();

    const check = async name => {
        await settle();
        const bar = overlay._bars[0];
        const controls = bar._order.filter(({id}) =>
            ['status', 'volume', 'network', 'battery', 'power'].includes(id));
        for (const {id, actor} of controls) {
            const [x, y] = actor.get_transformed_position();
            const [w, h] = actor.get_transformed_size();
            const picked = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE,
                x + w / 2, y + h / 2);
            if (picked !== actor && !actor.contains(picked))
                throw new Error(`${name}: ${id} is drawn but not clickable (picked ${picked})`);
            actor.emit('clicked', 1);
            const expected = id === 'power' ? 'power' : 'status';
            if (bar._popoutId !== expected || !bar._popout?.get_parent())
                throw new Error(`${name}: ${id} did not open its drawer`);
            bar._close();
        }
        if (!controls.length)
            throw new Error(`${name}: missing test controls`);
        results.push(name);
    };

    try {
        for (const edge of ['left', 'right', 'top', 'bottom']) {
            for (const apps of [false, true]) {
                const name = `${edge}, apps ${apps ? 'present' : 'absent'}`;
                const reset = () => saveBars(settings, [{edge, modules: [
                    {id: 'logo', place: 'start', group: ''},
                    ...(apps ? [{id: 'apps', place: 'start', group: ''}] : []),
                    {id: 'clock', place: 'center', group: ''},
                    ...['volume', 'network', 'battery'].map(id => ({id, place: 'end', group: 'status'})),
                    {id: 'power', place: 'end', group: ''},
                ]}]);
                reset();
                await check(`${name}: initial`);
                removeModule(settings, 0, 'battery');
                await check(`${name}: removed battery`);
                deleteGroup(settings, 0, 'status');
                await check(`${name}: ungrouped`);
                nudgeUnit(settings, 0, 'network', -1);
                await check(`${name}: reordered`);
                const bars = readBars(settings);
                bars[0].modules = bars[0].modules.map(module => ({...module,
                    place: module.place === 'start' ? 'end' : module.place === 'end' ? 'start' : 'center'}));
                saveBars(settings, bars);
                await check(`${name}: swapped ends`);
            }
        }
        return results;
    } finally {
        settings.set_string('config', saved);
        await settle();
    }
}
