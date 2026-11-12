export interface VehicleAppearance {
  modelId: string;
  variantId: string;
  colorId: string;
  cladding: "black" | "body";
}

export interface VehicleColor {
  id: string;
  name: string;
  swatch: string;
}

export interface VehicleVariant {
  id: string;
  name: string;
  wheels: string;
}

export interface VehicleModel {
  id: string;
  name: string;
  defaultVariant: string;
  colors: VehicleColor[];
  variants: VehicleVariant[];
}

export const vehicleCatalog: VehicleModel[] = [
  {
    id: "polestar-2",
    name: "Polestar 2",
    defaultVariant: "long-dual",
    colors: [
      { id: "snow", name: "Snow", swatch: "#ecece7" },
      { id: "vapour", name: "Vapour", swatch: "#b2b4b4" },
      { id: "dune", name: "Dune", swatch: "#c4bfb0" },
      { id: "midnight", name: "Midnight", swatch: "#3f4d5d" },
      { id: "storm", name: "Storm", swatch: "#666968" },
      { id: "space", name: "Space", swatch: "#242526" },
    ],
    variants: [
      {
        id: "standard-single",
        name: "Standard range Single motor",
        wheels: "19″ Aero",
      },
      {
        id: "long-single",
        name: "Long range Single motor",
        wheels: "19″ Aero",
      },
      { id: "long-dual", name: "Long range Dual motor", wheels: "19″ Aero" },
      {
        id: "long-dual-pro",
        name: "Long range Dual motor · Pro",
        wheels: "20″ Pro graphite",
      },
      {
        id: "long-dual-performance",
        name: "Long range Dual motor · Performance",
        wheels: "20″ Performance",
      },
    ],
  },
  {
    id: "polestar-4",
    name: "Polestar 4",
    defaultVariant: "dual",
    colors: [
      { id: "snow", name: "Snow", swatch: "#ecece7" },
      { id: "magnesium", name: "Magnesium", swatch: "#c9cccb" },
      { id: "electron", name: "Electron", swatch: "#7b929e" },
      { id: "storm", name: "Storm", swatch: "#727575" },
      { id: "space", name: "Space", swatch: "#242526" },
    ],
    variants: [
      { id: "rear", name: "Rear motor", wheels: "20″ Aero" },
      { id: "dual", name: "Dual motor", wheels: "20″ Aero" },
      { id: "rear-sport", name: "Rear motor · Sport", wheels: "21″ Sport" },
      { id: "dual-sport", name: "Dual motor · Sport", wheels: "21″ Sport" },
      {
        id: "dual-performance",
        name: "Dual motor · Performance",
        wheels: "22″ Performance",
      },
    ],
  },
];

export function defaultAppearance(modelId = "polestar-2"): VehicleAppearance {
  const model =
    vehicleCatalog.find((item) => item.id === modelId) ?? vehicleCatalog[0];
  return {
    modelId: model.id,
    variantId: model.defaultVariant,
    colorId: "snow",
    cladding: "black",
  };
}

export function validAppearance(value: unknown): value is VehicleAppearance {
  if (!value || typeof value !== "object") return false;
  const appearance = value as VehicleAppearance;
  const model = vehicleCatalog.find((item) => item.id === appearance.modelId);
  return Boolean(
    model?.variants.some((item) => item.id === appearance.variantId) &&
    model.colors.some((item) => item.id === appearance.colorId) &&
    (appearance.cladding === "black" ||
      (model.id === "polestar-4" && appearance.cladding === "body")),
  );
}

export function appearanceFor(vehicle: {
  model: string;
  appearance?: VehicleAppearance;
}) {
  return validAppearance(vehicle.appearance)
    ? vehicle.appearance
    : defaultAppearance(
        vehicle.model === "Polestar 4" ? "polestar-4" : "polestar-2",
      );
}

export function appearanceDetails(appearance: VehicleAppearance) {
  const model = vehicleCatalog.find((item) => item.id === appearance.modelId)!;
  return {
    model,
    variant: model.variants.find((item) => item.id === appearance.variantId)!,
    color: model.colors.find((item) => item.id === appearance.colorId)!,
  };
}

export function vehicleConfiguration(appearance: VehicleAppearance) {
  const { model, variant } = appearanceDetails(appearance);
  return { model: model.name, variant: variant.name, appearance };
}

export function artworkPath(
  appearance: VehicleAppearance,
  view: "side" | "front" = "side",
) {
  return `${import.meta.env.BASE_URL}images/vehicles/${appearance.modelId}/${appearance.variantId}/${appearance.colorId}-${appearance.cladding}-${view}.jpg`;
}
