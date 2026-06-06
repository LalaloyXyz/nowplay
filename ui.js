import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import St from 'gi://St';
import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';

const CONFIG = {
    width: 520,
    height: 176,
    topMargin: 10,
    animDuration: 220,
    autoCloseDelay: 3600,
    popupLeaveCloseDelay: 500,
};

const THEME = {
    background: 'rgba(5, 5, 7, 0.98)',
    border: 'rgba(255, 255, 255, 0.11)',
    highlight: 'rgba(255, 255, 255, 0.16)',
    progress: '#34d399',
    accentSoft: 'rgba(52, 211, 153, 0.18)',
    text: '#ffffff',
    mutedText: '#c7c7cc',
    dimText: '#7d7d86',
    buttonBg: 'rgba(255, 255, 255, 0.075)',
    buttonBorder: 'rgba(255, 255, 255, 0.10)',
    radius: 35,
};

export class DinamicUi {
    constructor({ uuid, name, onOpenPopup, onControl }) {
        this._uuid = uuid;
        this._name = name;
        this._onOpenPopup = onOpenPopup;
        this._onControl = onControl;
        this._clockButton = null;
        this._enterSignal = null;
        this._pressSignal = null;
        this._touchSignal = null;
        this._popup = null;
        this._popupKeyPressId = null;
        this._popupEnterSignal = null;
        this._popupLeaveSignal = null;
        this._closeTimer = 0;
        this._popupVisible = false;
        this._progressOuter = null;
        this._progressFill = null;
        this._currentTimeLabel = null;
        this._playPauseIcon = null;
    }

    get popupVisible() {
        return this._popupVisible;
    }

    enable() {
        this._clockButton = Main.panel.statusArea.dateMenu?.actor
            || Main.panel.statusArea.dateMenu;

        if (!this._clockButton) {
            log('[dinamic] clock button not found');
            return;
        }

        this._enterSignal = this._clockButton.connect('enter-event', () => {
            this._onOpenPopup();
            return Clutter.EVENT_PROPAGATE;
        });

        this._pressSignal = this._clockButton.connect('button-press-event', (_actor, event) => {
            if (event.get_button() !== 1)
                return Clutter.EVENT_PROPAGATE;

            this._onOpenPopup();
            return Clutter.EVENT_STOP;
        });

        this._touchSignal = this._clockButton.connect('touch-event', (_actor, event) => {
            if (event.type() !== Clutter.EventType.TOUCH_BEGIN)
                return Clutter.EVENT_PROPAGATE;

            this._onOpenPopup();
            return Clutter.EVENT_STOP;
        });
    }

    disable() {
        this.destroyPopup();

        if (this._clockButton) {
            if (this._enterSignal)
                this._clockButton.disconnect(this._enterSignal);

            if (this._pressSignal)
                this._clockButton.disconnect(this._pressSignal);

            if (this._touchSignal)
                this._clockButton.disconnect(this._touchSignal);
        }

        this._clockButton = null;
        this._enterSignal = null;
        this._pressSignal = null;
        this._touchSignal = null;
    }

    updateIndicator(player) {
        if (!player)
            this.destroyPopup();
    }

    togglePopup(player) {
        if (!player) return;

        if (this._popupVisible)
            this.destroyPopup();
        else
            this.showPopup(player);
    }

    showPopup(player) {
        if (!player || this._popup) return;

        this._popup = new St.BoxLayout({
            vertical: false,
            style_class: 'dinamic-popup dinamic-popup-custom',
            style: this._getPopupStyle(),
            reactive: true,
            can_focus: true,
            track_hover: true,
        });

        this.buildPopupContent(player);
        Main.layoutManager.addChrome(this._popup, { trackFullscreen: true });

        this._popupKeyPressId = this._popup.connect('key-press-event', (_actor, event) => {
            if (event.get_key_symbol() === Clutter.KEY_Escape) {
                this.destroyPopup();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        this._popupEnterSignal = this._popup.connect('enter-event', () => {
            this._clearCloseTimer();
            return Clutter.EVENT_PROPAGATE;
        });
        this._popupLeaveSignal = this._popup.connect('leave-event', () => {
            this._scheduleClose(CONFIG.popupLeaveCloseDelay);
            return Clutter.EVENT_PROPAGATE;
        });
        this._popup.grab_key_focus();

        const [x, y] = this._getPopupPosition();
        if (CONFIG.animDuration > 0) {
            this._popup.opacity = 0;
            this._popup.set_scale(0.96, 0.96);
            this._popup.set_pivot_point(0.5, 0.5);
            this._popup.set_position(x, y);
            this._popup.ease({
                y,
                opacity: 255,
                scale_x: 1,
                scale_y: 1,
                duration: CONFIG.animDuration,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        } else {
            this._popup.set_position(x, y);
            this._popup.opacity = 255;
        }

        this._popupVisible = true;
        this._scheduleClose(CONFIG.autoCloseDelay);
    }

    destroyPopup() {
        if (!this._popup) return;

        this._clearCloseTimer();

        if (this._popupKeyPressId) {
            this._popup.disconnect(this._popupKeyPressId);
            this._popupKeyPressId = null;
        }

        if (this._popupEnterSignal) {
            this._popup.disconnect(this._popupEnterSignal);
            this._popupEnterSignal = null;
        }

        if (this._popupLeaveSignal) {
            this._popup.disconnect(this._popupLeaveSignal);
            this._popupLeaveSignal = null;
        }

        if (CONFIG.animDuration > 0) {
            const [, y] = this._popup.get_position();
            this._popup.ease({
                y: y + 18,
                opacity: 0,
                scale_x: 0.96,
                scale_y: 0.96,
                duration: CONFIG.animDuration,
                mode: Clutter.AnimationMode.EASE_IN_QUAD,
                onComplete: () => this._removePopup(),
            });
        } else {
            this._removePopup();
        }

        this._popupVisible = false;
    }

    _scheduleClose(delay) {
        this._clearCloseTimer();

        this._closeTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._closeTimer = 0;
            this.destroyPopup();
            return GLib.SOURCE_REMOVE;
        });
    }

    _clearCloseTimer() {
        if (!this._closeTimer) return;

        GLib.source_remove(this._closeTimer);
        this._closeTimer = 0;
    }

    buildPopupContent(player) {
        if (!this._popup || !player) return;

        for (const child of this._popup.get_children().slice())
            child.destroy();

        this._progressOuter = null;
        this._progressFill = null;
        this._currentTimeLabel = null;
        this._playPauseIcon = null;
        this._popup.style = this._getPopupStyle();

        const mainBox = new St.BoxLayout({
            vertical: false,
            style: 'padding: 16px 20px; spacing: 18px;',
            x_expand: true,
            y_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._popup.add_child(mainBox);

        mainBox.add_child(this._createArtFrame(player));
        mainBox.add_child(this._createDetails(player));
    }

    updateProgress(position, player) {
        const safePosition = Math.max(0, Number.isFinite(position) ? position : 0);

        if (this._progressFill && player?.trackLen > 0) {
            const frac = Math.min(1, safePosition / player.trackLen);
            const width = this._progressOuter?.get_width?.() || 0;
            if (width > 0)
                this._progressFill.set_width(Math.round(width * frac));
        }

        if (this._currentTimeLabel)
            this._currentTimeLabel.text = this._formatTime(safePosition);

        if (this._playPauseIcon && player) {
            this._playPauseIcon.icon_name = player.status === 'Playing'
                ? 'media-playback-pause-symbolic'
                : 'media-playback-start-symbolic';
        }
    }

    _removePopup() {
        if (!this._popup) return;

        Main.layoutManager.removeChrome(this._popup);
        this._popup.destroy();
        this._popup = null;
        this._progressOuter = null;
        this._progressFill = null;
        this._currentTimeLabel = null;
        this._playPauseIcon = null;
    }

    _getPopupPosition() {
        const monitor = Main.layoutManager.primaryMonitor;
        const x = monitor.x + Math.floor((monitor.width - CONFIG.width) / 2);
        const panelHeight = Main.panel?.height || 0;
        const y = monitor.y + panelHeight + CONFIG.topMargin;

        return [x, y];
    }

    _createDetails(player) {
        const rightBox = new St.BoxLayout({
            vertical: true,
            style: 'spacing: 7px; min-width: 80px; padding-top: 3px;',
            x_expand: true,
            y_expand: true,
        });

        const headerRow = new St.BoxLayout({
            vertical: false,
            style: 'spacing: 10px;',
            x_expand: true,
        });

        const titleLabel = new St.Label({
            text: player.title || 'Unknown',
            style: `font-weight: 700; font-size: 16px; color: ${THEME.text};`,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        titleLabel.clutter_text.set_ellipsize(3);
        headerRow.add_child(titleLabel);
        headerRow.add_child(this._createStatusPill(player));
        rightBox.add_child(headerRow);

        const artistLabel = new St.Label({
            text: player.artist || 'Unknown Artist',
            style: `font-size: 12px; color: ${THEME.mutedText};`,
        });
        artistLabel.clutter_text.set_ellipsize(3);
        rightBox.add_child(artistLabel);

        const progOuter = new St.BoxLayout({
            style: 'background-color: rgba(255,255,255,0.13); height: 6px; border-radius: 99px; margin-top: 8px;',
            x_expand: true,
        });
        this._progressOuter = progOuter;
        this._progressFill = new St.BoxLayout({
            style: `background-color: ${THEME.progress}; border-radius: 99px;`,
            width: 0,
        });
        progOuter.add_child(this._progressFill);
        rightBox.add_child(progOuter);

        const trackTime = player.trackLen ? this._formatTime(player.trackLen) : '0:00';
        const timeRow = new St.BoxLayout({
            x_expand: true,
        });
        this._currentTimeLabel = new St.Label({
            text: this._formatTime(player.position),
            style: `font-size: 10px; font-weight: 600; color: ${THEME.dimText};`,
            x_align: Clutter.ActorAlign.START,
        });
        const totalTimeLabel = new St.Label({
            text: trackTime,
            style: `font-size: 10px; font-weight: 600; color: ${THEME.dimText};`,
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
        });
        timeRow.add_child(this._currentTimeLabel);
        timeRow.add_child(totalTimeLabel);
        rightBox.add_child(timeRow);

        rightBox.add_child(this._createControls(player));
        progOuter.connect('notify::width', () => this.updateProgress(player.position, player));
        this.updateProgress(player.position, player);
        return rightBox;
    }

    _createArtFrame(player) {
        const artIcon = new St.Icon({
            icon_name: 'audio-x-generic-symbolic',
            style: 'width: 118px; height: 118px;',
            icon_size: 118,
        });

        if (player.artUrl) {
            try {
                const file = Gio.File.new_for_uri(player.artUrl);
                artIcon.gicon = Gio.FileIcon.new(file);
                artIcon.icon_size = 118;
            } catch (_e) {
                // Keep the generic fallback icon if the player gives a bad art URL.
            }
        }

        const artFrame = new St.Bin({
            child: artIcon,
            style: `
                width: 118px;
                height: 118px;
                padding: 0;
                border-radius: 28px;
                background-color: rgba(255, 255, 255, 0.08);
                border: 1px solid rgba(255, 255, 255, 0.12);
                box-shadow: 0 10px 26px rgba(0, 0, 0, 0.42);
            `,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });

        return artFrame;
    }

    _createStatusPill(player) {
        const isPlaying = player.status === 'Playing';
        const icon = new St.Icon({
            icon_name: isPlaying
                ? 'media-playback-start-symbolic'
                : 'media-playback-pause-symbolic',
            style: 'width: 11px; height: 11px;',
            icon_size: 11,
        });
        const label = new St.Label({
            text: isPlaying ? 'Live' : 'Paused',
            style: `font-size: 10px; font-weight: 700; color: ${THEME.text};`,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const pill = new St.BoxLayout({
            vertical: false,
            style: `
                spacing: 5px;
                padding: 4px 8px;
                border-radius: 99px;
                background-color: ${isPlaying ? THEME.accentSoft : 'rgba(255,255,255,0.08)'};
                border: 1px solid ${isPlaying ? 'rgba(52, 211, 153, 0.28)' : THEME.buttonBorder};
            `,
            y_align: Clutter.ActorAlign.CENTER,
        });

        pill.add_child(icon);
        pill.add_child(label);
        return pill;
    }

    _createControls(player) {
        const controls = new St.BoxLayout({
            style: 'spacing: 14px; padding-top: 6px;',
            x_align: Clutter.ActorAlign.CENTER,
        });

        controls.add_child(this._makeButton('media-skip-backward-symbolic', () => this._onControl('Previous')));

        this._playPauseIcon = new St.Icon({
            icon_name: player.status === 'Playing'
                ? 'media-playback-pause-symbolic'
                : 'media-playback-start-symbolic',
            style: 'width: 20px; height: 20px; color: #050507;',
            icon_size: 20,
        });
        const playPauseButton = new St.Button({
            style_class: 'dinamic-control-button dinamic-primary-button',
            style: this._getButtonStyle(true),
            child: this._playPauseIcon,
            reactive: true,
            can_focus: true,
            track_hover: true,
        });
        playPauseButton.connect('clicked', () => this._onControl('PlayPause'));
        controls.add_child(playPauseButton);

        controls.add_child(this._makeButton('media-skip-forward-symbolic', () => this._onControl('Next')));
        return controls;
    }

    _makeButton(iconName, callback) {
        const icon = new St.Icon({
            icon_name: iconName,
            style: 'width: 16px; height: 16px;',
            icon_size: 16,
        });
        const button = new St.Button({
            style_class: 'dinamic-control-button dinamic-secondary-button',
            style: this._getButtonStyle(false),
            child: icon,
            reactive: true,
            can_focus: true,
            track_hover: true,
        });
        button.connect('clicked', callback);
        return button;
    }

    _createColumn(width, height = null) {
        const column = new St.BoxLayout({
            vertical: true,
            reactive: true,
            can_focus: true,
            track_hover: true,
        });

        if (width) column.set_width(width);
        if (height) column.set_height(height);

        return column;
    }

    _getPopupStyle() {
        return `
            background-color: ${THEME.background};
            border: 1px solid ${THEME.border};
            border-radius: ${THEME.radius}px;
            box-shadow: 0 22px 56px rgba(0, 0, 0, 0.66);
            width: ${CONFIG.width}px;
            height: ${CONFIG.height}px;
        `;
    }

    _getButtonStyle(primary) {
        const background = primary ? THEME.text : THEME.buttonBg;
        const border = primary ? `1px solid ${THEME.highlight}` : `1px solid ${THEME.buttonBorder}`;
        const color = primary ? '#050507' : THEME.text;
        const size = primary ? 44 : 38;

        return `
            padding: 0;
            color: ${color};
            border-radius: 99px;
            background-color: ${background};
            border: ${border};
            min-width: ${size}px;
            min-height: ${size}px;
        `;
    }

    _formatTime(usec) {
        if (!usec || usec <= 0) return '0:00';

        const sec = Math.floor(usec / 1_000_000);
        return `${Math.floor(sec / 60)}:${(sec % 60).toString().padStart(2, '0')}`;
    }
}
