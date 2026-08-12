import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { UpdateGate } from "./components/UpdateGate";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode><UpdateGate><App /></UpdateGate></StrictMode>,
);
