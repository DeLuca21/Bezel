import {timerPanel} from './timers.js';
import {shortcutsPanel} from './shortcutRuntime.js';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {moduleFeatures} from './moduleFeatures.js';
import {performanceMenu, openScreenshot, openSettings} from './tools.js';

const column = () => new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true, style: 'spacing: 8px;'});
const label = (bar, text) => new St.Label({text, style: `color: ${bar._theme.fg}; font-size: 14px;`});
function button(bar, text, run) {
    const actor = new St.Button({label: text, can_focus: true, x_expand: true,
        style: `padding: 10px; border-radius: 12px; color: ${bar._theme.fg}; background-color: ${bar._theme.surface};`});
    actor.connect('clicked', run); return actor;
}
export function inputDevices(bar) { return audioDevices(bar, true); }
export function outputDevices(bar) { return audioDevices(bar, false); }
function audioDevices(bar, input) {
    const box = column();
    const mixer = bar._overlay.services.mixer;
    const paint = () => {
        box.destroy_all_children();
        const current = input ? mixer.get_default_source() : mixer.get_default_sink();
        for (const source of (input ? mixer.get_sources() : mixer.get_sinks()) || []) {
            if (source.is_virtual) continue;
            box.add_child(button(bar, `${source === current ? '✓ ' : ''}${source.get_description() || source.get_name()}`, () => {
                if (input) mixer.set_default_source(source); else mixer.set_default_sink(source);
            }));
        }
        if (!box.get_n_children()) box.add_child(label(bar, input ? 'No input devices' : 'No output devices'));
    };
    const signals = [input ? 'default-source-changed' : 'default-sink-changed', 'stream-added', 'stream-removed'].map(name => mixer.connect(name, paint));
    box.connect('destroy', () => signals.forEach(id => mixer.disconnect(id)));
    paint(); return box;
}
export function deviceBatteries(bar) {
    const box = column(); box.add_child(label(bar, 'Reading device batteries…'));
    const cancel = new Gio.Cancellable();
    const bus = Gio.DBus.system;
    const call = (path, iface, method, args, type) => new Promise((resolve, reject) => bus.call('org.freedesktop.UPower', path, iface, method, args, type ? new GLib.VariantType(type) : null,
        Gio.DBusCallFlags.NONE, 3000, cancel, (source, result) => { try { resolve(source.call_finish(result).deepUnpack()); } catch (error) { reject(error); } }));
    let pending = false;
    const refresh = async () => {
        if (pending) return; pending = true;
        try {
            const [paths] = await call('/org/freedesktop/UPower', 'org.freedesktop.UPower', 'EnumerateDevices', null, '(ao)');
            const devices = await Promise.all(paths.map(async path => {
                const [props] = await call(path, 'org.freedesktop.DBus.Properties', 'GetAll', new GLib.Variant('(s)', ['org.freedesktop.UPower.Device']), '(a{sv})');
                const get = key => props[key]?.deepUnpack?.() ?? props[key];
                return {present: get('IsPresent'), type: get('Type'), model: get('Model'), percent: get('Percentage'), state: get('State')};
            }));
            if (cancel.is_cancelled()) return;
            box.destroy_all_children();
            for (const item of devices.filter(item => item.present && item.type !== 1 && Number.isFinite(item.percent)))
                box.add_child(label(bar, `${item.model || 'Battery'} · ${Math.round(item.percent)}%${item.state === 1 ? ' · Charging' : ''}`));
            if (!box.get_n_children()) box.add_child(label(bar, 'No device batteries reported'));
        } catch (error) { if (!cancel.is_cancelled()) { box.destroy_all_children(); box.add_child(label(bar, 'Device batteries unavailable')); } }
        finally { pending = false; }
    };
    refresh(); const timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 30, () => { refresh(); return GLib.SOURCE_CONTINUE; });
    box.connect('destroy', () => { cancel.cancel(); GLib.source_remove(timer); }); return box;
}
export function performancePanel(bar, options) {
    const box = column(); const cancel = new Gio.Cancellable(); let previous = null; let pending = false;
    const read = path => new Promise(resolve => Gio.File.new_for_path(path).load_contents_async(cancel, (file, result) => {
        try { const [, bytes] = file.load_contents_finish(result); resolve(new TextDecoder().decode(bytes)); } catch { resolve(''); }
    }));
    const rows = [];
    for (const [id, show, name] of [['cpu', options.metricCpu, 'CPU'], ['memory', options.metricMemory, 'Memory'], ['temp', options.metricTemperature, 'CPU temperature']]) {
        if (!show) continue;
        const text = label(bar, `${name} · …`); box.add_child(text);
        const history = []; const graph = new St.DrawingArea({height: 42, x_expand: true});
        graph.connect('repaint', area => {
            const cr = area.get_context(); try {
                const [w, h] = area.get_surface_size(); const color = bar._theme.accent;
                cr.setSourceRGB(...[1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16) / 255)); cr.setLineWidth(2);
                history.forEach((value, i) => { const x = i * w / 59; const y = h - Math.min(1, Math.max(0, value)) * (h - 3); if (!i) cr.moveTo(x, y); else cr.lineTo(x, y); }); cr.stroke();
            } finally { cr.$dispose(); }
        });
        if (options.metricGraphs) box.add_child(graph); else graph.destroy();
        rows.push({id, name, text, history, graph});
    }
    let tempPath = null;
    const tick = async () => {
        if (pending || cancel.is_cancelled()) return; pending = true;
        try {
            if (options.metricTemperature && tempPath === null) {
                tempPath = '';
                for (let i = 0; i < 32; i++) { const base = `/sys/class/thermal/thermal_zone${i}`; if (/cpu|x86_pkg|k10temp/i.test(await read(`${base}/type`))) { tempPath = `${base}/temp`; break; } }
            }
            const [stat, mem, temp] = await Promise.all([read('/proc/stat'), read('/proc/meminfo'), tempPath ? read(tempPath) : Promise.resolve('')]);
            if (cancel.is_cancelled()) return;
            const values = stat.split('\n')[0].trim().split(/\s+/).slice(1, 9).map(Number);
            const total = values.reduce((a, b) => a + b, 0); const idle = (values[3] || 0) + (values[4] || 0);
            const cpu = previous && total > previous.total ? 1 - (idle - previous.idle) / (total - previous.total) : null; previous = {total, idle};
            const all = Number(/MemTotal:\s+(\d+)/.exec(mem)?.[1]); const available = Number(/MemAvailable:\s+(\d+)/.exec(mem)?.[1]);
            const readings = {cpu, memory: all > 0 ? 1 - available / all : null, temp: temp.trim() ? Number(temp) / 100000 : null};
            for (const row of rows) { const value = readings[row.id]; row.text.text = `${row.name} · ${value === null || !Number.isFinite(value) ? 'Unavailable' : `${Math.round(value * 100)}${row.id === 'temp' ? ' °C' : '%'}`}`;
                if (Number.isFinite(value) && value !== null) { row.history.push(value); if (row.history.length > 60) row.history.shift(); if (options.metricGraphs) row.graph.queue_repaint(); } }
        } finally { pending = false; }
    };
    tick(); const timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, options.refreshSeconds, () => { tick(); return GLib.SOURCE_CONTINUE; });
    box.connect('destroy', () => { cancel.cancel(); GLib.source_remove(timer); });
    if (options.metricProfiles) box.add_child(performanceMenu(bar));
    return box;
}
export function expandedModule(bar, id, overrides = {}) {
    const options = moduleFeatures(bar, id, overrides);
    if (id === 'shortcuts') return shortcutsPanel(bar, options);
    if (id === 'timer') return timerPanel(bar, options);
    if (id === 'devices') return deviceBatteries(bar);
    if (id === 'input') return inputDevices(bar);
    if (id === 'performance') return performancePanel(bar, options);
    return null;
}
