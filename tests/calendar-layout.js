// Requires a real Clutter stage: actor alignment alone does not prove that
// the text inside a fixed-width St.Label is centred.
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {monthGrid} from '../bezel@deluca21/lib/calendar.js';
import {saveBars} from '../bezel@deluca21/lib/config.js';

const settle = (delay = 80) => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
    resolve(); return GLib.SOURCE_REMOVE;
}));
const centre = actor => actor.get_transformed_position()[0] + actor.get_transformed_size()[0] / 2;
const textCentre = label => {
    const text = label.clutter_text ?? label;
    const [, rect] = text.get_layout().get_pixel_extents();
    const scale = text.get_transformed_size()[0] / text.width;
    return text.get_transformed_position()[0] + (rect.x + rect.width / 2) * scale;
};

function check(calendar, name) {
    const [, grid] = calendar.get_children();
    const children = grid.get_children();
    const headings = children.slice(0, 7);
    const dates = children.filter(child => child._bezelDate);
    for (let column = 0; column < 7; column++) {
        const heading = headings[column];
        const days = dates.filter(day => GLib.DateTime.new_from_iso8601(`${day._bezelDate}T12:00:00Z`, null)
            .get_day_of_week() === column + 1);
        if (!days.length) throw new Error(`${name}: missing dates for ${heading.text}`);
        for (const day of days) {
            const offset = textCentre(heading) - centre(day);
            if (Math.abs(offset) > 1)
                throw new Error(`${name}: ${heading.text} text is ${offset.toFixed(2)}px from its date column centre`);
            if (Math.abs(textCentre(day.child) - centre(day)) > 1)
                throw new Error(`${name}: date ${day._bezelDate} text is not centred`);
        }
    }
}

export async function run(overlay, capture = null) {
    if (GLib.getenv('GSETTINGS_BACKEND') !== 'memory')
        throw new Error('Calendar integration requires an isolated Shell with memory settings');
    const settings = overlay._settings;
    const saved = new Map(['config', 'animation-duration'].map(key => [key, settings.get_value(key)]));
    let standalone = null;
    let layouts = 0;
    const checkMonths = async (calendar, name) => {
        const [header] = calendar.get_children();
        const [previous, current, next] = header.get_children();
        for (const [label, button] of [['current', current], ['next', next], ['previous', previous]]) {
            button.emit('clicked', 1);
            if (label === 'previous') previous.emit('clicked', 1);
            await settle();
            check(calendar, `${name}/${label}`);
            layouts++;
        }
    };
    try {
        Main.overview.hide();
        settings.set_int('animation-duration', 0);
        for (const edge of ['left', 'right', 'top', 'bottom']) {
            saveBars(settings, [{edge, modules: [{id: 'clock', place: 'center', group: ''}]}]);
            await settle(250);
            const bar = overlay._bars[0];
            for (const weekNumbers of [false, true]) {
                let calendar;
                bar._open('calendar', bar._actor, () => {
                    calendar = monthGrid(bar._theme, () => {}, {weekNumbers});
                    return calendar;
                });
                await settle(200);
                if (capture && edge === 'left') await capture(`calendar-${weekNumbers ? 'weeks' : 'drawer'}`);
                await checkMonths(calendar, `${edge}/weeks=${weekNumbers}`);
                bar._close();
            }
        }
        for (const weekNumbers of [false, true]) {
            standalone = monthGrid(overlay._bars[0]._theme, () => {}, {weekNumbers});
            Main.uiGroup.add_child(standalone);
            standalone.set_position(200, 100);
            for (const size of [{width: 224, height: 0}, {width: 180, height: 180},
                {width: 350, height: 320}, {width: 550, height: 500}]) {
                standalone._dashLayout(size);
                await settle();
                if (capture && size.height === 320 && !weekNumbers) await capture('calendar-dashboard');
                await checkMonths(standalone, `dashboard/${size.width}x${size.height}/weeks=${weekNumbers}`);
            }
            standalone.destroy();
            standalone = null;
        }
        return layouts;
    } finally {
        standalone?.destroy();
        for (const bar of overlay._bars) bar._close();
        for (const [key, value] of saved) settings.set_value(key, value);
        await settle(200);
    }
}
