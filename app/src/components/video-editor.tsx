"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FFmpeg } from "@ffmpeg/ffmpeg";
import { v4 as uuid } from "uuid";
import { Download, Music4, Scissors, Share2, VideoIcon } from "lucide-react";
import { clamp, cn, formatTime } from "@/lib/utils";

type Segment = {
  id: string;
  label: string;
  start: number;
  end: number;
};

const TARGET_DURATION = 30;
const MAX_SEGMENTS = 5;

type RenderState = "idle" | "preparing" | "rendering" | "completed" | "error";

type RenderResult = {
  url: string;
  downloadName: string;
  duration: number;
};

const createSegment = (index: number, duration: number): Segment => {
  const span = Math.min(8, duration / (index + 1) || 5);
  const startSeed = clamp(index * span * 0.9, 0, Math.max(duration - span, 0));
  return {
    id: uuid(),
    label: `Highlight ${index + 1}`,
    start: Number(startSeed.toFixed(2)),
    end: Number(clamp(startSeed + span, 0, duration).toFixed(2)),
  };
};

type FetchFileFn = (
  input: string | URL | Blob | ArrayBuffer | Uint8Array,
) => Promise<Uint8Array>;

const useFFmpeg = () => {
  const ffmpegRef = useRef<FFmpeg | null>(null);
  const fetchFileRef = useRef<FetchFileFn | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  const load = useCallback(async () => {
    if (ffmpegRef.current) {
      if (!fetchFileRef.current) {
        const module = await import("@ffmpeg/ffmpeg");
        fetchFileRef.current = (
          module as unknown as { fetchFile: FetchFileFn }
        ).fetchFile;
      }
      setIsReady(true);
      return;
    }
    if (isLoading) return;
    setIsLoading(true);
    try {
      const module = await import("@ffmpeg/ffmpeg");
      const { fetchFile, createFFmpeg } = module as unknown as {
        fetchFile: FetchFileFn;
        createFFmpeg: (options: {
          log: boolean;
          corePath?: string;
        }) => FFmpeg;
      };
      fetchFileRef.current = fetchFile;
      const ffmpeg = createFFmpeg({
        log: false,
        corePath:
          typeof window !== "undefined"
            ? "https://unpkg.com/@ffmpeg/core@0.12.6/dist/ffmpeg-core.js"
            : undefined,
      });
      await ffmpeg.load();
      ffmpegRef.current = ffmpeg;
      setIsReady(true);
    } catch (error) {
      setIsReady(false);
      throw error;
    } finally {
      setIsLoading(false);
    }
  }, [isLoading]);

  return {
    ffmpegRef,
    fetchFileRef,
    isReady,
    load,
  };
};

const fadeDurations = (segments: Segment[]) => {
  if (segments.length <= 1) return [];
  return segments.map((_, idx) => {
    if (idx === segments.length - 1) return 0;
    return 0.6;
  });
};

const createConcatenationFilter = (
  segments: Segment[],
  preserveAudio: boolean,
  eq: { brightness: number; contrast: number; saturation: number },
  fades: number[],
) => {
  const videoParts: string[] = [];
  const audioParts: string[] = [];
  segments.forEach((segment, idx) => {
    const fade = fades[idx];
    const fadeOut = fade ? `,fade=t=out:st=${segment.end - segment.start - fade}:d=${fade}` : "";
    videoParts.push(
      `[0:v]trim=start=${segment.start}:end=${segment.end},setpts=PTS-STARTPTS,scale=1080:-2:force_original_aspect_ratio=increase,crop=1080:1920,eq=brightness=${eq.brightness}:contrast=${eq.contrast}:saturation=${eq.saturation}${fadeOut}[v${idx}]`,
    );
    if (preserveAudio) {
      const audioFade = fade
        ? `,afade=t=out:st=${segment.end - segment.start - fade}:d=${fade}`
        : "";
      audioParts.push(
        `[0:a]atrim=start=${segment.start}:end=${segment.end},asetpts=PTS-STARTPTS${audioFade}[a${idx}]`,
      );
    }
  });

  const concatVideo = segments.map((_, idx) => `[v${idx}]`).join("");
  const concatAudio =
    preserveAudio && audioParts.length > 0
      ? segments.map((_, idx) => `[a${idx}]`).join("")
      : "";

  const concat = preserveAudio
    ? `${concatVideo}${concatAudio}concat=n=${segments.length}:v=1:a=1[vout][aout]`
    : `${concatVideo}concat=n=${segments.length}:v=1:a=0[vout]`;

  return [...videoParts, ...audioParts, concat];
};

const distributeSegmentsToTarget = (
  segments: Segment[],
  targetDuration: number,
) => {
  if (!segments.length) return segments;
  const totalSelected = segments.reduce(
    (acc, segment) => acc + (segment.end - segment.start),
    0,
  );
  if (totalSelected <= targetDuration) {
    return segments;
  }

  const ratio = targetDuration / totalSelected;
  return segments.map((segment) => {
    const length = segment.end - segment.start;
    const newLength = length * ratio;
    return {
      ...segment,
      end: Number((segment.start + newLength).toFixed(2)),
    };
  });
};

export function VideoEditor() {
  const { ffmpegRef, fetchFileRef, isReady, load } = useFFmpeg();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoDuration, setVideoDuration] = useState(0);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [renderState, setRenderState] = useState<RenderState>("idle");
  const [renderProgress, setRenderProgress] = useState(0);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [renderResult, setRenderResult] = useState<RenderResult | null>(null);
  const [includeOriginalAudio, setIncludeOriginalAudio] = useState(true);
  const [musicFile, setMusicFile] = useState<File | null>(null);
  const [musicVolume, setMusicVolume] = useState(0.55);
  const [brightness, setBrightness] = useState(0.05);
  const [contrast, setContrast] = useState(1.05);
  const [saturation, setSaturation] = useState(1.15);

  useEffect(() => {
    if (!videoFile) {
      setSegments([]);
      setRenderResult(null);
      setRenderState("idle");
    }
  }, [videoFile]);

  const handleVideoLoad = (file: File) => {
    setVideoFile(file);
    setRenderResult(null);
    setSegments([]);
    const url = URL.createObjectURL(file);
    requestAnimationFrame(() => {
      if (videoRef.current) {
        videoRef.current.src = url;
      }
    });
  };

  const addSegment = useCallback(() => {
    setSegments((prev) => {
      if (videoDuration <= 0) return prev;
      if (prev.length >= MAX_SEGMENTS) return prev;
      const next = createSegment(prev.length, videoDuration);
      return [...prev, next];
    });
  }, [videoDuration]);

  const removeSegment = useCallback((id: string) => {
    setSegments((prev) => prev.filter((segment) => segment.id !== id));
  }, []);

  const updateSegment = useCallback(
    (id: string, key: "start" | "end", value: number) => {
      setSegments((prev) =>
        prev.map((segment) => {
          if (segment.id !== id) return segment;
          const nextValue = clamp(value, 0, videoDuration);
          if (key === "start") {
            const safeStart = Math.min(nextValue, segment.end - 0.25);
            return {
              ...segment,
              start: Number(safeStart.toFixed(2)),
            };
          }
          if (key === "end") {
            const safeEnd = Math.max(nextValue, segment.start + 0.25);
            return {
              ...segment,
              end: Number(clamp(safeEnd, 0.25, videoDuration).toFixed(2)),
            };
          }
          return segment;
        }),
      );
    },
  [videoDuration]);

  const totalSelectedDuration = useMemo(
    () =>
      segments.reduce(
        (acc, segment) => acc + Math.max(segment.end - segment.start, 0),
        0,
      ),
    [segments],
  );

  const selectCurrentTime = useCallback(
    (segmentId: string, key: "start" | "end") => {
      if (!videoRef.current) return;
      const current = videoRef.current.currentTime;
      updateSegment(segmentId, key, current);
    },
    [updateSegment],
  );

  const autoDistributeSegments = useCallback(() => {
    if (videoDuration <= 0) return;
    const chunk = Math.max(videoDuration / 4, 6);
    const calculated = Array.from({ length: Math.min(3, MAX_SEGMENTS) }).map(
      (_, idx) => {
        const start = clamp(idx * chunk * 0.8, 0, Math.max(videoDuration - 6, 0));
        return {
          id: uuid(),
          label: `Highlight ${idx + 1}`,
          start: Number(start.toFixed(2)),
          end: Number(clamp(start + Math.min(chunk, 10), 0, videoDuration).toFixed(2)),
        };
      },
    );
    setSegments(calculated);
  }, [videoDuration]);

  useEffect(() => {
    if (!videoRef.current) return;
    const handler = () => {
      if (!videoRef.current?.duration) return;
      setVideoDuration(videoRef.current.duration);
      setSegments((prev) => {
        if (prev.length > 0) return prev;
        return [createSegment(0, videoRef.current!.duration)];
      });
    };
    const el = videoRef.current;
    el?.addEventListener("loadedmetadata", handler);
    return () => {
      el?.removeEventListener("loadedmetadata", handler);
    };
  }, []);

  const handleRender = useCallback(async () => {
    if (!videoFile) return;
    if (!segments.length) return;
    setRenderError(null);
    setRenderResult(null);
    setRenderState("preparing");

    if (!ffmpegRef.current) {
      try {
        await load();
      } catch (error) {
        console.error(error);
        setRenderState("error");
        setRenderError("Unable to initialize video engine.");
        return;
      }
    }
    const ffmpegRaw = ffmpegRef.current;
    const fetchFileFn = fetchFileRef.current;
    if (!ffmpegRaw || !fetchFileFn) {
      setRenderState("error");
      setRenderError("Unable to initialize video engine.");
      return;
    }
    const ffmpegInstance = ffmpegRaw as FFmpeg & {
      setProgress?: (cb: (progress: { ratio: number }) => void) => void;
    };
    const ffmpegAny = ffmpegInstance as unknown as {
      FS: (method: string, ...args: any[]) => any;
      run: (...args: string[]) => Promise<void>;
    };

    const sanitizedSegments = distributeSegmentsToTarget(
      segments
        .filter((segment) => segment.end - segment.start > 0.25)
        .map((segment, idx) => ({
          ...segment,
          start: Number(segment.start.toFixed(2)),
          end: Number(segment.end.toFixed(2)),
          label: `Highlight ${idx + 1}`,
        })),
      TARGET_DURATION,
    );

    if (!sanitizedSegments.length) {
      setRenderState("error");
      setRenderError("Select at least one valid highlight segment.");
      return;
    }

    const fileName = "source.mp4";
    const musicName = musicFile ? "music.mp3" : null;
    const hasMusic = Boolean(musicFile && musicName);
    const renderFades = fadeDurations(sanitizedSegments);

    try {
      setRenderState("rendering");
      setRenderProgress(0.05);
      ffmpegInstance.setProgress?.(({ ratio }) => {
        setRenderProgress(ratio);
      });

      ffmpegAny.FS("writeFile", fileName, await fetchFileFn(videoFile));
      if (hasMusic && musicName && musicFile) {
        ffmpegAny.FS("writeFile", musicName, await fetchFileFn(musicFile));
      }

      const filterParts = createConcatenationFilter(
        sanitizedSegments,
        includeOriginalAudio,
        {
          brightness,
          contrast,
          saturation,
        },
        renderFades,
      );

      const inputs = ["-i", fileName];
      if (hasMusic && musicName) {
        inputs.push("-i", musicName);
      }

      const filterGraph: string[] = [...filterParts];
      let audioLabel = includeOriginalAudio ? "[aout]" : "";
      if (hasMusic) {
        filterGraph.push(
          `[1:a]volume=${musicVolume.toFixed(2)}[musicbed]`,
        );
        if (includeOriginalAudio) {
          filterGraph.push(
            `${audioLabel}[musicbed]amix=inputs=2:duration=first:dropout_transition=2[aoutmixed]`,
          );
          audioLabel = "[aoutmixed]";
        } else {
          audioLabel = "[musicbed]";
        }
      }

      const outputArgs = [
        "-filter_complex",
        filterGraph.join(";"),
        "-map",
        "[vout]",
      ];

      let hasAudioTrack = false;

      if (audioLabel) {
        outputArgs.push("-map", audioLabel);
        hasAudioTrack = true;
      }

      outputArgs.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "18");
      if (hasAudioTrack) {
        outputArgs.push("-c:a", "aac", "-b:a", "192k");
      }
      outputArgs.push(
        "-movflags",
        "faststart",
        "-t",
        TARGET_DURATION.toString(),
        "reel.mp4",
      );

      await ffmpegAny.run(...inputs, ...outputArgs);

      const data = ffmpegAny.FS("readFile", "reel.mp4");
      const blob = new Blob([data.buffer], { type: "video/mp4" });
      const url = URL.createObjectURL(blob);

      setRenderResult({
        url,
        downloadName: `cinematic-reel-${Date.now()}.mp4`,
        duration: TARGET_DURATION,
      });
      setRenderProgress(1);
      setRenderState("completed");
    } catch (error) {
      console.error(error);
      setRenderState("error");
      setRenderError(
        error instanceof Error
          ? error.message
          : "Something went wrong while rendering.",
      );
    } finally {
      setTimeout(() => {
        try {
          const current = ffmpegRef.current as typeof ffmpegAny | null;
          current?.FS("unlink", "reel.mp4");
          current?.FS("unlink", fileName);
          if (hasMusic && musicName) {
            current?.FS("unlink", musicName);
          }
        } catch (err) {
          console.warn("Cleanup failed", err);
        }
      }, 200);
    }
  }, [
    videoFile,
    segments,
    load,
    includeOriginalAudio,
    brightness,
    contrast,
    saturation,
    musicFile,
    musicVolume,
    ffmpegRef,
  ]);

  const reset = () => {
    setVideoFile(null);
    setVideoDuration(0);
    setSegments([]);
    setMusicFile(null);
    setRenderState("idle");
    setRenderResult(null);
    setRenderProgress(0);
  };

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 pb-24">
      <header className="flex flex-col gap-3">
        <div className="flex items-center gap-3 text-zinc-800">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-zinc-900 text-white shadow-lg shadow-zinc-950/20">
            <VideoIcon className="size-6" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-zinc-950">
              Cinematic Reel Builder
            </h1>
            <p className="text-sm text-zinc-500">
              Curate the most emotional highlights and deliver a vertical,
              color-graded 30s masterpiece.
            </p>
          </div>
        </div>
      </header>

      <section className="grid gap-8 lg:grid-cols-[1.1fr_0.9fr]">
        <div className="rounded-3xl border border-zinc-100 bg-white/80 p-6 shadow-xl shadow-zinc-800/5 backdrop-blur">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-zinc-900">
              1 · Source Footage
            </h2>
            {videoFile ? (
              <button
                onClick={reset}
                className="text-sm font-medium text-rose-500 transition hover:text-rose-600"
              >
                Start over
              </button>
            ) : null}
          </div>
          <div className="mt-4 rounded-2xl border border-dashed border-zinc-200 bg-zinc-50/70 p-6 text-center">
            <label className="flex cursor-pointer flex-col items-center gap-3 text-zinc-500 hover:text-zinc-600">
              <span className="rounded-full bg-white px-4 py-1 text-xs font-semibold uppercase tracking-wide text-zinc-400 shadow">
                Drop video or browse
              </span>
              <p className="max-w-md text-sm leading-6 text-zinc-500">
                Upload your long-form footage. We will keep only the emotional,
                visually stunning moments.
              </p>
              <input
                className="hidden"
                type="file"
                accept="video/mp4,video/x-m4v,video/*"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) {
                    handleVideoLoad(file);
                  }
                }}
              />
            </label>
            {videoFile ? (
              <p className="mt-3 text-xs font-medium uppercase tracking-wide text-zinc-400">
                {videoFile.name}
              </p>
            ) : null}
          </div>

          {videoFile ? (
            <div className="mt-6 space-y-4">
              <video
                ref={videoRef}
                className="aspect-[9/16] w-full rounded-2xl border border-zinc-200 bg-black object-cover"
                controls
              />
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-zinc-200 bg-zinc-100/80 px-4 py-3 text-sm text-zinc-500">
                <div className="flex items-center gap-2">
                  <Scissors className="size-4 text-zinc-400" />
                  <span>
                    {segments.length} highlight
                    {segments.length === 1 ? "" : "s"} selected ·{" "}
                    {formatTime(totalSelectedDuration)} chosen
                  </span>
                </div>
                <button
                  onClick={autoDistributeSegments}
                  className="rounded-full border border-zinc-300 bg-white px-3 py-1 text-xs font-semibold uppercase tracking-wide text-zinc-600 transition hover:border-zinc-400 hover:text-zinc-700"
                >
                  Auto-build highlights
                </button>
              </div>
            </div>
          ) : null}
        </div>

        <div className="rounded-3xl border border-zinc-100 bg-white/90 p-6 shadow-xl shadow-zinc-800/5 backdrop-blur">
          <h2 className="text-lg font-semibold text-zinc-900">
            2 · Audio & Color
          </h2>
          <div className="mt-5 space-y-5 text-sm text-zinc-600">
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="font-medium text-zinc-700">
                  Background music
                </span>
                <label className="inline-flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-zinc-400">
                  <input
                    type="checkbox"
                    className="rounded border-zinc-300 text-zinc-900 focus:ring-zinc-400"
                    checked={includeOriginalAudio}
                    onChange={(event) =>
                      setIncludeOriginalAudio(event.target.checked)
                    }
                  />
                  Keep natural audio
                </label>
              </div>
              <label className="flex cursor-pointer flex-col items-center gap-2 rounded-2xl border border-dashed border-zinc-200 bg-zinc-50/70 px-4 py-5 text-center transition hover:border-zinc-300">
                <Music4 className="size-5 text-zinc-400" />
                <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                  Upload ambient soundtrack (optional)
                </span>
                <input
                  type="file"
                  accept="audio/mp3,audio/mpeg,audio/wav"
                  className="hidden"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) setMusicFile(file);
                  }}
                />
                {musicFile ? (
                  <span className="text-xs text-zinc-500">
                    {musicFile.name}
                  </span>
                ) : (
                  <span className="text-xs text-zinc-400">
                    MP3 or WAV · 30 seconds is enough
                  </span>
                )}
              </label>
              <div className="flex items-center gap-3">
                <span className="text-xs font-medium uppercase tracking-wide text-zinc-400">
                  Music level
                </span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={musicVolume}
                  onChange={(event) => setMusicVolume(Number(event.target.value))}
                  className="h-1 w-full cursor-pointer appearance-none rounded-full bg-zinc-200 accent-zinc-900"
                />
                <span className="text-xs font-semibold text-zinc-500">
                  {Math.round(musicVolume * 100)}%
                </span>
              </div>
            </div>
            <div className="space-y-3">
              <span className="font-medium text-zinc-700">Look & feel</span>
              <div className="space-y-2 rounded-2xl border border-zinc-200 bg-white/90 p-4">
                <SliderRow
                  label="Brightness"
                  min={-0.3}
                  max={0.3}
                  step={0.01}
                  value={brightness}
                  onChange={setBrightness}
                />
                <SliderRow
                  label="Contrast"
                  min={0.7}
                  max={1.5}
                  step={0.01}
                  value={contrast}
                  onChange={setContrast}
                />
                <SliderRow
                  label="Saturation"
                  min={0.8}
                  max={1.8}
                  step={0.01}
                  value={saturation}
                  onChange={setSaturation}
                />
              </div>
            </div>
          </div>
        </div>
      </section>

      {videoFile ? (
        <section className="rounded-3xl border border-zinc-100 bg-white/85 p-6 shadow-xl shadow-zinc-800/5 backdrop-blur">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-zinc-900">
              3 · Highlight timeline
            </h2>
            <button
              onClick={addSegment}
              disabled={segments.length >= MAX_SEGMENTS}
              className="rounded-full border border-zinc-900 bg-zinc-900 px-4 py-1.5 text-xs font-semibold uppercase tracking-wide text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:border-zinc-200 disabled:bg-zinc-200 disabled:text-zinc-500"
            >
              Add highlight
            </button>
          </div>
          <div className="mt-6 space-y-4">
            {segments.map((segment) => (
              <div
                key={segment.id}
                className="space-y-3 rounded-2xl border border-zinc-100 bg-zinc-50/80 p-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2 text-sm font-medium text-zinc-700">
                    <span className="rounded-full bg-white px-2 py-1 text-xs font-semibold uppercase tracking-wide text-zinc-500">
                      {segment.label}
                    </span>
                    <span className="text-xs text-zinc-400">
                      {formatTime(segment.start)} – {formatTime(segment.end)}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 text-xs">
                    <button
                      onClick={() => selectCurrentTime(segment.id, "start")}
                      className="rounded-full border border-zinc-300 px-3 py-1 font-semibold uppercase tracking-wide text-zinc-500 transition hover:border-zinc-400 hover:text-zinc-700"
                    >
                      Mark in
                    </button>
                    <button
                      onClick={() => selectCurrentTime(segment.id, "end")}
                      className="rounded-full border border-zinc-300 px-3 py-1 font-semibold uppercase tracking-wide text-zinc-500 transition hover:border-zinc-400 hover:text-zinc-700"
                    >
                      Mark out
                    </button>
                    <button
                      onClick={() => removeSegment(segment.id)}
                      className="rounded-full border border-rose-200 px-3 py-1 font-semibold uppercase tracking-wide text-rose-500 transition hover:border-rose-300 hover:text-rose-600"
                    >
                      Remove
                    </button>
                  </div>
                </div>
                <div className="grid gap-4 md:grid-cols-2">
                  <RangeControl
                    label="In point"
                    min={0}
                    max={videoDuration}
                    value={segment.start}
                    step={0.05}
                    onChange={(val) => updateSegment(segment.id, "start", val)}
                  />
                  <RangeControl
                    label="Out point"
                    min={0}
                    max={videoDuration}
                    step={0.05}
                    value={segment.end}
                    onChange={(val) => updateSegment(segment.id, "end", val)}
                  />
                </div>
                <div className="rounded-xl bg-white px-4 py-3 text-xs font-medium uppercase tracking-wide text-zinc-400">
                  {formatTime(segment.end - segment.start)} segment length
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {videoFile ? (
        <section className="rounded-3xl border border-zinc-100 bg-zinc-900 p-6 text-white shadow-xl shadow-zinc-900/30">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
            <div className="space-y-2">
              <p className="text-sm uppercase tracking-[0.3em] text-zinc-400">
                Finalize
              </p>
              <h2 className="text-2xl font-semibold tracking-tight">
                Render 30-second reel
              </h2>
              <p className="text-sm text-zinc-300">
                Smooth pacing, cinematic color, and a vertical export ready for
                Instagram Reels.
              </p>
            </div>
            <div className="flex flex-col gap-4 lg:min-w-[320px]">
              <button
                onClick={handleRender}
                disabled={
                  renderState === "rendering" ||
                  renderState === "preparing" ||
                  !segments.length
                }
                className={cn(
                  "flex items-center justify-center gap-2 rounded-full px-5 py-3 text-sm font-semibold uppercase tracking-wide text-zinc-900 transition",
                  renderState === "rendering" || renderState === "preparing"
                    ? "bg-zinc-500 text-zinc-200"
                    : "bg-white hover:bg-zinc-200",
                )}
              >
                <Share2 className="size-4" />
                {renderState === "rendering" || renderState === "preparing"
                  ? "Rendering..."
                  : "Render cinematic export"}
              </button>
              <span className="text-[10px] font-semibold uppercase tracking-[0.32em] text-zinc-500">
                Engine {isReady ? "ready" : "loads on first render"}
              </span>
              <div className="flex flex-col gap-2 text-xs text-zinc-400">
                <div className="flex items-center justify-between">
                  <span>Selected highlights</span>
                  <span>{formatTime(totalSelectedDuration)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span>Target runtime</span>
                  <span>{TARGET_DURATION}s</span>
                </div>
              </div>
              {renderState === "rendering" || renderState === "preparing" ? (
                <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-800">
                  <div
                    className="h-full rounded-full bg-white transition-all duration-500"
                    style={{ width: `${Math.round(renderProgress * 100)}%` }}
                  />
                </div>
              ) : null}
            </div>
          </div>
          {renderError ? (
            <div className="mt-4 rounded-2xl border border-rose-400/40 bg-rose-500/10 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-rose-200">
              {renderError}
            </div>
          ) : null}
          {renderResult ? (
            <div className="mt-6 rounded-2xl border border-emerald-500/40 bg-emerald-500/10 px-5 py-4 text-sm text-emerald-100">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-400/20 text-emerald-100">
                    <Download className="size-5" />
                  </div>
                  <div>
                    <p className="text-xs uppercase tracking-wide text-emerald-200">
                      Ready to share
                    </p>
                    <p className="font-medium">
                      {renderResult.downloadName} · {TARGET_DURATION}s
                    </p>
                  </div>
                </div>
                <a
                  href={renderResult.url}
                  download={renderResult.downloadName}
                  className="rounded-full border border-emerald-300/80 bg-emerald-300/20 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-emerald-50 transition hover:bg-emerald-300/40"
                >
                  Download reel
                </a>
              </div>
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

type SliderRowProps = {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (value: number) => void;
};

function SliderRow({ label, min, max, step, value, onChange }: SliderRowProps) {
  return (
    <div className="grid gap-3">
      <div className="flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-zinc-400">
        <span>{label}</span>
        <span>{value.toFixed(2)}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="h-1 w-full cursor-pointer appearance-none rounded-full bg-zinc-200 accent-zinc-900"
      />
    </div>
  );
}

type RangeControlProps = {
  label: string;
  min: number;
  max: number;
  step?: number;
  value: number;
  onChange: (value: number) => void;
};

function RangeControl({
  label,
  min,
  max,
  value,
  step = 0.1,
  onChange,
}: RangeControlProps) {
  return (
    <div className="space-y-2 rounded-xl bg-white px-4 py-3">
      <div className="flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-zinc-400">
        <span>{label}</span>
        <span>{formatTime(value)}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        step={step}
        onChange={(event) => onChange(Number(event.target.value))}
        className="h-1 w-full cursor-pointer appearance-none rounded-full bg-zinc-200 accent-zinc-900"
      />
    </div>
  );
}
