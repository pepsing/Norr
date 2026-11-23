import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource/archivo/400.css";
import "@fontsource/archivo/500.css";
import App from "./App";
import { isTauri } from "@tauri-apps/api/core";
import { P4FieldApp } from "./native/P4FieldApp";
import NativeApp from "./native/NativeApp";
import { isHarmonyOS } from "./native/platform";
import "./styles.css";

function AppRoot() {
  const [showVehicle, setShowVehicle] = React.useState(false);
  if (import.meta.env.VITE_P4_FIELD_TEST === "demo" ||
    (!isTauri() && !isHarmonyOS && new URLSearchParams(window.location.search).get("demo") === "p4")) return <App p4 />;
  if (isTauri() && import.meta.env.VITE_P4_FIELD_TEST === "macos") {
    return showVehicle
      ? <NativeApp onFieldLog={() => setShowVehicle(false)} />
      : <P4FieldApp onViewVehicle={() => setShowVehicle(true)} />;
  }
  if (isTauri() && import.meta.env.VITE_P4_FIELD_TEST === "true") return <P4FieldApp />;
  if (isTauri() && ["ios", "windows"].includes(import.meta.env.VITE_P4_FIELD_TEST)) return <NativeApp p4Logging />;
  return isTauri() || isHarmonyOS ? <NativeApp /> : <App />;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode><AppRoot /></React.StrictMode>,
);
