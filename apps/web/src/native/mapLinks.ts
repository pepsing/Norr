import coordinates from "coordtransform";

export type CoordinateSystem = "wgs84" | "gcj02";

export function vehicleMapLinks(
  longitude: number,
  latitude: number,
  vehicleSystem: CoordinateSystem,
  googleSystem: CoordinateSystem,
) {
  const [mapLon, mapLat] =
    vehicleSystem === "wgs84"
      ? coordinates.wgs84togcj02(longitude, latitude)
      : [longitude, latitude];
  const [googleLon, googleLat] =
    googleSystem === "gcj02"
      ? coordinates.gcj02towgs84(longitude, latitude)
      : [longitude, latitude];
  const [appleLon, appleLat] =
    vehicleSystem === "gcj02"
      ? coordinates.gcj02towgs84(longitude, latitude)
      : [longitude, latitude];
  return {
    embed: `https://www.amap.com/ssr/embed/place?lng=${mapLon.toFixed(6)}&lat=${mapLat.toFixed(6)}&name=Norr%20Polestar&zoom=16&platform=pc&src=Norr`,
    amap: `https://uri.amap.com/marker?position=${mapLon},${mapLat}&name=Polestar&coordinate=gaode&src=Norr&callnative=1`,
    google: `https://www.google.com/maps/search/?api=1&query=${googleLat},${googleLon}`,
    apple: `https://maps.apple.com/?ll=${appleLat},${appleLon}&q=Polestar`,
  };
}
