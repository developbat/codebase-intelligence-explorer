import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { isWithin } from "./scanner";

const execFileAsync = promisify(execFile);
const MAX_VIDEO_BYTES = 4 * 1024 * 1024 * 1024;
const COMPRESS_TIMEOUT_MS = 15 * 60_000;

export interface VideoInfo {
  path: string;
  bytes: number;
  durationSeconds?: number;
  width?: number;
  height?: number;
  videoCodec?: string;
  audioCodec?: string;
}

export interface VideoCompressResult {
  input: VideoInfo;
  output: VideoInfo;
  savedBytes: number;
  savedPercent: number;
  command: string;
}

function safeRelative(value: string): string {
  const normalized = value.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
  if (!normalized || normalized.split("/").some((part) => part === "..")) {
    throw new Error("Video path is outside the project.");
  }
  return normalized;
}

async function resolveExisting(rootPath: string, value: string): Promise<{ absolute: string; relative: string }> {
  const relative = safeRelative(value);
  const absolute = path.resolve(rootPath, relative);
  if (!isWithin(rootPath, absolute)) throw new Error("Video path is outside the project.");
  const realRoot = await fs.realpath(rootPath);
  const realFile = await fs.realpath(absolute).catch(() => {
    throw new Error("Video file does not exist.");
  });
  if (!isWithin(realRoot, realFile)) throw new Error("Video path is outside the project.");
  const stat = await fs.stat(realFile);
  if (!stat.isFile()) throw new Error("Video path is not a file.");
  if (stat.size > MAX_VIDEO_BYTES) throw new Error("Video is larger than the 4 GB limit.");
  return { absolute: realFile, relative };
}

async function probeVideo(absolute: string, relative: string): Promise<VideoInfo> {
  const stat = await fs.stat(absolute);
  const result = await execFileAsync(
    "ffprobe",
    [
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_streams",
      "-show_format",
      absolute,
    ],
    { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 },
  ).catch(() => {
    throw new Error("ffprobe is not available or the file is not a readable video.");
  });
  const parsed = JSON.parse(result.stdout || "{}") as {
    streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number; duration?: string }[];
    format?: { duration?: string; size?: string };
  };
  const video = parsed.streams?.find((stream) => stream.codec_type === "video");
  const audio = parsed.streams?.find((stream) => stream.codec_type === "audio");
  return {
    path: relative,
    bytes: stat.size,
    durationSeconds: Number(parsed.format?.duration ?? video?.duration) || undefined,
    width: video?.width,
    height: video?.height,
    videoCodec: video?.codec_name,
    audioCodec: audio?.codec_name,
  };
}

export async function compressVideo(
  rootPath: string,
  input: {
    path: string;
    outputPath?: string;
    maxWidth?: number;
    crf?: number;
    preset?: "ultrafast" | "veryfast" | "fast" | "medium" | "slow";
  },
): Promise<VideoCompressResult> {
  const source = await resolveExisting(rootPath, input.path);
  const before = await probeVideo(source.absolute, source.relative);
  const extension = path.extname(source.relative).toLowerCase();
  if (![".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi", ".gif"].includes(extension)) {
    throw new Error("Unsupported video extension.");
  }
  const outputRelative = input.outputPath
    ? safeRelative(input.outputPath)
    : `${source.relative.replace(/\.[^.]+$/, "")}-compressed.mp4`;
  if (!/\.mp4$/i.test(outputRelative)) {
    throw new Error("Compressed output must be an .mp4 file.");
  }
  const outputAbsolute = path.resolve(rootPath, outputRelative);
  if (!isWithin(rootPath, outputAbsolute)) throw new Error("Output path is outside the project.");
  if (outputAbsolute === source.absolute) {
    throw new Error("Output path must differ from the input path.");
  }
  await fs.mkdir(path.dirname(outputAbsolute), { recursive: true });
  const maxWidth = Math.max(160, Math.min(7680, Math.round(input.maxWidth ?? 1280)));
  const crf = Math.max(16, Math.min(40, Math.round(input.crf ?? 28)));
  const preset = input.preset ?? "medium";
  const args = [
    "-y",
    "-i",
    source.absolute,
    "-vf",
    `scale='min(${maxWidth},iw)':-2`,
    "-c:v",
    "libx264",
    "-crf",
    String(crf),
    "-preset",
    preset,
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-movflags",
    "+faststart",
    outputAbsolute,
  ];
  await execFileAsync("ffmpeg", args, {
    timeout: COMPRESS_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Video compression failed.";
    throw new Error(`ffmpeg failed: ${message.slice(-1_200)}`);
  });
  const after = await probeVideo(outputAbsolute, path.relative(rootPath, outputAbsolute));
  const savedBytes = Math.max(0, before.bytes - after.bytes);
  return {
    input: before,
    output: after,
    savedBytes,
    savedPercent: before.bytes > 0 ? Math.round((savedBytes / before.bytes) * 1000) / 10 : 0,
    command: `ffmpeg -i "${source.relative}" -vf "scale='min(${maxWidth},iw)':-2" -crf ${crf} -preset ${preset} "${outputRelative}"`,
  };
}


export interface VideoTransformInput {
  path: string;
  outputPath?: string;
  action: "trim" | "convert" | "resize" | "extract-audio";
  startSeconds?: number;
  endSeconds?: number;
  format?: "mp4" | "webm" | "mov" | "gif" | "mp3" | "m4a";
  maxWidth?: number;
}

export interface VideoTransformResult {
  input: VideoInfo;
  output: VideoInfo;
  command: string;
}

export async function transformVideo(
  rootPath: string,
  input: VideoTransformInput,
): Promise<VideoTransformResult> {
  const source = await resolveExisting(rootPath, input.path);
  const before = await probeVideo(source.absolute, source.relative);
  const base = source.relative.replace(/\.[^.]+$/, "");
  const format =
    input.format ??
    (input.action === "extract-audio"
      ? "mp3"
      : input.action === "resize" || input.action === "trim"
        ? "mp4"
        : "mp4");
  const outputRelative = safeRelative(
    input.outputPath || `${base}-${input.action}.${format}`,
  );
  const outputAbsolute = path.resolve(rootPath, outputRelative);
  if (!isWithin(rootPath, outputAbsolute)) throw new Error("Output path is outside the project.");
  if (outputAbsolute === source.absolute) throw new Error("Output path must differ from the input path.");
  await fs.mkdir(path.dirname(outputAbsolute), { recursive: true });

  const args: string[] = ["-y"];
  if (input.action === "trim") {
    const start = Math.max(0, Number(input.startSeconds) || 0);
    const end = Math.max(start + 0.1, Number(input.endSeconds) || (before.durationSeconds ?? start + 5));
    args.push("-ss", String(start), "-to", String(end));
  }
  args.push("-i", source.absolute);

  if (input.action === "extract-audio") {
    args.push("-vn");
    if (format === "m4a") args.push("-c:a", "aac", "-b:a", "192k");
    else args.push("-c:a", "libmp3lame", "-q:a", "4");
  } else if (format === "gif") {
    const width = Math.max(160, Math.min(1280, Number(input.maxWidth) || 640));
    args.push("-vf", `fps=12,scale=${width}:-1:flags=lanczos`);
  } else if (format === "webm") {
    args.push("-c:v", "libvpx-vp9", "-crf", "32", "-b:v", "0", "-c:a", "libopus");
  } else {
    const width = Math.max(160, Math.min(7680, Number(input.maxWidth) || 0));
    if (input.action === "resize" || width > 0) {
      args.push("-vf", `scale='min(${width || 1920},iw)':-2`);
    }
    args.push("-c:v", "libx264", "-crf", "23", "-preset", "medium");
    if (format === "mp4" || format === "mov") args.push("-c:a", "aac", "-b:a", "160k");
    if (format === "mp4") args.push("-movflags", "+faststart");
  }
  args.push(outputAbsolute);

  const command = `ffmpeg ${args
    .map((value) => (/\s/.test(value) ? `"${value}"` : value))
    .join(" ")}`;
  await execFileAsync("ffmpeg", args, {
    timeout: COMPRESS_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Video transform failed.";
    throw new Error(`ffmpeg failed: ${message.slice(-1_200)}`);
  });
  const after = await probeVideo(outputAbsolute, path.relative(rootPath, outputAbsolute));
  return { input: before, output: after, command };
}
