import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import GLib from 'gi://GLib';

import { MprisDataFetcher } from './datafetch.js';
import { DinamicUi } from './ui.js';

export default class DinamicMediaPopup extends Extension {
    constructor(metadata) {
        super(metadata);
        this._data = null;
        this._ui = null;
        this._positionTimer = 0;
    }

    enable() {
        log('[dinamic] enabling');

        this._ui = new DinamicUi({
            uuid: this.uuid,
            name: this.metadata.name,
            onOpenPopup: () => this._openPopup(),
            onControl: method => this._data?.sendControl(method),
        });
        this._ui.enable();

        this._data = new MprisDataFetcher(player => this._syncPlayer(player));
        this._data.enable();

        log('[dinamic] enabled');
    }

    disable() {
        log('[dinamic] disabling');

        this._stopPositionPolling();

        if (this._data) {
            this._data.disable();
            this._data = null;
        }

        if (this._ui) {
            this._ui.disable();
            this._ui = null;
        }

        log('[dinamic] disabled');
    }

    _syncPlayer(player) {
        if (!this._ui) return;

        this._ui.updateIndicator(player);

        if (!player) {
            this._stopPositionPolling();
            return;
        }

        if (this._ui.popupVisible)
            this._ui.buildPopupContent(player);
    }

    _openPopup() {
        const player = this._data?.activePlayer;
        if (!player || !this._ui) return;

        this._ui.showPopup(player);
        this._startPositionPolling();
    }

    _startPositionPolling() {
        if (this._positionTimer) return;

        this._tick().catch(() => {});
        this._positionTimer = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            1,
            () => {
                this._tick().catch(() => {});
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    _stopPositionPolling() {
        if (!this._positionTimer) return;

        GLib.source_remove(this._positionTimer);
        this._positionTimer = 0;
    }

    async _tick() {
        if (!this._data?.activePlayer || !this._ui?.popupVisible) {
            this._stopPositionPolling();
            return;
        }

        try {
            const progress = await this._data.refreshActiveProgress();
            if (!progress) return;

            this._ui.updateIndicator(progress.player);
            this._ui.updateProgress(progress.position, progress.player);
        } catch (_e) {
            // The player can vanish between timer ticks.
        }
    }
}
