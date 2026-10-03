import {moduleFeatures} from './moduleFeatures.js';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// Share Shell's weather client: location permissions, units and provider requests
// remain owned by GNOME Weather. Never instantiate a second geolocation client.
export class Weather {
    constructor() {
        this.client = Main.panel.statusArea.dateMenu?._weatherItem?._weatherClient;
        this.listeners = new Set();
        this.signal = this.client?.connect('changed', () => { if (!this.client.loading && this.client.info?.is_valid()) this.updatedAt = GLib.DateTime.new_now_local(); this.listeners.forEach(callback => callback()); });
        this.lastRefresh = 0;
        this.timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 900, () => {
            if (this.listeners.size) this.refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    get summary() {
        const client = this.client;
        if (!client?.available) return {text: 'Install GNOME Weather', compact: '—', conditions: '', icon: 'weather-few-clouds-symbolic'};
        if (!client.hasLocation) return {text: 'Choose a location in Weather', compact: '—', conditions: '', icon: 'weather-few-clouds-symbolic'};
        if (client.loading) return {text: 'Loading weather…', compact: '…', conditions: '', icon: 'weather-few-clouds-symbolic'};
        const info = client.info;
        const current = info?.is_valid() ? info : info?.get_forecast_list()?.find(item => item.is_valid());
        if (!current) return {text: 'Weather unavailable · try again later', compact: '—', conditions: '', icon: 'weather-severe-alert-symbolic'};
        const temp = current.get_temp();
        const conditions = current.get_conditions();
        const description = conditions && conditions !== '-' ? conditions : current.get_sky();
        return {text: `${temp} · ${description}`, compact: temp, conditions: description,
            location: info.get_location()?.get_name() ?? '', icon: current.get_symbolic_icon_name() || 'weather-few-clouds-symbolic'};
    }

    get forecast() {
        const info = this.client?.info;
        const list = typeof info?.get_forecast_list === 'function' ? info.get_forecast_list() ?? [] : [];
        const now = GLib.DateTime.new_now_local();
        const today = now.format('%F');
        const days = [];
        const seen = new Set();
        for (const item of list) {
            if (typeof item.is_valid === 'function' && !item.is_valid())
                continue;
            const when = forecastTime(item);
            if (!when)
                continue;
            const key = when.format('%F');
            if (key === today || seen.has(key))
                continue;
            seen.add(key);
            days.push(forecastItem(item, when.format('%a')));
            if (days.length >= 5)
                break;
        }
        if (days.length)
            return days;
        for (const item of list) {
            if (typeof item.is_valid === 'function' && !item.is_valid())
                continue;
            const when = forecastTime(item);
            if (!when || when.to_unix() <= now.to_unix())
                continue;
            days.push(forecastItem(item, when.format('%H:%M')));
            if (days.length >= 4)
                break;
        }
        return days;
    }

    subscribe(callback) {
        this.listeners.add(callback);
        callback();
        this.refresh();
        return () => this.listeners.delete(callback);
    }

    refresh() {
        const now = GLib.get_monotonic_time();
        if (now - this.lastRefresh < 60 * GLib.TIME_SPAN_SECOND) return;
        this.lastRefresh = now;
        this.client?.update();
    }

    open() {
        if (this.client?.available) this.client.activateApp();
        else Main.notify('Bezel Weather', 'Install GNOME Weather and choose a location to display forecasts.');
    }

    destroy() {
        if (this.signal) this.client.disconnect(this.signal);
        GLib.source_remove(this.timer);
        this.listeners.clear();
    }
}

export function weatherWidget(bar, options = {}) {
    const compact = options === true || options.compact === true;
    if (!compact) options = {...moduleFeatures(bar, 'weather'), ...options};
    const showForecast = !compact && options.forecast !== false && options.weatherForecast !== false;
    const weather = bar._overlay.weather;
    const vertical = compact && bar._vertical;
    const size = compact ? bar._state.iconSize : 28;
    const content = new St.BoxLayout({
        orientation: vertical ? Clutter.Orientation.VERTICAL : Clutter.Orientation.HORIZONTAL,
        style: `spacing: ${vertical ? 1 : 8}px;`,
        x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER,
    });
    const icon = new St.Icon({icon_size: size, style: `color: ${bar._theme.accent};`});
    const text = new St.Label({
        x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER,
        x_expand: !compact,
        style: `color: ${bar._theme.fg}; font-size: ${compact ? Math.max(9, Math.round(size * 0.42)) : 14}px;`,
    });
    text.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    const detail = compact ? null : new St.Label({
        x_align: Clutter.ActorAlign.CENTER, x_expand: true,
        style: `color: ${bar._theme.muted}; font-size: 12px;`,
    });
    if (detail) {
        detail.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        detail.clutter_text.line_wrap = true;
        detail.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        const wrap = () => {
            const width = Math.max(80, (bar._popout?.width ?? 320) - 72);
            detail.width = width;
            detail.clutter_text.set_line_wrap(true);
        };
        wrap();
        content.connect('notify::allocation', wrap);
        content.orientation = Clutter.Orientation.VERTICAL;
        const heading = new St.BoxLayout({style: 'spacing: 8px;', x_align: Clutter.ActorAlign.CENTER});
        heading.add_child(icon);
        heading.add_child(text);
        content.add_child(heading);
        content.add_child(detail);
    } else {
        content.add_child(icon);
        content.add_child(text);
    }
    const button = new St.Button({child: content, can_focus: true,
        style_class: compact ? 'bezel-button' : 'bezel-action',
        style: compact ? 'padding: 2px;' : 'padding: 8px 4px;'});
    button.connect('clicked', () => { bar._close(); weather.open(); });
    const forecast = showForecast ? new St.BoxLayout({
        style: 'spacing: 6px;', x_expand: true, x_align: Clutter.ActorAlign.CENTER,
        height: 56,
    }) : null;
    let scale = 1;
    const card = compact ? button : new St.BoxLayout({
        orientation: Clutter.Orientation.VERTICAL, x_expand: true,
        style: `background-color: ${bar._theme.surface}; border-radius: 16px; padding: 12px 14px; spacing: 10px;`,
    });
    if (!compact) {
        button.visible = options.weatherCurrent !== false || options.weatherLocation !== false;
        icon.visible = options.weatherCurrent !== false;
        if (detail) detail.visible = options.weatherCurrent !== false;
        card.add_child(button);
        if (forecast)
            card.add_child(forecast);
    }
    const status = !compact && options.weatherStatus ? new St.Label({style: `color: ${bar._theme.muted}; font-size: 11px;`}) : null;
    if (status) card.add_child(status);
    const unsubscribe = weather.subscribe(() => {
        const summary = weather.summary;
        icon.icon_name = summary.icon;
        if (status) status.text = weather.client?.loading ? 'Updating…' : weather.updatedAt ? `Updated ${weather.updatedAt.format('%H:%M')}` : summary.compact === '—' ? summary.text : 'Using available weather data';
        text.text = compact ? railTemp(summary.compact)
            : [options.weatherLocation === false ? '' : summary.location, options.weatherCurrent === false ? '' : summary.compact].filter(Boolean).join(' · ') || summary.text;
        if (detail)
            detail.text = summary.conditions && summary.conditions !== '-' ? summary.conditions : '';
        button.accessible_name = `${summary.location ?? 'Weather'}: ${summary.text}`;
        if (forecast)
            paintForecast(forecast, weather.forecast, bar, scale);
        if (compact && bar._box) bar._place();
        else if (!compact && ['dashboard', 'clock'].includes(bar._popoutId))
            bar._later('_fitPopupId', 40, () => bar._fitPopup());
    });
    if (!compact) {
        card._dashLayout = ({height}) => {
            const base = forecast ? 148 : 84;
            scale = height ? Math.max(0.65, Math.min(2.1, height / base)) : 1;
            icon.icon_size = Math.round(28 * scale);
            text.style = `color: ${bar._theme.fg}; font-size: ${Math.round(14 * scale)}px;`;
            if (detail)
                detail.style = `color: ${bar._theme.muted}; font-size: ${Math.round(12 * scale)}px;`;
            if (forecast)
                paintForecast(forecast, weather.forecast, bar, scale);
        };
    }
    card.connect('destroy', unsubscribe);
    return card;
}

function paintForecast(row, days, bar, scale = 1) {
    row.destroy_all_children();
    row.visible = days.length > 0;
    for (const day of days) {
        const column = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL, x_expand: true,
            style: 'spacing: 2px;', x_align: Clutter.ActorAlign.CENTER,
        });
        column.add_child(new St.Label({
            text: day.label, x_align: Clutter.ActorAlign.CENTER,
            style: `color: ${bar._theme.muted}; font-size: ${Math.max(9, Math.round(10 * scale))}px;`,
        }));
        column.add_child(new St.Icon({
            icon_name: day.icon, icon_size: Math.max(14, Math.round(18 * scale)), style: `color: ${bar._theme.accent};`,
            x_align: Clutter.ActorAlign.CENTER,
        }));
        column.add_child(new St.Label({
            text: railTemp(day.temp), x_align: Clutter.ActorAlign.CENTER,
            style: `color: ${bar._theme.fg}; font-size: ${Math.max(10, Math.round(11 * scale))}px;`,
        }));
        const button = new St.Button({child: column, can_focus: true, x_expand: true, style: 'padding: 4px 6px;'});
        button._bezelForecast = true;
        button.connect('clicked', () => { bar._close(); bar._overlay.weather.open(); });
        row.add_child(button);
    }
    row.height = Math.max(40, Math.round(56 * scale));
}

function forecastItem(item, label) {
    return {
        label,
        icon: item.get_symbolic_icon_name?.() || 'weather-few-clouds-symbolic',
        temp: item.get_temp?.() ?? '',
    };
}

function forecastTime(item) {
    try {
        if (typeof item.get_value_update === 'function') {
            const result = item.get_value_update();
            const ok = Array.isArray(result) ? result[0] : result;
            const stamp = Array.isArray(result) ? result[1] : null;
            if (ok && stamp)
                return GLib.DateTime.new_from_unix_local(stamp);
        }
    } catch {
    }
    try {
        const update = item.get_update?.();
        if (update?.format)
            return update;
    } catch {
    }
    return null;
}

export function forecastCard(bar) {
    const weather = bar._overlay.weather;
    const box = new St.BoxLayout({
        orientation: Clutter.Orientation.VERTICAL, x_expand: true,
        style: `background-color: ${bar._theme.surface}; border-radius: 16px; padding: 10px 12px; spacing: 8px;`,
    });
    box.add_child(new St.Label({
        text: 'Forecast', x_align: Clutter.ActorAlign.CENTER,
        style: `color: ${bar._theme.muted}; font-size: 12px;`,
    }));
    const row = new St.BoxLayout({style: 'spacing: 6px;', x_expand: true, x_align: Clutter.ActorAlign.CENTER, height: 56});
    box.add_child(row);
    let scale = 1;
    box._dashLayout = ({height}) => {
        scale = height ? Math.max(0.7, Math.min(2.2, height / 96)) : 1;
        paintForecast(row, weather.forecast, bar, scale);
    };
    const unsubscribe = weather.subscribe(() => paintForecast(row, weather.forecast, bar, scale));
    box.connect('destroy', unsubscribe);
    return box;
}

export function railTemp(value) {
    const match = /(-?\d+)/.exec(value ?? '');
    return match ? `${match[1]}°` : value ?? '—';
}
