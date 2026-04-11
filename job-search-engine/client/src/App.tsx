import { Routes, Route, Navigate } from "react-router-dom";
import Layout from "./components/Layout";
import SearchPage from "./pages/SearchPage";
import TrackerPage from "./pages/TrackerPage";
import ObservatoryPage from "./pages/ObservatoryPage";

export default function App() {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Navigate to="/search" replace />} />
        <Route path="/search" element={<SearchPage />} />
        <Route path="/tracker" element={<TrackerPage />} />
        <Route path="/observatory" element={<ObservatoryPage />} />
        <Route path="*" element={<Navigate to="/search" replace />} />
      </Routes>
    </Layout>
  );
}
