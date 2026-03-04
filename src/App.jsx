import { useState, useEffect } from "react";
import Auth from "./Auth";
import Dashboard from "./Dashboard";

/**
 * AeroSense - AQI Monitoring & Prediction App
 *
 * FLASK API INTEGRATION GUIDE:
 * ────────────────────────────────────────────────────────
 * This app is pre-wired for a Python/Flask backend.
 * To connect your API, set VITE_API_URL in your .env file:
 *   VITE_API_URL=http://localhost:5000
 *
 * Expected API endpoints:
 *   POST /api/auth/login     → { token, user: { name, email } }
 *   POST /api/auth/register  → { token, user: { name, email } }
 *   GET  /api/live?city=X    → { aqi, pm25, pm10, no2, o3, temp, humidity }
 *   GET  /api/historical?city=X&days=30 → [{ time, PM25, PM10, NO2, O3 }]
 *   POST /api/predict        → { aqi, category, confidence, dominant, trend }
 *
 * Auth token is stored in sessionStorage (no localStorage per constraints).
 * Replace the mock onLogin timeout in Auth.jsx with a real fetch call.
 */

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:5000";

export { API_URL };

export default function App() {
  const [user, setUser] = useState(null);
  const [isBooting, setIsBooting] = useState(true);

  // Check for existing session on mount
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem("aerosense_user");
      if (saved) setUser(JSON.parse(saved));
    } catch (_) {}
    const t = setTimeout(() => setIsBooting(false), 600);
    return () => clearTimeout(t);
  }, []);

  const handleLogin = (userData) => {
    setUser(userData);
    try { sessionStorage.setItem("aerosense_user", JSON.stringify(userData)); } catch (_) {}
  };

  const handleLogout = () => {
    setUser(null);
    try { sessionStorage.removeItem("aerosense_user"); } catch (_) {}
  };

  if (isBooting) {
    return (
      <div style={{
        minHeight: "100vh",
        background: "#020617",
        display: "flex", alignItems: "center", justifyContent: "center",
        flexDirection: "column", gap: 16,
      }}>
        <div style={{
          width: 52, height: 52, borderRadius: 16,
          background: "linear-gradient(135deg, #22c55e, #16a34a)",
          display: "flex", alignItems: "center", justifyContent: "center",
          boxShadow: "0 0 40px rgba(34,197,94,0.5)",
          animation: "pulse 1.5s ease-in-out infinite",
        }}>
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M17.7 7.7a2.5 2.5 0 1 1 1.8 4.3H2" />
            <path d="M9.6 4.6A2 2 0 1 1 11 8H2" />
            <path d="M12.6 19.4A2 2 0 1 0 14 16H2" />
          </svg>
        </div>
        <div style={{ fontFamily: "'Space Grotesk', sans-serif", color: "#22c55e", fontSize: 22, fontWeight: 700 }}>AeroSense</div>
        <style>{`
          @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@700&display=swap');
          @keyframes pulse { 0%, 100% { transform: scale(1); opacity: 1; } 50% { transform: scale(1.05); opacity: 0.8; } }
        `}</style>
      </div>
    );
  }

  return user ? (
    <Dashboard user={user} onLogout={handleLogout} />
  ) : (
    <Auth onLogin={handleLogin} />
  );
}
