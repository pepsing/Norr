import { useState } from "react";
import { CarFront } from "lucide-react";
import { appearanceDetails, artworkPath } from "../vehicle-catalog";
import type { VehicleAppearance } from "../vehicle-catalog";

export function VehicleArtwork({
  appearance,
  view = "side",
  priority = false,
  darkStage = false,
}: {
  appearance: VehicleAppearance;
  view?: "side" | "front";
  priority?: boolean;
  darkStage?: boolean;
}) {
  const cutout = darkStage && view === "side";
  const studioSource = artworkPath(appearance, view);
  const src = cutout
    ? studioSource.replace(/\.jpg$/, "-cutout.webp")
    : studioSource;
  const { model, variant, color } = appearanceDetails(appearance);
  const [failedSource, setFailedSource] = useState("");
  const [attempt, setAttempt] = useState(0);
  return (
    <div className={`vehicle-artwork${cutout ? " vehicle-artwork-cutout" : ""}`}>
      {failedSource === src ? (
        <div className="art-placeholder" role="status">
          <CarFront size={48} strokeWidth={1} />
          <span>
            {model.name} · {color.name} 图片加载失败
          </span>
          <button
            className="text-button"
            type="button"
            onClick={() => {
              setFailedSource("");
              setAttempt(attempt + 1);
            }}
          >
            重新加载图片
          </button>
        </div>
      ) : (
        <img
          key={`${src}-${attempt}`}
          src={src}
          alt={`${color.name} ${model.name} ${variant.name}，${variant.wheels}，${appearance.cladding === "body" ? "同色" : "黑色"}下饰板，${view === "side" ? "侧面" : "前侧"}视角`}
          width={1440}
          height={810}
          fetchPriority={priority ? "high" : "auto"}
          onError={() => setFailedSource(src)}
        />
      )}
    </div>
  );
}
