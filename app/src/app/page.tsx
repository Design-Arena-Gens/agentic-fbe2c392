"use client";

import { VideoEditor } from "@/components/video-editor";

export default function Home() {
  return (
    <main className="relative min-h-screen w-full overflow-hidden bg-gradient-to-br from-zinc-50 via-white to-sky-50 pb-24">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,_#f8fafc,_transparent_55%)]" />
      <div className="relative z-10 px-4 pt-16 sm:px-8 lg:px-12">
        <VideoEditor />
      </div>
    </main>
  );
}
