/// <reference types="web-bluetooth" />

import { EventEmitter } from 'events'

export enum GearControllerButton {
    TRIGGER = 'trigger',
    TOUCHPAD = 'touchpad',
    BACK = 'back',
    HOME = 'home',
    VOL_UP = 'volUp',
    VOL_DOWN = 'volDown'
}

export interface TouchPadPosition {
    x: number
    y: number
}

export declare interface GearVRController {
    on(event: 'buttondown', listener: (button: GearControllerButton) => void): this
    on(event: 'buttonup', listener: (button: GearControllerButton) => void): this
    on(event: 'touch', listener: (position: TouchPadPosition) => void): this
    on(event: 'touchrelease', listener: () => void): this
    on(event: 'connect', listener: () => void): this
    on(event: 'disconnect', listener: () => void): this
    on(event: string, listener: Function): this
}

export class GearVRController extends EventEmitter {
    protected static readonly UUIDs = {
        PRIMARY_SERVICE: "4f63756c-7573-2054-6872-65656d6f7465",
        WRITE_CHARACTERISTIC: "c8c51726-81bc-483b-a052-f7a14ea3d282",
        NOTIFY_CHARACTERISTIC: "c8c51726-81bc-483b-a052-f7a14ea3d281"
    }
    protected static readonly Commands = {
        POWER_OFF: [0, 0],
        SENSORS_MODE: [1, 0],
        KEEP_ALIVE: [4, 0],
        VR_MODE: [8, 0]
    }
    protected readonly _bluetoothDeviceFilters = [
        {namePrefix: 'Gear VR'}
    ]

    protected _gattServer: BluetoothRemoteGATTServer | null = null
    protected _primaryService: BluetoothRemoteGATTService | null = null
    protected _notifyCharacteristic: BluetoothRemoteGATTCharacteristic | null = null
    protected _writeCharacteristic: BluetoothRemoteGATTCharacteristic | null = null

    protected _noDataTimeout: number | null = null

    buttonStates: Map<GearControllerButton, boolean> = new Map()
    touchPosition: TouchPadPosition | null = null
    get touched() {
        return this.touchPosition!=null
    }

    transient: boolean = false

    async connect(): Promise<void> {
        this._ensureNotTransient()
        this.transient = true
        try {
            this._resetStates()

            if (navigator.bluetooth===undefined) {
                throw new Error("Browser does not support Bluetooth")
            }
            if (!(await navigator.bluetooth.getAvailability())) {
                throw new Error("Bluetooth not available")
            }
            const device: BluetoothDevice = await navigator.bluetooth.requestDevice({ filters: this._bluetoothDeviceFilters,
                optionalServices: [GearVRController.UUIDs.PRIMARY_SERVICE] })
            if (device.gatt===undefined) {
                throw new Error("Bluetooth GATT not available")
            }
            console.info("User chose device, connecting...")

            this._gattServer = await device.gatt.connect()
            console.debug("GATT server ready")
            
            this._primaryService = await this._gattServer.getPrimaryService(GearVRController.UUIDs.PRIMARY_SERVICE)
            this._notifyCharacteristic = await this._primaryService.getCharacteristic(GearVRController.UUIDs.NOTIFY_CHARACTERISTIC)
            this._writeCharacteristic = await this._primaryService.getCharacteristic(GearVRController.UUIDs.WRITE_CHARACTERISTIC)
            console.debug("Services & characteristics ready")

            this._notifyCharacteristic.addEventListener('characteristicvaluechanged', this._onNotificationReceived.bind(this))
            await this._notifyCharacteristic.startNotifications()
            console.debug("Started notifications")

            await this._subscribeToSensors()
            console.debug("Subscribed to sensors.")
            console.info("Controller connected")
            this.emit('connect')
        } finally {
            this.transient = false
        }
    }

    get connected(): boolean {
        return (this._writeCharacteristic!=null &&
            this._notifyCharacteristic!=null &&
            this._primaryService!=null &&
            this._gattServer!=null &&
            this._gattServer.connected)
    }

    protected _ensureConnected(): void {
        if (!this.connected) {
            throw new Error("Not connected!")
        }
    }
    protected _ensureNotTransient(): void {
        // MAYBE TODO: maybe make it state machine and never throw exception in this case
        // instead, reconnect after disconnecting or disconnect after connecting
        if (this.transient) {
            throw new Error("Now changing state! Try again later.")
        }
    }

    async disconnect(connectionDead: boolean = false): Promise<void> {
        this._ensureNotTransient()
        if (this._noDataTimeout!=null) {
            window.clearTimeout(this._noDataTimeout)
            this._noDataTimeout = null
        }
        this.transient = true
        try {
            if (!connectionDead) {
                await this._runCommand(GearVRController.Commands.POWER_OFF)
            }
        } finally {
            try {
                this._ensureConnected()
                this._gattServer!.disconnect()
            } finally {
                this._resetStates()
                this._writeCharacteristic = null
                this._notifyCharacteristic = null
                this._primaryService = null
                this._gattServer = null
                this.transient = false
                console.info("Controller disconnected")
                this.emit('disconnect')
            }
        }
    }

    protected async _runCommand(opcode: number[]): Promise<void> {
        this._ensureConnected()
        await this._writeCharacteristic!.writeValue(new Uint8Array(opcode))
    }

    protected _resetStates(): void {
        for (let btn of Object.values(GearControllerButton)) {
            this.buttonStates.set(btn, false)
        }
        this.touchPosition = null
    }

    protected async _subscribeToSensors(): Promise<void> {
        await this._runCommand(GearVRController.Commands.VR_MODE)
        await this._runCommand(GearVRController.Commands.SENSORS_MODE)
    }

    protected _onNotificationReceived(e: any): void {
        if (this._noDataTimeout!=null) {
            window.clearTimeout(this._noDataTimeout)
        }
        this._noDataTimeout = window.setTimeout(() => {
            this._noDataTimeout = null
            console.warn("No data from controller!")
            this.disconnect(true)
        }, 500)
        const { buffer } = e.target.value
        const bytes = new Uint8Array(buffer)

        // handle buttons:
        const s = (button: GearControllerButton, bit_offset: number): void => {
            this._setButtonState(button, (bytes[58] & (1 << bit_offset)) != 0)
        }
        s(GearControllerButton.TRIGGER, 0)
        s(GearControllerButton.HOME, 1)
        s(GearControllerButton.BACK, 2)
        s(GearControllerButton.TOUCHPAD, 3)
        s(GearControllerButton.VOL_UP, 4)
        s(GearControllerButton.VOL_DOWN, 5)

        // get raw coordinates in range 0..315:
        const rawX = ((bytes[54] & 0xF) << 6) | ((bytes[55] & 0xFC) >> 2)
        const rawY = ((bytes[55] & 0x3) << 8) |  (bytes[56] & 0xFF)

        if (rawX && rawY) {
            // convert to range -1..1:
            this.touchPosition = {x: rawX / 157.5 - 1.0, y: rawY / 157.5 - 1.0}
            this.emit('touch', this.touchPosition)
        } else {
            const wasTouched = this.touched
            this.touchPosition = null
            if (wasTouched) {
                this.emit('touchrelease')
            }
        }
    }

    protected _setButtonState(button: GearControllerButton, pressed: boolean): void {
        let prev: boolean = this.buttonStates.get(button) || false
        if (prev != pressed) {
            if (pressed) {
                this.emit('buttondown', button)
            } else {
                this.emit('buttonup', button)
            }
            this.buttonStates.set(button, pressed)
        }
    }
}
