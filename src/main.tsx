import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
import { initPwa } from "./services/pwaService";

// Capture the install prompt + register the service worker. Must run before
// React mounts: Chrome fires `beforeinstallprompt` early, and missing it means
// the Install button never appears.
initPwa();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
