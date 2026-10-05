// Exercise real extension teardown and reconstruction in an isolated Shell.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {LOGIN_THEMES} from '../bezel@deluca21/lib/loginMotion.js';
const assert = (value, message) => { if (!value) throw new Error(message); };
const settle = (delay = 50) => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
    resolve(); return GLib.SOURCE_REMOVE;
}));

export async function run(extension) {
    if (GLib.getenv('GSETTINGS_BACKEND') !== 'memory') throw new Error('Requires isolated memory settings');
    // The runner enables Bezel through its custom mode; also mark it as a
    // user extension so switching to unlock-dialog keeps it enabled.
    global.settings.set_strv('enabled-extensions', ['bezel@deluca21']);
    await settle();
    const settings = extension._settings;
    const keys = ['lock-animation', 'unlock-animation', 'login-animation-theme', 'login-animation-speed'];
    const saved = new Map(keys.map(key => [key, settings.get_value(key)]));
    const shield = Main.screenShield.actor;
    const originalChildren = shield.get_children().length;
    let cases = 0;
    try {
        Main.overview.hide();
        settings.set_int('login-animation-speed', 25);
        for (const [theme] of LOGIN_THEMES) {
            settings.set_string('login-animation-theme', theme);
            for (const lock of [false, true]) for (const unlock of [false, true]) {
                settings.set_boolean('lock-animation', lock);
                settings.set_boolean('unlock-animation', unlock);
                const oldOverlay = extension._overlay;
                shield.show();
                Main.sessionMode.pushMode('unlock-dialog');
                await settle();
                assert(!extension._overlay && !oldOverlay._bars.length, 'desktop removed while locked');
                assert(!extension._superHandler && !extension._registeredShortcuts.length, 'desktop shortcuts removed');
                const animation = extension._sessionMotion._lockAnimation;
                assert(Boolean(animation?._timeline) === lock, `${theme}: lock option applied`);
                if (animation) {
                    assert(animation._bars.length === 0 && animation._frames.length === 0, 'no desktop actors on shield');
                    assert(animation._surfaces.length === Main.layoutManager.monitors.length, 'lock covers both monitors');
                    animation._timeline.stop();
                    animation._paint(.5);
                    await settle();
                    assert(animation._surfaces.every(area => area.get_parent() === shield && area.mapped && !area.reactive),
                        'lock surfaces render above shield without intercepting input');
                    animation._paint(1);
                    assert(animation._surfaces.every(area => area.opacity === 0), 'temporary frame fades away');
                }
                Main.sessionMode.popMode('unlock-dialog');
                await settle();
                assert(extension._overlay && extension._overlay !== oldOverlay, 'desktop rebuilt after lock');
                assert(!extension._overlay._loginAnimation, 'unlock waits for shield disappearance');
                shield.hide();
                await settle();
                assert(Boolean(extension._overlay._loginAnimation?._timeline) === unlock, `${theme}: unlock option applied`);
                extension._overlay._loginAnimation?.destroy();
                assert(shield.get_children().length === originalChildren, 'lock actors cleaned up');
                cases++;
            }
        }
        // Reduced motion must skip both transitions and retain normal lifecycle.
        const interfaceSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        const animations = interfaceSettings.get_boolean('enable-animations');
        try {
            interfaceSettings.set_boolean('enable-animations', false);
            await settle();
            settings.set_boolean('lock-animation', true); settings.set_boolean('unlock-animation', true);
            shield.show(); Main.sessionMode.pushMode('unlock-dialog'); await settle();
            assert(!extension._sessionMotion._lockAnimation, 'lock respects reduced motion');
            Main.sessionMode.popMode('unlock-dialog'); shield.hide(); await settle();
            assert(!extension._overlay._loginAnimation, 'unlock respects reduced motion');
        } finally { interfaceSettings.set_boolean('enable-animations', animations); }
        return cases;
    } finally {
        if (Main.sessionMode.currentMode === 'unlock-dialog') Main.sessionMode.popMode('unlock-dialog');
        shield.hide();
        for (const [key, value] of saved) settings.set_value(key, value);
    }
}
