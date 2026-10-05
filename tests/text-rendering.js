// Run in a disposable Shell: exercise actual allocations, not rounded mocks.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {saveBars} from '../bezel@deluca21/lib/config.js';

const settle = () => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 180, () => {
    resolve(); return GLib.SOURCE_REMOVE;
}));
const integer = (value, name) => {
    if (Math.abs(value - Math.round(value)) > 0.001)
        throw new Error(`${name}: text container is between pixels (${value})`);
};

export async function run(overlay, capture = null) {
    if (GLib.getenv('GSETTINGS_BACKEND') !== 'memory')
        throw new Error('Text rendering integration requires isolated memory settings');
    const settings = overlay._settings;
    const saved = new Map(['config', 'animation-duration'].map(key => [key, settings.get_value(key)]));
    let cases = 0;
    try {
        Main.overview.hide();
        settings.set_int('animation-duration', 0);
        for (const edge of ['left', 'right', 'top', 'bottom']) {
            for (const kind of ['panel', 'dock']) {
                saveBars(settings, [{edge, kind, length: 73, margin: 11, thickness: 55,
                    fitContent: false, modules: [{id: 'clock', place: 'center', group: ''}]}]);
                await settle();
                for (const bar of overlay._bars) {
                    const name = `${edge}/${kind}/${bar._monitor.index}`;
                    for (const [i, value] of [...bar._actor.get_transformed_position(),
                        ...bar._actor.get_transformed_size()].entries()) integer(value, `${name}/bar/${i}`);
                    const content = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL,
                        style: 'spacing: 12px;'});
                    for (const size of [11, 13, 16, 22]) content.add_child(new St.Label({
                        text: 'Clean text 0123456789', style: `font-size: ${size}px;`,
                    }));
                    const sideways = bar._sideways(bar._theme.fg, 13);
                    bar._fitSideways(sideways, 'Vertical text');
                    content.add_child(sideways);
                    const reference = new St.Label({text: 'Vertical text',
                        style: 'font-size: 13px; font-weight: 600;'});
                    Main.uiGroup.add_child(reference);
                    if (!sideways._bezelFontDescription.equal(reference.get_theme_node().get_font()))
                        throw new Error(`${name}: vertical text uses a different font`);
                    reference.destroy();
                    bar._open('text-test', bar._actor, () => content);
                    await settle();
                    bar._setPopupHeight(241);
                    await settle();
                    for (const [i, value] of bar._popout.get_transformed_position().entries())
                        integer(value, `${name}/popout/${i}`);
                    if (bar._actor.scale_x !== 1 || bar._actor.scale_y !== 1 ||
                        bar._popout.scale_x !== 1 || bar._popout.scale_y !== 1)
                        throw new Error(`${name}: settled text is texture-scaled`);
                    if (capture && edge === 'left' && kind === 'panel' && bar._monitor.index === 0)
                        await capture('text-rendering');
                    bar._close();
                    cases++;
                }
            }
        }
        return cases;
    } finally {
        for (const bar of overlay._bars) bar._close();
        for (const [key, value] of saved) settings.set_value(key, value);
        await settle();
    }
}
