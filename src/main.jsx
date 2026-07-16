import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import Home from "./components/Home/Home.jsx";
import GroupView from "./components/GroupView/GroupView.jsx";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/g/:groupId" element={<GroupView />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
);
