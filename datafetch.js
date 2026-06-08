import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { debugLog } from './debug.js';

export class MprisDataFetcher {
    constructor(onPlayersChanged = () => {}) {
        this._onPlayersChanged = onPlayersChanged;
        this._players = {};
        this._activePlayer = null;
        this._dbusSubIds = [];
        this._enabled = false;
    }

    get activePlayerName() {
        return this._activePlayer;
    }

    get activePlayer() {
        return this._activePlayer ? this._players[this._activePlayer] : null;
    }

    enable() {
        this._enabled = true;
        this._scanPlayers();
        this._watchNameOwnerChanges();
    }

    disable() {
        this._enabled = false;

        for (const id of this._dbusSubIds)
            Gio.DBus.session.signal_unsubscribe(id);

        this._dbusSubIds = [];
        this._players = {};
        this._activePlayer = null;
    }

    sendControl(method) {
        if (!this._activePlayer) return;

        Gio.DBus.session.call(
            this._activePlayer,
            '/org/mpris/MediaPlayer2',
            'org.mpris.MediaPlayer2.Player',
            method,
            null,
            null,
            Gio.DBusCallFlags.NONE,
            -1,
            null,
            () => {}
        );
    }

    setPosition(microseconds) {
        if (!this._activePlayer) return;

        const player = this._players[this._activePlayer];
        if (!player || !player.trackId || player.trackLen <= 0) return;

        Gio.DBus.session.call(
            this._activePlayer,
            '/org/mpris/MediaPlayer2',
            'org.mpris.MediaPlayer2.Player',
            'SetPosition',
            GLib.Variant.new('(ox)', [player.trackId, microseconds]),
            null,
            Gio.DBusCallFlags.NONE,
            -1,
            null,
            () => {}
        );
    }

    async refreshActiveProgress() {
        if (!this._activePlayer)
            return null;

        const result = await this._dbusCall(
            this._activePlayer,
            'GetAll',
            GLib.Variant.new('(s)', ['org.mpris.MediaPlayer2.Player'])
        );
        const player = this.activePlayer;
        const props = result.deep_unpack()[0];
        const position = this._readPosition(props, player?.position || 0);
        const status = this._unpackValue(props.PlaybackStatus);

        if (player && status)
            player.status = status;

        if (player)
            this._setPlayerPosition(player, position);

        return { position, player };
    }

    async _scanPlayers() {
        try {
            const result = await this._dbusCall('org.freedesktop.DBus', 'ListNames', null);
            const [names] = result.deep_unpack();

            for (const name of names) {
                if (!this._enabled) return;

                if (name.startsWith('org.mpris.MediaPlayer2.'))
                    this._onPlayerAppeared(name);
            }
        } catch (e) {
            debugLog(`scan error: ${e}`);
        }
    }

    _watchNameOwnerChanges() {
        const id = Gio.DBus.session.signal_subscribe(
            'org.freedesktop.DBus',
            'org.freedesktop.DBus',
            'NameOwnerChanged',
            '/org/freedesktop/DBus',
            null,
            Gio.DBusSignalFlags.NONE,
            (_c, _s, _p, _i, _sig, params) => {
                if (!this._enabled) return;

                const [name, oldOwner, newOwner] = params.deep_unpack();
                if (!name.startsWith('org.mpris.MediaPlayer2.')) return;

                if (newOwner && !oldOwner)
                    this._onPlayerAppeared(name);
                else if (!newOwner && oldOwner)
                    this._onPlayerVanished(name);
            }
        );
        this._dbusSubIds.push(id);
    }

    async _onPlayerAppeared(busName) {
        if (!this._enabled) return;
        if (this._players[busName]) return;

        this._players[busName] = {
            busName,
            status: 'Stopped',
            title: '',
            artist: '',
            artUrl: null,
            trackId: null,
            trackLen: 0,
            position: 0,
            positionUpdatedAt: 0,
        };

        const subId = Gio.DBus.session.signal_subscribe(
            busName,
            'org.freedesktop.DBus.Properties',
            'PropertiesChanged',
            '/org/mpris/MediaPlayer2',
            null,
            Gio.DBusSignalFlags.NONE,
            (_c, _s, _p, _i, _sig, params) => {
                const [iface] = params.deep_unpack();
                if (iface === 'org.mpris.MediaPlayer2.Player')
                    this._refreshPlayer(busName);
            }
        );
        this._dbusSubIds.push(subId);

        await this._refreshPlayer(busName);
    }

    _onPlayerVanished(busName) {
        if (!this._enabled) return;

        delete this._players[busName];

        if (this._activePlayer === busName)
            this._activePlayer = null;

        this._selectActivePlayer();
    }

    async _refreshPlayer(busName) {
        if (!this._enabled) return;

        try {
            const result = await this._dbusCall(
                busName,
                'GetAll',
                GLib.Variant.new('(s)', ['org.mpris.MediaPlayer2.Player'])
            );
            const props = result.deep_unpack()[0];
            const status = this._unpackValue(props.PlaybackStatus) || 'Stopped';
            const metadata = this._unpackValue(props.Metadata) || {};
            const title = this._unpackValue(metadata['xesam:title']) || 'Unknown';
            let artist = this._unpackValue(metadata['xesam:artist']) || '';

            if (Array.isArray(artist))
                artist = artist.join(', ');

            const player = this._players[busName];
            if (!this._enabled) return;

            if (player) {
                player.status = status;
                player.title = title;
                player.artist = artist;
                player.artUrl = this._unpackValue(metadata['mpris:artUrl']) || null;
                player.trackId = this._unpackValue(metadata['mpris:trackid']) || null;
                player.trackLen = this._unpackValue(metadata['mpris:length']) || 0;
                this._setPlayerPosition(player, this._readPosition(props, player.position));
            }

            this._selectActivePlayer();
        } catch (_e) {
            // The player can disappear while GNOME Shell is asking it for properties.
        }
    }

    _selectActivePlayer() {
        let playing = null;
        let paused = null;

        for (const [name, info] of Object.entries(this._players)) {
            if (info.status === 'Playing')
                playing = name;
            else if (info.status === 'Paused')
                paused = name;
        }

        this._activePlayer = playing || paused || null;
        this._onPlayersChanged(this.activePlayer);
    }

    _dbusCall(busName, method, params) {
        const returnTypes = {
            ListNames: '(as)',
            GetAll: '(a{sv})',
            Get: '(v)',
        };
        const returnType = returnTypes[method]
            ? GLib.VariantType.new(returnTypes[method])
            : null;

        return new Promise((resolve, reject) => {
            const objectPath = method === 'ListNames'
                ? '/org/freedesktop/DBus'
                : '/org/mpris/MediaPlayer2';
            const interfaceName = method === 'ListNames'
                ? 'org.freedesktop.DBus'
                : 'org.freedesktop.DBus.Properties';

            Gio.DBus.session.call(
                busName,
                objectPath,
                interfaceName,
                method,
                params || null,
                returnType,
                Gio.DBusCallFlags.NONE,
                -1,
                null,
                (conn, res) => {
                    try {
                        resolve(conn.call_finish(res));
                    } catch (e) {
                        reject(e);
                    }
                }
            );
        });
    }

    _unpackValue(value) {
        return value && typeof value.deep_unpack === 'function'
            ? value.deep_unpack()
            : value;
    }

    _readPosition(props, fallback = 0) {
        if (!Object.prototype.hasOwnProperty.call(props, 'Position'))
            return fallback;

        return this._unpackValue(props.Position) || 0;
    }

    _setPlayerPosition(player, position) {
        player.position = position;
        player.positionUpdatedAt = GLib.get_monotonic_time();
    }
}
