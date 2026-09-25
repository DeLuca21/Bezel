import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Volume from 'resource:///org/gnome/shell/ui/status/volume.js';
import {clamp} from './config.js';

// One shared connection per extension, never synchronous D-Bus in the UI thread.
export class Services {
    constructor() {
        this._listeners = new Set();
        this._signals = [];
        this._streamSignals = [];
        this._cancellable = new Gio.Cancellable();
        this._players = new Map();
        this._pendingPlayers = new Map();
        this._mediaWatch = Gio.DBus.session.signal_subscribe('org.freedesktop.DBus',
            'org.freedesktop.DBus', 'NameOwnerChanged', '/org/freedesktop/DBus',
            null, Gio.DBusSignalFlags.NONE, (_bus, _sender, _path, _iface, _signal, params) => {
                const [name, oldOwner, newOwner] = params.deepUnpack();
                if (!name.startsWith('org.mpris.MediaPlayer2.'))
                    return;
                if (oldOwner)
                    this._removePlayer(name);
                if (newOwner)
                    this._addPlayer(name);
            });
        Gio.DBus.session.call('org.freedesktop.DBus', '/org/freedesktop/DBus',
            'org.freedesktop.DBus', 'ListNames', null, new GLib.VariantType('(as)'),
            Gio.DBusCallFlags.NONE, 3000, this._cancellable, (bus, result) => {
                try {
                    const [names] = bus.call_finish(result).deepUnpack();
                    if (!this._cancellable.is_cancelled())
                        names.filter(name => name.startsWith('org.mpris.MediaPlayer2.')).forEach(name => this._addPlayer(name));
                } catch (error) {
                    if (!this._cancellable.is_cancelled())
                        console.warn(`Bezel: media discovery unavailable: ${error.message}`);
                }
            });
        this.soundSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.sound'});
        this._watch(this.soundSettings, 'changed::allow-volume-above-100-percent', () => this._emit());
        this.mixer = Volume.getMixerControl();
        this._watch(this.mixer, 'default-sink-changed', () => this._syncStream());
        this._watch(this.mixer, 'state-changed', () => this._syncStream());
        this._syncStream();
        this._proxy(Gio.BusType.SESSION, 'org.gnome.SettingsDaemon.Power',
            '/org/gnome/SettingsDaemon/Power', 'org.gnome.SettingsDaemon.Power.Screen', proxy => {
                this.brightness = proxy;
                this._watch(proxy, 'g-properties-changed', () => this._emit());
                this._emit();
            });
        this._proxy(Gio.BusType.SYSTEM, 'org.freedesktop.NetworkManager',
            '/org/freedesktop/NetworkManager', 'org.freedesktop.NetworkManager', proxy => {
                this.network = proxy;
                this._watch(proxy, 'g-properties-changed', () => { this._syncNetworkConnection(); this._emit(); });
                this._syncNetworkConnection();
                this._emit();
            });
        this._proxy(Gio.BusType.SYSTEM, 'org.freedesktop.UPower',
            '/org/freedesktop/UPower/devices/DisplayDevice', 'org.freedesktop.UPower.Device', proxy => {
                this.battery = proxy;
                this._watch(proxy, 'g-properties-changed', () => this._emit());
                this._emit();
            });
    }

    _proxy(bus, name, path, iface, ready) {
        Gio.DBusProxy.new_for_bus(bus, Gio.DBusProxyFlags.NONE, null, name, path, iface,
            this._cancellable, (_source, result) => {
                try {
                    const proxy = Gio.DBusProxy.new_for_bus_finish(result);
                    if (!this._cancellable.is_cancelled())
                        ready(proxy);
                } catch (error) {
                    if (!this._cancellable.is_cancelled())
                        console.warn(`Bezel: ${iface} unavailable: ${error.message}`);
                }
            });
    }

    _watch(object, signal, callback) {
        this._signals.push([object, object.connect(signal, callback)]);
    }

    _syncStream() {
        for (const [obj, id] of this._streamSignals)
            obj.disconnect(id);
        this._streamSignals = [];
        this.stream = this.mixer.get_default_sink();
        if (this.stream) {
            for (const signal of ['notify::volume', 'notify::is-muted'])
                this._streamSignals.push([this.stream, this.stream.connect(signal, () => this._emit())]);
        }
        this._emit();
    }

    subscribe(callback) {
        this._listeners.add(callback);
        callback();
        return () => this._listeners.delete(callback);
    }

    _emit() {
        for (const callback of this._listeners)
            callback();
    }

    get volume() {
        return this.stream ? this.stream.volume / this.mixer.get_vol_max_norm() : 0;
    }

    get maxVolume() {
        return this.soundSettings.get_boolean('allow-volume-above-100-percent')
            ? this.mixer.get_vol_max_amplified() / this.mixer.get_vol_max_norm() : 1;
    }

    setVolume(value) {
        if (!this.stream)
            return;
        this.stream.volume = Math.round(clamp(value, 0, this.maxVolume) * this.mixer.get_vol_max_norm());
        this.stream.push_volume();
        this.stream.change_is_muted(value <= 0);
    }

    toggleMute() {
        if (this.stream)
            this.stream.change_is_muted(!this.stream.is_muted);
    }

    get hasBrightness() {
        return property(this.brightness, 'Brightness', -1) >= 0;
    }

    get brightnessLevel() {
        const value = property(this.brightness, 'Brightness', -1);
        return value < 0 ? 0 : clamp(value / 100, 0, 1);
    }

    setBrightness(value) {
        if (!this.brightness)
            return;
        const next = Math.round(clamp(value, 0, 1) * 100);
        Gio.DBus.session.call('org.gnome.SettingsDaemon.Power', '/org/gnome/SettingsDaemon/Power',
            'org.freedesktop.DBus.Properties', 'Set',
            new GLib.Variant('(ssv)', ['org.gnome.SettingsDaemon.Power.Screen', 'Brightness', new GLib.Variant('i', next)]),
            null, Gio.DBusCallFlags.NONE, 2000, this._cancellable, (bus, result) => {
                try {
                    bus.call_finish(result);
                } catch (error) {
                    if (!this._cancellable.is_cancelled())
                        console.warn(`Bezel: brightness unavailable: ${error.message}`);
                }
            });
    }

    get volumeIcon() {
        if (!this.stream || this.stream.is_muted || this.volume === 0)
            return 'audio-volume-muted-symbolic';
        return `audio-volume-${this.volume < 0.34 ? 'low' : this.volume < 0.67 ? 'medium' : 'high'}-symbolic`;
    }

    _syncNetworkConnection() {
        const path = property(this.network, 'PrimaryConnection', '/') !== '/'
            ? property(this.network, 'PrimaryConnection', '/') : property(this.network, 'ActiveConnections', [])[0] ?? '/';
        if (path === this._connectionPath) return;
        this._connectionPath = path;
        if (this._connectionSignal) this.connection.disconnect(this._connectionSignal);
        this._connectionSignal = 0;
        this.connection = null;
        if (path === '/') return;
        this._proxy(Gio.BusType.SYSTEM, 'org.freedesktop.NetworkManager', path,
            'org.freedesktop.NetworkManager.Connection.Active', proxy => {
                if (this._connectionPath !== path) return;
                this.connection = proxy;
                this._connectionSignal = proxy.connect('g-properties-changed', () => this._emit());
                this._emit();
            });
    }

    get networkInfo() {
        const state = property(this.network, 'State', 0);
        const online = state >= 50;
        const name = property(this.connection, 'Id', '');
        const wifi = property(this.connection, 'Type', '') === '802-11-wireless';
        return {
            icon: online ? (wifi ? 'network-wireless-signal-excellent-symbolic' : 'network-wired-symbolic') : 'network-offline-symbolic',
            text: online && name ? `${wifi ? 'Wi-Fi' : 'Network'} · ${name}${state < 70 ? ' · Local only' : ' · Connected'}`
                : state >= 70 ? 'Connected to the internet' : online ? 'Local network only' : 'Network offline',
        };
    }

    get batteryInfo() {
        const present = property(this.battery, 'IsPresent', false);
        const percent = Math.round(property(this.battery, 'Percentage', 0));
        const state = property(this.battery, 'State', 0);
        return {
            present, percent,
            icon: property(this.battery, 'IconName', 'battery-missing-symbolic'),
            text: present ? `${percent}% · ${state === 1 ? 'Charging' : state === 4 ? 'Fully charged' : 'Battery'}` : 'AC power',
        };
    }

    _addPlayer(name) {
        if (this._players.has(name) || this._pendingPlayers.has(name))
            return;
        const ticket = {};
        this._pendingPlayers.set(name, ticket);
        this._proxy(Gio.BusType.SESSION, name, '/org/mpris/MediaPlayer2',
            'org.mpris.MediaPlayer2.Player', proxy => {
                if (this._pendingPlayers.get(name) !== ticket)
                    return;
                this._pendingPlayers.delete(name);
                if (!proxy.g_name_owner)
                    return;
                const signal = proxy.connect('g-properties-changed', () => this._emit());
                this._players.set(name, {proxy, signal});
                this._emit();
            });
    }

    _removePlayer(name) {
        this._pendingPlayers.delete(name);
        const player = this._players.get(name);
        if (player) {
            player.proxy.disconnect(player.signal);
            this._players.delete(name);
            this._emit();
        }
    }

    get media() {
        const players = [...this._players.values()].filter(({proxy}) => property(proxy, 'CanControl', false));
        const player = players.find(({proxy}) => property(proxy, 'PlaybackStatus', '') === 'Playing') ?? players[0];
        if (!player)
            return null;
        const proxy = player.proxy;
        const metadata = property(proxy, 'Metadata', {});
        const value = key => metadata[key]?.deepUnpack?.() ?? metadata[key];
        const artists = value('xesam:artist');
        return {
            proxy,
            title: typeof value('xesam:title') === 'string' ? value('xesam:title') : 'Media player',
            artUrl: typeof value('mpris:artUrl') === 'string' ? value('mpris:artUrl') : '',
            artist: Array.isArray(artists) ? artists.filter(v => typeof v === 'string').join(', ') : '',
            playing: property(proxy, 'PlaybackStatus', '') === 'Playing',
            canPlay: property(proxy, 'CanPlay', false),
            canPause: property(proxy, 'CanPause', false),
            canNext: property(proxy, 'CanGoNext', false),
            canPrevious: property(proxy, 'CanGoPrevious', false),
        };
    }

    mediaAction(method) {
        const media = this.media;
        if (!media || !['PlayPause', 'Next', 'Previous'].includes(method))
            return;
        media.proxy.call(method, null, Gio.DBusCallFlags.NONE, 3000, this._cancellable, (proxy, result) => {
            try {
                proxy.call_finish(result);
            } catch (error) {
                if (!this._cancellable.is_cancelled())
                    console.warn(`Bezel: media action failed: ${error.message}`);
            }
        });
    }

    destroy() {
        if (this._connectionSignal) this.connection.disconnect(this._connectionSignal);
        this._connectionSignal = 0;
        this._cancellable.cancel();
        this._listeners.clear();
        Gio.DBus.session.signal_unsubscribe(this._mediaWatch);
        for (const name of this._players.keys())
            this._removePlayer(name);
        this._pendingPlayers.clear();
        for (const [object, id] of [...this._signals, ...this._streamSignals])
            object.disconnect(id);
        this._signals = [];
        this._streamSignals = [];
    }
}

function property(proxy, name, fallback) {
    return proxy?.get_cached_property(name)?.deepUnpack() ?? fallback;
}
