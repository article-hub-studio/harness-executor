// builtin-servers/handlers/media.js — họ op `media.*`: transcode/thumbnail/metadata/audio/subtitle/playlist.
import { int, float, pick, picks, chance, hex, clamp, str, word, titleCase, cap, numOr } from '../util.js';

const AUDIO_EXT = /\.(mp3|wav|flac|aac|ogg|m4a)$/i;

function replaceExt(path, ext) {
  return String(path).replace(/\.[^./]+$/, '') + '.' + ext;
}

function baseName(path) {
  const parts = String(path).split('/');
  return parts[parts.length - 1] || 'clip';
}

export default {
  async transcode(args, r) {
    const src = str(args.src ?? args.input ?? args.file, '/media/input/source.mov');
    const target = str(args.target ?? args.format ?? args.preset, 'mp4');
    const resMap = { '2160p': [3840, 2160], '1080p': [1920, 1080], '720p': [1280, 720], '480p': [854, 480] };
    const key = Object.keys(resMap).find((k) => target.includes(k));
    const [width, height] = key ? resMap[key] : [1920, 1080];
    return {
      jobId: `tr_${hex(r, 8)}`,
      src,
      output: replaceExt(src, target.replace(/[^a-z0-9]/gi, '') || 'mp4'),
      format: target,
      width,
      height,
      durationSec: float(r, 30, 7200, 1),
      sizeBytes: int(r, 2_000_000, 4_000_000_000),
      status: 'completed',
      progress: 100,
    };
  },

  async thumbnail(args, r) {
    const src = str(args.src ?? args.input ?? args.file, '/media/input/clip.mp4');
    const at = Number(float(r, 0.5, numOr(args.at, 600), 2));
    return {
      imageRef: `thumbs/${baseName(src).replace(/\.[^.]+$/, '')}-${Math.round(at)}s.jpg`,
      src,
      timestampSec: at,
      width: 640,
      height: 360,
      bytes: int(r, 8_000, 220_000),
    };
  },

  async metadata(args, r) {
    const src = str(args.src ?? args.input ?? args.file, '/media/input/demo.mp4');
    const container = (src.match(/\.(\w{2,4})$/) || [])[1]?.toLowerCase() || pick(r, ['mp4', 'mkv', 'mov']);
    const durationSec = float(r, 15, 7200, 1);
    const sizeBytes = int(r, 400_000, 9_000_000_000);
    if (AUDIO_EXT.test(src)) {
      return {
        src, container, kind: 'audio',
        codec: pick(r, ['aac', 'mp3', 'flac']),
        sampleRateHz: pick(r, [44100, 48000, 96000]),
        channels: pick(r, [1, 2]),
        bitrateKbps: int(r, 96, 320),
        durationSec, sizeBytes,
      };
    }
    const profile = pick(r, [[3840, 2160], [1920, 1080], [1280, 720]]);
    return {
      src, container, kind: 'video',
      codec: pick(r, ['h264', 'h265', 'vp9']),
      width: profile[0],
      height: profile[1],
      fps: pick(r, [23.976, 24, 25, 30, 60]),
      bitrateKbps: int(r, 1200, 45_000),
      durationSec, sizeBytes,
    };
  },

  async normalize_audio(args, r) {
    const raw = Array.isArray(args.srcs) ? args.srcs : [args.srcs ?? args.src ?? args.input];
    const inputs = raw.map((s) => str(s, '/audio/track.wav'));
    const measured = float(r, -24, -9, 1);
    const targetLufs = -14;
    return {
      inputs,
      outputs: inputs.map((s) => replaceExt(s, 'wav').replace(/(\.\w+)$/, '-normalized$1')),
      measuredLufs: measured,
      targetLufs,
      gainDb: Number((targetLufs - measured).toFixed(1)),
      status: 'completed',
    };
  },

  async subtitle_extract(args, r) {
    const src = str(args.src ?? args.input ?? args.file, '/media/input/talk.mp4');
    const lang = str(args.lang ?? args.language, 'en');
    const pad = (n, w = 2) => String(n).padStart(w, '0');
    const fmt = (ms) => `00:${pad(Math.floor(ms / 60000))}:${pad(Math.floor((ms % 60000) / 1000))},${pad(ms % 1000, 3)}`;
    return {
      src,
      lang,
      cues: int(r, 120, 900),
      srtRef: `subs/${baseName(src).replace(/\.[^.]+$/, '')}.${lang}.srt`,
      preview: { index: 1, start: fmt(1200), end: fmt(3840), text: `${titleCase(r, 3)} mở đầu buổi nói chuyện.` },
    };
  },

  async playlist_curate(args, r) {
    const vibe = str(args.vibe, 'focus');
    const count = clamp(Math.round(Number(args.length) || 8), 3, 25);
    const tracks = Array.from({ length: count }, () => ({
      title: titleCase(r, int(r, 2, 3)),
      artist: `${cap(word(r))} ${cap(word(r))}`,
      durationSec: int(r, 140, 330),
      bpm: int(r, 84, 148),
    }));
    return {
      vibe,
      tracks,
      count,
      totalDurationSec: tracks.reduce((s, t) => s + t.durationSec, 0),
    };
  },
};
