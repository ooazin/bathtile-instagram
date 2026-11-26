// Renders a short slow-camera video from still images: each shot glides from one crop to another,
// shots cross-fade, and an optional title fades in at the end. Output is an Instagram-ready MP4.
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas';
import ffmpeg from 'ffmpeg-static';

const FONT_DIR = path.resolve('node_modules/pretendard/dist/public/static');
GlobalFonts.registerFromPath(path.join(FONT_DIR, 'Pretendard-Light.otf'), 'PretendardLight');
GlobalFonts.registerFromPath(path.join(FONT_DIR, 'Pretendard-Regular.otf'), 'PretendardRegular');

const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

/**
 * @param {object} video  { width, height, fps, fade, shots: [{ file, from, to, seconds }], title?, line?, titleSeconds? }
 * @param {string} sourceDir  base folder for shot files
 * @param {string} outFile  path of the MP4 to write
 */
export async function renderVideo(video, sourceDir, outFile) {
  const { width = 1080, height = 1350, fps = 30, fade = 0.8 } = video;
  const shots = [];
  let start = 0;
  for (const s of video.shots) {
    const img = await loadImage(fs.readFileSync(path.resolve(sourceDir, s.file)));
    shots.push({ ...s, img, start, end: start + s.seconds });
    start += s.seconds - fade;
  }
  const total = start + fade;
  const frames = Math.round(total * fps);

  // Same logo size and place as the still slides.
  const logo = await loadImage(fs.readFileSync(path.resolve('assets', video.logo ?? 'logo-white.png')));
  const logoW = 84;
  const logoH = (logo.height * logoW) / logo.width;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  const proc = spawn(ffmpeg, [
    '-y', '-loglevel', 'error',
    '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${width}x${height}`, '-r', String(fps), '-i', '-',
    // A silent stereo track keeps the file within Instagram's video spec.
    '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
    '-shortest', '-c:v', 'libx264', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-preset', 'slow',
    // Stone texture is noisy, so the bitrate is capped to keep files small enough for the repo.
    '-crf', '20', '-maxrate', '7M', '-bufsize', '14M',
    '-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart', outFile,
  ], { stdio: ['pipe', 'inherit', 'inherit'] });
  const done = new Promise((resolve, reject) => proc.on('close', (code) => (code ? reject(new Error(`ffmpeg exited ${code}`)) : resolve())));

  for (let f = 0; f < frames; f++) {
    const t = f / fps;
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#212328';
    ctx.fillRect(0, 0, width, height);
    for (const s of shots) {
      if (t < s.start || t > s.end) continue;
      const p = ease(Math.min(1, (t - s.start) / s.seconds));
      const [sx, sy, sw, sh] = mix(s.from, s.to, p);
      const fadeIn = s.start === 0 ? 1 : Math.min(1, (t - s.start) / fade);
      ctx.globalAlpha = fadeIn;
      ctx.drawImage(s.img, sx, sy, sw, sh, 0, 0, width, height);
    }
    if (video.title) {
      const a = Math.max(0, Math.min(1, (t - (total - (video.titleSeconds ?? 2))) / 0.8));
      if (a > 0) {
        ctx.globalAlpha = a * 0.35;
        const g = ctx.createLinearGradient(0, height - 420, 0, height);
        g.addColorStop(0, 'rgba(0,0,0,0)');
        g.addColorStop(1, 'rgba(0,0,0,1)');
        ctx.fillStyle = g;
        ctx.fillRect(0, height - 420, width, 420);
        ctx.globalAlpha = a;
        ctx.fillStyle = '#f4f2ed';
        ctx.font = '60px PretendardLight';
        ctx.fillText(video.title, 64, height - 150);
        if (video.line) {
          ctx.font = '24px PretendardRegular';
          ctx.fillText(video.line, 64, height - 100);
        }
      }
    }
    ctx.globalAlpha = 0.5;
    ctx.drawImage(logo, width - 64 - logoW, height - 56 - logoH, logoW, logoH);
    const buf = Buffer.from(ctx.getImageData(0, 0, width, height).data.buffer);
    if (!proc.stdin.write(buf)) await new Promise((resolve) => proc.stdin.once('drain', resolve));
  }
  proc.stdin.end();
  await done;
  return { seconds: total, frames };
}
