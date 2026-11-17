import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource/silkscreen/400.css";
import "@fontsource/silkscreen/700.css";
import "./styles/theme.css";
import { Launcher } from "./components/Launcher/Launcher";
import { ThemeProvider } from "./components/ThemeProvider";
import { VoiceWindow } from "./components/Voice/VoiceWindow";
import { TrackerWindow } from "./components/TrackerWindow/TrackerWindow";

const params = new URLSearchParams(window.location.search);
const view = params.get("view");

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ThemeProvider>
      {view === "tracker" ? <TrackerWindow id={params.get("id") ?? ""} /> : view === "voice" ? <VoiceWindow /> : <Launcher />}
    </ThemeProvider>
  </React.StrictMode>,
);
