import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource/archivo/400.css";
import "@fontsource/archivo/500.css";
import App from "./App";
import { isTauri } from "@tauri-apps/api/core";
import NativeApp from "./native/NativeApp";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>{isTauri() ? <NativeApp /> : <App />}</React.StrictMode>,
);
