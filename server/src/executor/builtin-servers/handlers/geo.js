// builtin-servers/handlers/geo.js — họ op `geo.*`: route/geocode/matrix/poi.
import { int, float, pick, picks, chance, hex, clamp, str, word, titleCase, cap, numOr } from '../util.js';

const CITIES = ['Ha Noi', 'Da Nang', 'Ho Chi Minh', 'Singapore', 'Tokyo', 'Berlin', 'Lisbon'];
const STREETS = ['St', 'Ave', 'Blvd', 'Rd'];

const SPEED = { driving: [28, 70], cycling: [15, 25], walking: [4.2, 5.5], transit: [20, 45] };

export default {
  async route(args, r) {
    const from = str(args.from ?? args.origin, 'Ha Noi');
    const to = str(args.to ?? args.destination, 'Da Nang');
    const mode = str(args.mode, pick(r, Object.keys(SPEED)));
    const distanceKm = float(r, 1.2, 940, 1);
    const [lo, hi] = SPEED[mode] ?? SPEED.driving;
    const durationMin = Math.max(1, Math.round((distanceKm / float(r, lo, hi)) * 60));
    const nSteps = int(r, 4, 7);
    const parts = [];
    let used = 0;
    for (let i = 0; i < nSteps - 1; i++) {
      const km = Number(((distanceKm - used) * (0.15 + r() * 0.35)).toFixed(1));
      parts.push(Math.min(km, Math.max(0.1, distanceKm - used - 0.2 * (nSteps - i))));
      used += parts[parts.length - 1];
    }
    parts.push(Number(Math.max(0.1, distanceKm - used).toFixed(1)));
    const TPL = [
      (s) => `Đi ${pick(r, ['đông', 'tây', 'bắc', 'nam'])} trên ${titleCase(r, 1)} ${pick(r, STREETS)}`,
      () => `Rẽ trái vào ${titleCase(r, 2)} Rd`,
      () => `Giữ làn theo chỉ dẫn sang ${titleCase(r, 1)} Expy`,
      () => `Nhập đường QL${int(r, 1, 51)}`,
      (s) => `Tiếp tục ${float(r, 0.8, 12, 1)} km trên ${titleCase(r, 1)} Blvd`,
    ];
    const steps = parts.map((km, i) => ({
      instruction: i === 0
        ? `Khởi hành từ ${from}`
        : i === parts.length - 1
          ? `Đến nơi gần ${to}`
          : TPL[(i - 1) % TPL.length](r),
      km,
    }));
    return { from, to, mode, distanceKm, durationMin, steps };
  },

  async geocode(args, r) {
    const address = str(args.address ?? args.query, '21 Hang Bai, Ha Noi');
    return {
      address,
      lat: float(r, -38, 55, 4),
      lng: float(r, -110, 125, 4),
      formatted: `${int(r, 2, 480)} ${titleCase(r, 1)} ${pick(r, STREETS)}, ${pick(r, CITIES)}`,
      country: pick(r, ['VN', 'SG', 'JP', 'DE', 'PT']),
      placeId: `gp_${hex(r, 10)}`,
      confidence: float(r, 0.62, 0.98),
    };
  },

  async distance_matrix(args, r) {
    const norm = (arr) => (Array.isArray(arr) ? arr : [arr]).slice(0, 5).map((v) => String(v));
    const origins = norm(args.origins ?? args.from);
    const destinations = norm(args.destinations ?? args.to);
    const distanceKm = origins.map(() => destinations.map(() => float(r, 0.4, 1800, 1)));
    const durationMin = distanceKm.map((row) =>
      row.map((km) => Math.max(1, Math.round(km / float(r, 18, 65))))
    );
    return { originCount: origins.length, destinationCount: destinations.length, units: 'metric', distanceKm, durationMin };
  },

  async poi_search(args, r) {
    const lat = numOr(args.lat, 21.0278);
    const lng = numOr(args.lng, 105.8342);
    const kind = str(args.kind ?? args.query, 'cafe');
    const results = [];
    for (let i = 0, n = int(r, 3, 8); i < n; i++) {
      results.push({
        name: `${cap(word(r))} ${cap(kind)}`,
        category: kind,
        rating: float(r, 3.1, 4.9, 1),
        reviews: int(r, 12, 4200),
        distanceM: int(r, 30, 4500),
        address: `${int(r, 1, 300)} ${titleCase(r, 1)} ${pick(r, STREETS)}, ${pick(r, CITIES)}`,
      });
    }
    results.sort((a, b) => a.distanceM - b.distanceM);
    return { location: { lat, lng }, kind, results, total: results.length };
  },
};
