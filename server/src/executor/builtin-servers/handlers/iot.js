// builtin-servers/handlers/iot.js — họ op `iot.*`: device/sensor/toggle/scene (nhà thông minh mô phỏng).
import { int, float, pick, picks, chance, hex, agoMs, str, word, cap } from '../util.js';

const DEVICE_TYPES = ['light', 'thermostat', 'sensor', 'camera', 'plug', 'speaker', 'lock'];
const ROOMS = ['living-room', 'bedroom', 'kitchen', 'garage', 'office'];

export default {
  async device_list(args, r) {
    const room = str(args.room, null);
    const devices = Array.from({ length: int(r, 3, 7) }, () => {
      const type = pick(r, DEVICE_TYPES);
      const devRoom = room ?? pick(r, ROOMS);
      const online = chance(r, 0.85);
      return {
        deviceId: `dev-${hex(r, 6)}`,
        name: `${cap(devRoom)} ${cap(type)}`,
        type,
        room: devRoom,
        online,
        batteryPct: online ? int(r, 8, 100) : null,
        lastSeenMs: agoMs(r, 0.5),
      };
    });
    return { devices, online: devices.filter((d) => d.online).length, total: devices.length };
  },

  async sensor_read(args, r) {
    const device = str(args.device ?? args.deviceId, 'dev-000000');
    const metric = str(args.metric ?? args.sensor, pick(r, ['temperature', 'humidity', 'co2', 'brightness']));
    let value;
    let unit;
    if (metric.includes('temp')) { value = float(r, 17.5, 29.5, 1); unit = '°C'; }
    else if (metric.includes('humid')) { value = float(r, 31, 69, 1); unit = '%'; }
    else if (metric.includes('co2')) { value = int(r, 395, 880); unit = 'ppm'; }
    else if (metric.includes('pm25')) { value = int(r, 4, 60); unit = 'µg/m³'; }
    else if (metric.includes('bright') || metric.includes('lux')) { value = int(r, 40, 650); unit = 'lux'; }
    else if (metric.includes('battery')) { value = int(r, 9, 100); unit = '%'; }
    else if (metric.includes('motion')) { value = chance(r, 0.4); unit = null; }
    else { value = float(r, 0, 100, 1); unit = 'unit'; }
    return { deviceId: device, metric, value, unit, readAtMs: agoMs(r, 0.02), quality: 'good' };
  },

  async toggle_device(args, r) {
    const on = Boolean(args.on ?? args.state ?? true);
    return {
      deviceId: str(args.device ?? args.deviceId, 'dev-000000'),
      state: on ? 'on' : 'off',
      previousState: on ? 'off' : 'on',
      changedAtMs: agoMs(r, 0.001),
      source: 'mcp-sim',
    };
  },

  async scene_activate(args, r) {
    const scene = str(args.scene, 'movie-night');
    const actions = Array.from({ length: int(r, 2, 4) }, () => ({
      deviceId: `dev-${hex(r, 6)}`,
      action: pick(r, ['set_dim', 'power_on', 'set_temperature', 'close_blinds', 'play_media']),
      value: String(int(r, 10, 90)),
    }));
    return {
      scene,
      active: true,
      devicesAffected: actions.length,
      actions,
      activatedAtMs: agoMs(r, 0.001),
    };
  },
};
