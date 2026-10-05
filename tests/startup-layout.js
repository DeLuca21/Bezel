// Real St actors, private Shell only: late icon sizing must resize bar clips.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {saveBars} from '../bezel@deluca21/lib/config.js';

const settle = () => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
    resolve(); return GLib.SOURCE_REMOVE;
}));
const descendants = actor => [actor, ...actor.get_children().flatMap(descendants)];
const assert = (value, message) => { if (!value) throw new Error(message); };

export async function run(overlay) {
    if (GLib.getenv('GSETTINGS_BACKEND') !== 'memory')
        throw new Error('Startup layout tests require an isolated Shell');
    const settings = overlay._settings;
    const saved = settings.get_string('config');
    let cases = 0;
    try {
        Main.overview.hide();
        for (const edge of ['left', 'right', 'top', 'bottom']) {
            for (const kind of ['panel', 'dock']) {
                saveBars(settings, [{edge, kind, fitContent: true, modules: [
                    {id: 'logo', place: 'start', group: ''},
                    ...['network', 'bluetooth', 'power'].map(id => ({id, place: 'end', group: ''})),
                ]}]);
                await settle();
                const bar = overlay._bars[0];
                const controls = bar._order.filter(({id}) => ['network', 'bluetooth', 'power'].includes(id));
                const icons = controls.flatMap(({actor}) => descendants(actor).filter(child => child instanceof St.Icon));
                // Model icons whose texture has not supplied a natural size yet.
                icons.forEach(icon => icon.set_size(0, 0));
                bar._place();
                await settle();
                const small = bar._sectionSpans().reduce((sum, value) => sum + value, 0);
                icons.forEach(icon => icon.set_size(32, 32));
                await settle();
                assert(bar._sectionSpans().reduce((sum, value) => sum + value, 0) > small,
                    `${edge}/${kind}: test icons must grow`);
                for (const {id, actor} of controls) {
                    const button = descendants(actor).find(child => child instanceof St.Button && child._activate);
                    assert(button, `${edge}/${kind}: missing ${id} button`);
                    const [x, y] = button.get_transformed_position();
                    const [w, h] = button.get_transformed_size();
                    // Check both ends, since a partly clipped icon may still have a clickable centre.
                    for (const fraction of [0.15, 0.5, 0.85]) {
                        const picked = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE,
                            x + w * (bar._vertical ? 0.5 : fraction),
                            y + h * (bar._vertical ? fraction : 0.5));
                        assert(picked === button || button.contains(picked),
                            `${edge}/${kind}: late ${id} icon clipped at ${fraction}; picked ${picked}; ` +
                            `button ${[x, y, w, h]}, bar ${JSON.stringify(bar._box)}, ` +
                            `sizes ${bar._contentLayoutSize}, now ${bar._sectionSpans()}`);
                    }
                }
                let placements = 0;
                const place = bar._place;
                bar._place = function (...args) { placements++; return place.apply(this, args); };
                await settle();
                assert(placements === 0, `${edge}/${kind}: layout must settle`);
                icons.forEach(icon => icon.set_size(16, 16));
                await settle();
                assert(placements > 0 && placements < 5, `${edge}/${kind}: shrinking icons must refresh once and settle`);
                bar._place = place;
                cases++;
            }
        }
        return cases;
    } finally {
        settings.set_string('config', saved);
        await settle();
    }
}
