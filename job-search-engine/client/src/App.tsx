import { Routes, Route, Navigate } from "react-router-dom";
import Layout from "./components/Layout";
import SearchPage from "./pages/SearchPage";
import MatchesPage from "./pages/MatchesPage";
import TrackerPage from "./pages/TrackerPage";
import ObservatoryPage from "./pages/ObservatoryPage";
import TunePage from "./pages/TunePage";

export default function App() {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Navigate to="/matches" replace />} />
        <Route path="/search" element={<SearchPage />} />
        <Route path="/matches" element={<MatchesPage />} />
        <Route path="/tracker" element={<TrackerPage />} />
        <Route path="/tune" element={<TunePage />} />
        <Route path="/observatory" element={<ObservatoryPage />} />
        <Route path="*" element={<Navigate to="/matches" replace />} />
      </Routes>
    </Layout>
  );
}
