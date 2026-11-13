import { StrictMode } from "react";
import { createPortal, flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import "./styles/app.css";
import App from "./App";

const detachedRoot = document.createElement("div");
const root = createRoot(detachedRoot);
flushSync(() => {
  root.render(
    createPortal(
      <StrictMode>
        <App />
      </StrictMode>,
      document.body
    )
  );
});
