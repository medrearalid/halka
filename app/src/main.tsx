import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./App";
import { boot, useApp } from "./state/store";

void boot();
// dev-only handle for poking the store from devtools
if (import.meta.env.DEV) (window as unknown as { __halka: typeof useApp }).__halka = useApp;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
