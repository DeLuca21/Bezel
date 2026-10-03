import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {parseDuration, durationText} from './timerModel.js';
const column = () => new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true, style: 'spacing: 8px;'});
const now = () => GLib.get_monotonic_time() / 1e6;
const value = state => state.mode === 'stopwatch' ? state.elapsed + (state.running ? now() - state.started : 0) : Math.max(0, state.remaining - (state.running ? now() - state.started : 0));
const create = (name, minutes) => ({name, mode: 'timer', duration: minutes * 60, remaining: minutes * 60, elapsed: 0, started: 0, running: false, alarm: 0});
function bank(bar, options) {
    const services = bar._overlay.services;
    services._timerBanks ??= new Map();
    const key = `${bar._index}:${bar._moduleInstance || 'timer'}`;
    if (!services._timerBanks.has(key)) services._timerBanks.set(key, [create('Timer 1', options.timerMinutes || 5)]);
    const states = services._timerBanks.get(key);
    services._moduleTimer = states[0];
    return states;
}
function stop(state) {
    const current = value(state); state.running = false;
    if (state.mode === 'stopwatch') state.elapsed = current; else state.remaining = current;
    if (state.alarm) GLib.source_remove(state.alarm); state.alarm = 0;
}
function button(bar, label, run) {
    const b = new St.Button({label, can_focus: true, x_expand: true, style: `padding: 10px; border-radius: 12px; background-color: ${bar._theme.surface}; color: ${bar._theme.fg};`});
    b.connect('clicked', run); return b;
}
function iconButton(bar, name, icon, run) {
    const b = new St.Button({accessible_name: name, can_focus: true, child: new St.Icon({icon_name: icon, icon_size: 16}), style: `padding: 5px; color: ${bar._theme.muted};`});
    b.connect('clicked', run); return b;
}
export function timerFace(bar, options, size) {
    const states = bank(bar, options);
    const row = new St.BoxLayout({orientation: bar._actor.orientation, style: `spacing: 5px; color: ${bar._theme.fg};`, y_align: Clutter.ActorAlign.CENTER});
    if (options.timerIcon !== false || !options.timerName && !options.timerRemaining) row.add_child(new St.Icon({icon_name: 'alarm-symbolic', icon_size: size}));
    const label = new St.Label({y_align: Clutter.ActorAlign.CENTER});
    if (options.timerName || options.timerRemaining) row.add_child(label);
    const face = new St.Button({child: row, can_focus: true, x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
    const paint = () => {
        const state = states.find(item => item.running) || states[0];
        const remaining = state ? durationText(Math.ceil(value(state))) : '0:00';
        label.text = [options.timerName ? state?.name || 'Timer' : '', options.timerRemaining ? remaining : ''].filter(Boolean).join(' · ');
        face.accessible_name = `${state?.name || 'Timer'} · ${remaining}`;
    };
    paint(); const tick = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => { paint(); return GLib.SOURCE_CONTINUE; });
    face.connect('destroy', () => { GLib.source_remove(tick); if (!label.get_parent()) label.destroy(); });
    return face;
}
export function timerPanel(bar, options) {
    const states = bank(bar, options);
    const root = column(), cards = column(); root.add_child(cards);
    const refit = () => { bar._popupLockedHeight = false; if (root.get_stage()) bar._fitPopup(); };
    let paints = [];
    const render = () => {
        cards.destroy_all_children(); paints = [];
        for (const state of states) {
            state.watch ??= {...create('Stopwatch', 0), mode: 'stopwatch'};
            const selected = () => state.view === 'stopwatch' ? state.watch : state;
            const card = column(), head = new St.BoxLayout({style: 'spacing: 6px;'});
            const heading = new St.Label({x_expand: true, y_align: Clutter.ActorAlign.CENTER, style: `font-size: 16px; color: ${bar._theme.fg};`}); head.add_child(heading); card.add_child(head);
            const tools = new St.BoxLayout({style: 'spacing: 6px;'});
            const start = button(bar, 'Start', () => {
                const track = selected();
                if (track.running) stop(track); else {
                    if (track.mode === 'timer' && track.remaining <= 0) track.remaining = track.duration;
                    track.started = now(); track.running = true;
                    if (track.mode === 'timer') track.alarm = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.max(1, Math.round(track.remaining * 1000)), () => {
                        track.alarm = 0; track.running = false; track.remaining = 0; Main.notify(track.name, 'Time is up'); return GLib.SOURCE_REMOVE;
                    });
                } paint();
            }); tools.add_child(start);
            tools.add_child(button(bar, 'Reset', () => { const track = selected(); stop(track); track.remaining = track.duration; track.elapsed = 0; paint(); })); card.add_child(tools);
            const modes = new St.BoxLayout({style: 'spacing: 6px;'});
            for (const [mode, title] of [['timer', 'Timer'], ['stopwatch', 'Stopwatch']]) modes.add_child(button(bar, title, () => { state.view = mode; paint(); })); card.add_child(modes);
            const edit = column(); edit.visible = false;
            const name = new St.Entry({text: state.name, hint_text: 'Timer name', can_focus: true});
            const duration = new St.Entry({text: durationText(state.duration), hint_text: 'Minutes, MM:SS or HH:MM:SS', can_focus: true});
            const hint = new St.Label({text: 'Duration: minutes, MM:SS or HH:MM:SS', style: `color: ${bar._theme.muted}; font-size: 11px;`});
            edit.add_child(name); edit.add_child(duration); edit.add_child(hint);
            edit.add_child(button(bar, 'Save timer', () => {
                const seconds = parseDuration(duration.text);
                if (seconds === null) { hint.text = 'Enter a duration between 0:01 and 24:00:00'; return; }
                if (seconds !== state.duration) { stop(state); state.duration = seconds; state.remaining = seconds; }
                state.name = name.text.trim().slice(0, 80) || 'Timer'; edit.hide(); paint(); refit();
            }));
            head.add_child(iconButton(bar, 'Edit timer', 'document-edit-symbolic', () => { edit.visible = !edit.visible; if (edit.visible) name.grab_key_focus(); refit(); })); card.add_child(edit);
            edit.add_child(button(bar, 'Remove timer', () => { stop(state); stop(state.watch); states.splice(states.indexOf(state), 1); render(); }));
            const paint = () => {
                const track = selected();
                heading.text = `${state.view === 'stopwatch' ? 'Stopwatch' : state.name} · ${durationText(track.mode === 'timer' ? Math.ceil(value(track)) : value(track))}${state.view === 'stopwatch' && state.running ? ' · Timer running' : ''}`;
                start.label = track.running ? 'Pause' : 'Start';
                modes.get_children().forEach((actor, i) => { actor.style = `padding: 6px; border-radius: 10px; background-color: ${(state.view || 'timer') === (i ? 'stopwatch' : 'timer') ? bar._theme.accent : bar._theme.surface}; color: ${(state.view || 'timer') === (i ? 'stopwatch' : 'timer') ? bar._theme.bg : bar._theme.fg};`; });
            }; paint(); paints.push(paint); cards.add_child(card);
        }
        refit();
    };
    root.add_child(iconButton(bar, 'Add timer', 'list-add-symbolic', () => { if (states.length < 12) { states.push(create(`Timer ${states.length + 1}`, options.timerMinutes || 5)); render(); } }));
    render(); const tick = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => { paints.forEach(paint => paint()); return GLib.SOURCE_CONTINUE; });
    root.connect('destroy', () => GLib.source_remove(tick)); return root;
}
