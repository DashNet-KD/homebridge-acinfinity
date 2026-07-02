import { PlatformAccessory, CharacteristicValue } from 'homebridge';
import { ACInfinityPlatform } from '../platform';
import { ControllerPropertyKey, PortPropertyKey, PortControlKey, PortMode } from '../constants';
import * as fs from 'fs';

const TRACKER_FILE = '/var/lib/homebridge/fan_stage_tracker.json';
const FAN_COMMAND_FILE = '/opt/aq-controller/commands/fan_command.json';
const FAN_COMMAND_ARCHIVE_DIR = '/opt/aq-controller/commands/archive';
const FAN_LIVE_STATE_FILE = '/var/lib/homebridge/fan_live_state.json';

type StageTracker = {
  current_stage: number | null;
  current_started_at: number | null;
  last_stage: number | null;
  last_duration: number | null;
};

function stageForPercent(speed: number | null): number | null {
  if (speed === null || speed === undefined || Number.isNaN(speed)) {
    return null;
  }
  const v = Math.max(0, Math.min(100, Math.round(speed)));
  if (v == 0) return 0;
  if (v <= 39) return 1;
  if (v <= 59) return 2;
  if (v <= 69) return 3;
  if (v <= 89) return 4;
  return 5;
}

function loadTracker(): StageTracker {
  try {
    const raw = fs.readFileSync(TRACKER_FILE, 'utf8');
    const data = JSON.parse(raw);
    return {
      current_stage: data.current_stage ?? null,
      current_started_at: data.current_started_at ?? null,
      last_stage: data.last_stage ?? null,
      last_duration: data.last_duration ?? null,
    };
  } catch {
    return {
      current_stage: null,
      current_started_at: null,
      last_stage: null,
      last_duration: null,
    };
  }
}

function saveTracker(tracker: StageTracker): void {
  try {
    fs.writeFileSync(TRACKER_FILE, JSON.stringify(tracker));
  } catch {
    // ignore
  }
}

function noteStage(speedPercent: number | null): void {
  const stage = stageForPercent(speedPercent);
  if (stage === null) {
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  const tracker = loadTracker();

  if (tracker.current_stage === null || tracker.current_started_at === null) {
    tracker.current_stage = stage;
    tracker.current_started_at = now;
    saveTracker(tracker);
    return;
  }

  if (tracker.current_stage !== stage) {
    const duration = now - tracker.current_started_at;

    if (duration >= 10) {
      tracker.last_stage = tracker.current_stage;
      tracker.last_duration = duration;
    }

    tracker.current_stage = stage;
    tracker.current_started_at = now;
    saveTracker(tracker);
  }
}

export class ACInfinityFanPort {
  private readonly platform: ACInfinityPlatform;
  private readonly accessory: PlatformAccessory;
  private readonly deviceId: string;
  private readonly portNumber: number;
  private readonly informationService;
  private readonly fanService;
  private lastSetSpeed: number | null = null;
  private lastSetTime: number = 0;
  private commandPollTimer: NodeJS.Timeout | null = null;

  constructor(platform: ACInfinityPlatform, accessory: PlatformAccessory) {
    this.platform = platform;
    this.accessory = accessory;
    this.deviceId = accessory.context.deviceId;
    this.portNumber = accessory.context.portNumber;

    // Set accessory information
    this.informationService = this.accessory.getService(this.platform.Service.AccessoryInformation)!;
    const device = accessory.context.device;
    const port = accessory.context.port;
    
    this.informationService
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'AC Infinity')
      .setCharacteristic(this.platform.Characteristic.Model, 'Fan Port')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, `${device[ControllerPropertyKey.MAC_ADDR] || 'Unknown'}-Port${this.portNumber}`)
      .setCharacteristic(this.platform.Characteristic.FirmwareRevision, device[ControllerPropertyKey.SW_VERSION] || '1.0.0');

    // Create fan service
    const portName = port[PortPropertyKey.NAME] || `Port ${this.portNumber}`;
    this.fanService = this.accessory.getService(this.platform.Service.Fanv2) || 
      this.accessory.addService(this.platform.Service.Fanv2, portName);

    // Set up characteristics
    this.fanService.getCharacteristic(this.platform.Characteristic.Active)
      .onGet(this.getActive.bind(this))
      .onSet(this.setActive.bind(this));

    this.fanService.getCharacteristic(this.platform.Characteristic.CurrentFanState)
      .onGet(this.getState.bind(this));

    this.fanService.getCharacteristic(this.platform.Characteristic.TargetFanState)
      .onGet(this.getTargetState.bind(this))
      .onSet(this.setTargetState.bind(this));

    this.fanService.getCharacteristic(this.platform.Characteristic.RotationSpeed)
      .onGet(this.getSpeed.bind(this))
      .onSet(this.setSpeed.bind(this));

    if (this.portNumber === 1) {
      this.startCommandPoller();
    }
  }

  startCommandPoller(): void {
    this.platform.log.info('[FanPort] startCommandPoller armed for port ' + this.portNumber);
    if (this.commandPollTimer) {
      return;
    }
    this.commandPollTimer = setInterval(() => {
      this.processQueuedCommand().catch((error) => {
        this.platform.log.error('[FanPort] ERROR processing queued command:', error);
      });
    }, 2000);
  }

  writeLiveState(speedPercent: number): void {
    try {
      const payload = {
        ts: Math.floor(Date.now() / 1000),
        fan_speed: Number(speedPercent),
        fan_active: Number(speedPercent) > 0,
        fan_current_state: Number(speedPercent) > 0 ? 2 : 0,
        port_number: this.portNumber,
        device_id: this.deviceId,
      };
      fs.writeFileSync(FAN_LIVE_STATE_FILE, JSON.stringify(payload));
    } catch (error) {
      this.platform.log.error('[FanPort] ERROR writing live state file:', error);
    }
  }

  readQueuedCommand(): any | null {
    try {
      if (!fs.existsSync(FAN_COMMAND_FILE)) {
        return null;
      }
      const raw = fs.readFileSync(FAN_COMMAND_FILE, 'utf8');
      const data = JSON.parse(raw);
      if (!data || typeof data !== 'object') {
        return null;
      }
      return data;
    } catch {
      return null;
    }
  }

  archiveQueuedCommand(data: any): void {
    try {
      fs.mkdirSync(FAN_COMMAND_ARCHIVE_DIR, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const out = FAN_COMMAND_ARCHIVE_DIR + '/fan_command.plugin.' + ts + '.' + (data.target_speed ?? 'unknown') + '.json';
      fs.renameSync(FAN_COMMAND_FILE, out);
    } catch (error) {
      this.platform.log.error('[FanPort] ERROR archiving queued command:', error);
      try {
        fs.unlinkSync(FAN_COMMAND_FILE);
      } catch {
      }
    }
  }

  async processQueuedCommand(): Promise<void> {
    const data = this.readQueuedCommand();
    if (!data) {
      return;
    }

    if (!String(data.reason || '').startsWith('auto_surge') &&
        !String(data.reason || '').startsWith('python_ladder') && !String(data.reason || "").startsWith("manual_override")) {
      return;
    }

    if (String(data.device_id || '') !== String(this.deviceId)) {
      return;
    }

    if (Number(data.port_number || 0) !== this.portNumber) {
      return;
    }

    const targetPercent = Number(data.target_speed);
    if (![0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100].includes(targetPercent)) {
      this.platform.log.error('[FanPort] Queued command has invalid target_speed:', data.target_speed);
      this.archiveQueuedCommand(data);
      return;
    }

    const speed = Math.round(targetPercent / 10);
    const now = Date.now();
    const COALESCE_MS = 1500;
    if (this.lastSetSpeed === speed && (now - this.lastSetTime) < COALESCE_MS) {
      this.archiveQueuedCommand(data);
      return;
    }

    this.platform.log.info('[FanPort] Processing queued command (' + data.reason + ') to ' + speed + ' for port ' + this.portNumber);
    this.fanService.getCharacteristic(this.platform.Characteristic.RotationSpeed).setValue(speed * 10);

    await this.platform.queueRequest(async () => {
      if (this.platform.config.debug) {
        this.platform.log.debug('[FanPort] Executing queued speed change for port ' + this.portNumber + ' on device ' + this.deviceId + ' to ' + speed);
      }
      const device = this.accessory.context.device;
      return this.platform.client.setDeviceModeSettings(
        this.deviceId,
        this.portNumber,
        [[PortControlKey.ON_SPEED, speed]],
        device?.devType,
        device
      );
    });

    this.lastSetSpeed = speed;
    this.lastSetTime = Date.now();

    const port = this.accessory.context.port;
    if (port) {
      port[PortPropertyKey.SPEAK] = speed;
      port[PortPropertyKey.STATE] = speed > 0 ? 1 : 0;
      if (typeof PortPropertyKey.CURRENT_MODE !== 'undefined') {
        port[PortPropertyKey.CURRENT_MODE] = PortMode.ON;
      }
    }

    const device = this.accessory.context.device;
    if (device && device.deviceInfo) {
      device.deviceInfo.speak = speed;
      device.deviceInfo.curMode = PortMode.ON;
      device.deviceInfo.powerState = speed > 0 ? 1 : 0;
      if (Array.isArray(device.deviceInfo.ports)) {
        const idx = this.portNumber - 1;
        if (device.deviceInfo.ports[idx]) {
          device.deviceInfo.ports[idx].speak = speed;
          device.deviceInfo.ports[idx].loadState = speed > 0 ? 1 : 0;
          device.deviceInfo.ports[idx].curMode = PortMode.ON;
          device.deviceInfo.ports[idx].state = speed > 0 ? 1 : 0;
        }
      }
    }

    this.accessory.context.port = port;
    this.accessory.context.device = device;

    this.fanService.updateCharacteristic(this.platform.Characteristic.RotationSpeed, speed * 10);
    this.fanService.updateCharacteristic(
      this.platform.Characteristic.Active,
      speed > 0 ? this.platform.Characteristic.Active.ACTIVE : this.platform.Characteristic.Active.INACTIVE
    );
    this.fanService.updateCharacteristic(
      this.platform.Characteristic.CurrentFanState,
      speed > 0 ? this.platform.Characteristic.CurrentFanState.BLOWING_AIR : this.platform.Characteristic.CurrentFanState.IDLE
    );
    this.fanService.updateCharacteristic(
      this.platform.Characteristic.TargetFanState,
      this.platform.Characteristic.TargetFanState.MANUAL
    );
    this.platform.api.updatePlatformAccessories([this.accessory]);

    try {
      const devices = await this.platform.queueRequest(() => this.platform.client.getDevicesListAll());
      const freshDevice = Array.isArray(devices) ? devices.find((d: any) => String(d.devId) === String(this.deviceId)) : null;
      const freshPorts = freshDevice && freshDevice.deviceInfo && Array.isArray(freshDevice.deviceInfo.ports)
        ? freshDevice.deviceInfo.ports
        : null;
      const freshPort = freshPorts ? freshPorts.find((pp: any) => Number(pp.port) === this.portNumber) : null;

      if (freshDevice && freshPort) {
        this.accessory.context.device = freshDevice;
        this.accessory.context.port = freshPort;
        this.updatePort(freshPort);
        this.platform.log.info('[FanPort] Applied fresh polled port state after queued auto_surge for port ' + this.portNumber);
      } else {
        this.platform.log.error('[FanPort] Fresh poll after queued auto_surge did not find matching device/port for port ' + this.portNumber);
      }
    } catch (error) {
      this.platform.log.error('[FanPort] ERROR refreshing polled state after queued auto_surge for port ' + this.portNumber + ':', error);
    }

    if (this.portNumber === 1) {
      noteStage(speed * 10);
      this.writeLiveState(speed * 10);
    }

    this.platform.log.info('[FanPort] SUCCESS: queued command (' + data.reason + ') set speed to ' + speed + ' for port ' + this.portNumber);
    this.archiveQueuedCommand(data);
  }

  async getActive(): Promise<CharacteristicValue> {
    const port = this.accessory.context.port;
    if (!port) {
      return this.platform.Characteristic.Active.INACTIVE;
    }
    
    const state = port[PortPropertyKey.STATE];
    return state > 0 ? this.platform.Characteristic.Active.ACTIVE : this.platform.Characteristic.Active.INACTIVE;
  }

  async setActive(value: CharacteristicValue): Promise<void> {

  const active = value === this.platform.Characteristic.Active.ACTIVE;

  // DashNet patch: ignore Active=ON writes (prevents 10% blips)

  // HomeKit may emit Active=ON during RotationSpeed transitions. Writing Active=ON can cause a wake to 10%.

  // DashNet behavior: treat Active as read-only and ignore Active=ON. Use RotationSpeed to control speed.

  if (active) {

    this.platform.log.info(`[FanPort] Ignoring Active=ON write for port ${this.portNumber}; RotationSpeed is the source of truth.`);

    return;

  }


  // Active=OFF -> force speed 0

  const speed = 0;

  try {

    const device = this.accessory.context.device;

    await this.platform.client.setDeviceModeSettings(

      this.deviceId,

      this.portNumber,

      [[PortControlKey.ON_SPEED, speed]],

      device?.devType,

      device

    );

    this.lastSetSpeed = speed;

    this.lastSetTime = Date.now();

    if (this.portNumber === 1) {
      noteStage(0);
      this.writeLiveState(0);
    }

    this.platform.log.info(`[FanPort] SUCCESS: set speed 0 via Active=OFF for port ${this.portNumber}`);

  } catch (error) {

    this.platform.log.error(`[FanPort] ERROR setting speed 0 via Active=OFF for port ${this.portNumber}:`, error);

    throw new this.platform.api.hap.HapStatusError(-70402);

  }
}


  async getState(): Promise<CharacteristicValue> {
    const port = this.accessory.context.port;
    if (!port) {
      return this.platform.Characteristic.CurrentFanState.IDLE;
    }
    
    const state = port[PortPropertyKey.STATE];
    return state > 0 ? this.platform.Characteristic.CurrentFanState.BLOWING_AIR
      : this.platform.Characteristic.CurrentFanState.IDLE;
  }

  async getTargetState(): Promise<CharacteristicValue> {
    const port = this.accessory.context.port;
    if (!port) {
      return this.platform.Characteristic.TargetFanState.MANUAL;
    }

    const currentMode = port[PortPropertyKey.CURRENT_MODE];
    
    if (this.platform.config.debug) {
      this.platform.log.debug(`[FanPort] Getting target state for port ${this.portNumber}: currentMode=${currentMode}`);
    }
    
    // Check if it's in Auto mode (including VPD which is also auto-controlled)
    if (currentMode === PortMode.AUTO || currentMode === PortMode.VPD) {
      return this.platform.Characteristic.TargetFanState.AUTO;
    }
    
    // All other modes (On, Off, Timer, Cycle, Schedule) are considered manual
    return this.platform.Characteristic.TargetFanState.MANUAL;
  }

  async setTargetState(value: CharacteristicValue): Promise<void> {
    // In the future, this could be used to switch between manual/auto modes
    this.platform.log.debug(`Port ${this.portNumber} target state set to:`, value);
  }

  async getSpeed(): Promise<CharacteristicValue> {
    // If we recently set a speed, return that cached value to avoid stale data issues
    const CACHE_DURATION = 5000; // 5 seconds
    const now = Date.now();
    if (this.lastSetSpeed !== null && (now - this.lastSetTime) < CACHE_DURATION) {
      const cachedValue = this.lastSetSpeed * 10;
      this.platform.log.info(`[FanPort] GETSPEED: port ${this.portNumber} returning cached value ${cachedValue}% (set ${Math.round((now - this.lastSetTime) / 1000)}s ago)`);
      return cachedValue;
    }
    
    const port = this.accessory.context.port;
    if (!port) {
      this.platform.log.info(`[FanPort] GETSPEED: No port data available for port ${this.portNumber} - returning 0`);
      return 0;
    }
    
    // Use the 'speak' field which represents the actual current power level (0-10)
    const currentPower = port[PortPropertyKey.SPEAK] || 0;
    const homekitValue = currentPower * 10;
    
    this.platform.log.info(`[FanPort] GETSPEED: port ${this.portNumber} speak=${currentPower} -> HomeKit=${homekitValue}%`);
    
    if (this.platform.config.debug) {
      this.platform.log.debug(`[FanPort] Port data: ${JSON.stringify(port, null, 2)}`);
    }
    
    return homekitValue; // Convert 0-10 to 0-100
  }

  async setSpeed(value: CharacteristicValue): Promise<void> {
    this.platform.log.info(`[FanPort] SETSPEED CALLED: port ${this.portNumber} device ${this.deviceId} to ${Math.round(Number(value) / 10)} (HomeKit: ${value})`);
    
    try {
      const speed = Math.round(Number(value) / 10); // Convert 0-100 to 0-10
      // DashNet patch: coalesce duplicate speed writes (prevents racing)
      // If the requested speed matches what we just set very recently, skip the API call.
      const now = Date.now();
      const COALESCE_MS = 1500;
      if (this.lastSetSpeed === speed && (now - this.lastSetTime) < COALESCE_MS) {
        this.platform.log.info(`[FanPort] Coalescing duplicate SETSPEED to ${speed} for port ${this.portNumber} (within ${COALESCE_MS}ms)`);
        // Keep UI aligned with snapped speed
        this.fanService.updateCharacteristic(this.platform.Characteristic.RotationSpeed, speed * 10);
        return;
      }
              // DashNet patch: snap HomeKit slider
              this.fanService.updateCharacteristic(this.platform.Characteristic.RotationSpeed, speed * 10);
      if (this.platform.config.debug) {
        this.platform.log.debug(`[FanPort] Queueing speed change for port ${this.portNumber} on device ${this.deviceId} to ${speed} (HomeKit value: ${value})`);
      }
      
      // Use the platform's request queue to prevent simultaneous API calls
      await this.platform.queueRequest(async () => {
        if (this.platform.config.debug) {
          this.platform.log.debug(`[FanPort] Executing speed change for port ${this.portNumber} on device ${this.deviceId} to ${speed}`);
        }
        this.platform.log.info(`[FanPort] Making API call to set speed ${speed} for port ${this.portNumber}...`);
        const device = this.accessory.context.device;
        return this.platform.client.setDeviceModeSettings(
          this.deviceId, 
          this.portNumber, 
          [[PortControlKey.ON_SPEED, speed]], 
          device?.devType, 
          device
        );
      });
      
      this.platform.log.info(`[FanPort] SUCCESS: Speed set to ${speed} for port ${this.portNumber}`);
      
      // Cache the speed we just set to avoid reverting due to stale API data
      this.lastSetSpeed = speed;
      this.lastSetTime = Date.now();

      if (this.portNumber === 1) {
        noteStage(speed * 10);
        this.writeLiveState(speed * 10);
      }
      
      if (this.platform.config.debug) {
        this.platform.log.debug(`[FanPort] Cached speed ${speed} for port ${this.portNumber}`);
      }
    } catch (error) {
      this.platform.log.error(`[FanPort] ERROR setting speed for port ${this.portNumber}:`, error);
      if (error instanceof Error) {
        this.platform.log.error(`[FanPort] Error details - Name: ${error.name}, Message: ${error.message}`);
        if (error.stack) {
          this.platform.log.error(`[FanPort] Stack trace:`, error.stack);
        }
      }
      throw new this.platform.api.hap.HapStatusError(-70402);
    }
  }

  updatePort(port: any): void {
    // Update context
    this.accessory.context.port = port;
    
    // Update characteristics
    const state = port[PortPropertyKey.STATE] || 0;
    const isActive = state > 0;
    
    if (this.platform.config.debug) {
      const currentPower = port[PortPropertyKey.SPEAK] || 0;
      const currentMode = port[PortPropertyKey.CURRENT_MODE];
      this.platform.log.debug(`[FanPort] Updating port ${this.portNumber}: state=${state}, isActive=${isActive}, currentPower=${currentPower}, currentMode=${currentMode}`);
    }
    
    this.fanService.updateCharacteristic(
      this.platform.Characteristic.Active, 
      isActive ? this.platform.Characteristic.Active.ACTIVE : this.platform.Characteristic.Active.INACTIVE
    );
    
    this.fanService.updateCharacteristic(
      this.platform.Characteristic.CurrentFanState,
      isActive ? this.platform.Characteristic.CurrentFanState.BLOWING_AIR
        : this.platform.Characteristic.CurrentFanState.IDLE
    );
    
    // Update rotation speed to reflect actual current power
    const currentPower = port[PortPropertyKey.SPEAK] || 0;
    const currentPercent = currentPower * 10;
    this.fanService.updateCharacteristic(
      this.platform.Characteristic.RotationSpeed,
      currentPercent // Convert 0-10 to 0-100
    );

    if (this.portNumber === 1) {
      noteStage(currentPercent);
      this.writeLiveState(currentPercent);
    }
    
    // Update target fan state based on current mode
    const currentMode = port[PortPropertyKey.CURRENT_MODE];
    const isAutoMode = currentMode === PortMode.AUTO || currentMode === PortMode.VPD;
    this.fanService.updateCharacteristic(
      this.platform.Characteristic.TargetFanState,
      isAutoMode ? this.platform.Characteristic.TargetFanState.AUTO : this.platform.Characteristic.TargetFanState.MANUAL
    );
  }
}