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

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>{isTauri() && import.meta.env.VITE_P4_FIELD_TEST === "true" ? <P4FieldApp /> : isTauri() || isHarmonyOS ? <NativeApp /> : <App />}</React.StrictMode>,
);
