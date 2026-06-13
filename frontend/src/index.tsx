import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

// Global reset styles
const style = document.createElement("style");
style.textContent = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #080808; color: #e0e0e0; }
  button { font-family: inherit; }
  ::-webkit-scrollbar { width: 6px; }
  ::-webkit-scrollbar-track { background: #0d0d0d; }
  ::-webkit-scrollbar-thumb { background: #2d2d2d; border-radius: 3px; }
  ::-webkit-scrollbar-thumb:hover { background: #3d3d3d; }
`;
document.head.appendChild(style);

const root = ReactDOM.createRoot(
  document.getElementById("root") as HTMLElement
);
root.render(
 <React.StrictMode>
    <App />
  </React.StrictMode>
);