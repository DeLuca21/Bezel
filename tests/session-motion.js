// Controlled session-mode and shield visibility ordering, without locking GNOME.
import GLib from 'gi://GLib';
const assert = (value, message) => { if (!value) throw new Error(message); };
class Signals {
    constructor(props = {}) { Object.assign(this, props); this.signals = new Map(); this.next = 1; }
    connect(name, callback) { const id = this.next++; this.signals.set(id, {name, callback}); return id; }
    disconnect(id) { assert(this.signals.delete(id), 'disconnect existing handler'); }
    emit(name) { for (const item of [...this.signals.values()]) if (item.name === name) item.callback(); }
}
const mode = new Signals({currentMode: 'user', parentMode: null, isLocked: false, isGreeter: false});
const actor = new Signals({visible: false});
const layout = new Signals();
const settings = new Signals({values: {'lock-animation': false, 'unlock-animation': false},
    get_boolean(key) { return this.values[key]; }});
const [, bytes] = GLib.file_get_contents('bezel@deluca21/lib/sessionMotion.js');
const source = new TextDecoder().decode(bytes).replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
const SessionMotion = new Function('Main', `${source}\nreturn SessionMotion;`)({sessionMode: mode,
    screenShield: {actor}, layoutManager: layout});
let desktop = false, reveals = 0, locks = 0, destroyed = 0;
const create = () => new SessionMotion(settings, () => { desktop = true; }, () => { desktop = false; },
    () => { assert(desktop && !actor.visible, 'unlock only after desktop exposed'); reveals++; },
    () => { assert(!desktop && mode.isLocked, 'desktop removed before lock animation'); locks++;
        return {destroy() { destroyed++; }}; });
const lock = () => {
    actor.visible = true; actor.emit('notify::visible');
    Object.assign(mode, {currentMode: 'unlock-dialog', isLocked: true}); mode.emit('updated');
};
const unlockMode = () => { Object.assign(mode, {currentMode: 'user', isLocked: false}); mode.emit('updated'); };
const hide = () => { actor.visible = false; actor.emit('notify::visible'); };
for (const lockEnabled of [false, true]) for (const unlockEnabled of [false, true]) {
    Object.assign(settings.values, {'lock-animation': lockEnabled, 'unlock-animation': unlockEnabled});
    locks = reveals = destroyed = 0;
    const controller = create();
    assert(desktop && !reveals && !locks, 'initial enable is not unlock');
    for (let cycle = 1; cycle <= 3; cycle++) {
        lock(); mode.emit('updated');
        assert(!desktop && locks === (lockEnabled ? cycle : 0), 'lock runs once per cycle');
        unlockMode(); mode.emit('updated');
        assert(reveals === (unlockEnabled ? cycle - 1 : 0), 'wait for shield fade');
        hide(); actor.emit('notify::visible'); mode.emit('updated');
        assert(reveals === (unlockEnabled ? cycle : 0), 'unlock runs once per cycle');
        assert(destroyed === locks, 'lock surfaces released at unlock');
    }
    controller.destroy(); controller.destroy();
    assert(!desktop && [mode, actor, layout, settings].every(o => !o.signals.size), 'disable releases all state');
}
settings.values['lock-animation'] = settings.values['unlock-animation'] = true;
let controller = create();
lock(); unlockMode(); lock();
const before = reveals;
hide(); // A hidden screen while locked is not an unlock.
assert(reveals === before, 'rapid relock cancels pending unlock');
settings.values['lock-animation'] = false; settings.emit('changed::lock-animation');
assert(!controller._lockAnimation, 'toggle off cancels lock animation');
controller.destroy();
settings.values['lock-animation'] = true;
actor.visible = true;
controller = create();
assert(!desktop, 'enable on lock screen never constructs desktop');
layout.emit('monitors-changed');
assert(!controller._lockAnimation, 'monitor change cancels stale lock geometry');
unlockMode(); hide(); controller.destroy();
Object.assign(mode, {currentMode: 'gdm', isGreeter: true});
controller = create(); assert(!desktop, 'greeter excluded'); controller.destroy();
Object.assign(mode, {currentMode: 'custom-user', parentMode: 'user', isGreeter: false});
controller = create(); assert(desktop, 'custom user modes supported'); controller.destroy();
assert([mode, actor, layout, settings].every(o => !o.signals.size), 'all handlers released');
print('PASS: independent lock/unlock options, repeated cycles, shield timing, relock, monitor changes and teardown');
