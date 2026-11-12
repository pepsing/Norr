import { useState } from "react";
import {
  appearanceDetails,
  defaultAppearance,
  vehicleCatalog,
} from "../vehicle-catalog";
import type { VehicleAppearance } from "../vehicle-catalog";
import { VehicleArtwork } from "./VehicleArtwork";

export function VehicleAppearancePicker({
  value,
  onChange,
}: {
  value: VehicleAppearance;
  onChange: (appearance: VehicleAppearance) => void;
}) {
  const [view, setView] = useState<"side" | "front">("side");
  const { model, variant, color } = appearanceDetails(value);
  return (
    <div className="appearance-picker">
      <VehicleArtwork appearance={value} view={view} priority />
      <div className="artwork-view-controls" aria-label="车辆图片视角">
        <button
          type="button"
          aria-pressed={view === "side"}
          onClick={() => setView("side")}
        >
          侧面
        </button>
        <button
          type="button"
          aria-pressed={view === "front"}
          onClick={() => setView("front")}
        >
          前侧
        </button>
      </div>
      <div className="appearance-fields">
        <label>
          演示车型
          <select
            value={value.modelId}
            onChange={(event) =>
              onChange(defaultAppearance(event.target.value))
            }
          >
            {vehicleCatalog.map((item) => (
              <option value={item.id} key={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          动力与外观配置
          <select
            value={value.variantId}
            onChange={(event) =>
              onChange({ ...value, variantId: event.target.value })
            }
          >
            {model.variants.map((item) => (
              <option value={item.id} key={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <fieldset className="paint-picker">
        <legend>车身颜色 · {color.name}</legend>
        <div className="paint-options">
          {model.colors.map((item) => (
            <label key={item.id}>
              <input
                type="radio"
                name="vehicle-paint"
                value={item.id}
                checked={value.colorId === item.id}
                onChange={() => onChange({ ...value, colorId: item.id })}
              />
              <span
                className="paint-swatch"
                style={{ backgroundColor: item.swatch }}
                aria-hidden="true"
              />
              <span>{item.name}</span>
            </label>
          ))}
        </div>
      </fieldset>
      {value.modelId === "polestar-4" && (
        <label>
          下饰板
          <select
            value={value.cladding}
            onChange={(event) =>
              onChange({
                ...value,
                cladding: event.target.value as VehicleAppearance["cladding"],
              })
            }
          >
            <option value="black">黑色饰板</option>
            <option value="body">车身同色饰板</option>
          </select>
        </label>
      )}
      <p className="muted artwork-caption">
        {variant.wheels} · MY2027 {model.id === "polestar-4" ? "coupé · " : ""}
        官方素材
      </p>
      <p className="muted artwork-caption">
        色块仅用于选色，车漆效果以图片为准。素材参考英国官网，实际配置以车辆所属市场为准。
        {value.colorId === "dune" &&
          "Dune 来自官网展示素材，当前英国订购页未列出。"}
      </p>
    </div>
  );
}
