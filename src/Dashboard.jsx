import { useState, useEffect } from "react";
import {
  Wind, Droplets, Thermometer, Eye, Activity, TrendingUp, TrendingDown,
  Search, Bell, LogOut, ChevronUp, ChevronDown, Gauge, Leaf, AlertTriangle
} from "lucide-react";
import {
  AreaChart, Area, LineChart, Line, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend
} from "recharts";
import PredictorCard from "./PredictorCard";

// TODO: Replace with your Flask API calls
// GET /api/historical?city=Delhi&days=30 → historical[]
// GET /api/live?city=Delhi → liveMetrics{}
// GET /api/map-data → cityStats[]

const HISTORICAL_DATA = [
  { time: "Jan 1", PM25: 145, PM10: 210, NO2: 68, O3: 42, CO: 1.2 },
  { time: "Jan 5", PM25: 189, PM10: 245, NO2: 82, O3: 38, CO: 1.8 },
  { time: "Jan 10", PM25: 210, PM10: 280, NO2: 95, O3: 31, CO: 2.1 },
  { time: "Jan 15", PM25: 167, PM10: 230, NO2: 74, O3: 45, CO: 1.5 },
  { time: "Jan 20", PM25: 134, PM10: 195, NO2: 61, O3: 52, CO: 1.1 },
  { time: "Jan 25", PM25: 98, PM10: 162, NO2: 55, O3: 58, CO: 0.9 },
  { time: "Feb 1", PM25: 122, PM10: 178, NO2: 63, O3: 49, CO: 1.0 },
  { time: "Feb 7", PM25: 201, PM10: 267, NO2: 88, O3: 34, CO: 2.0 },
  { time: "Feb 14", PM25: 178, PM10: 241, NO2: 79, O3: 40, CO: 1.7 },
  { time: "Feb 21", PM25: 143, PM10: 208, NO2: 66, O3: 47, CO: 1.3 },
  { time: "Mar 1", PM25: 115, PM10: 172, NO2: 58, O3: 55, CO: 1.0 },
  { time: "Mar 7", PM25: 89, PM10: 148, NO2: 49, O3: 63, CO: 0.8 },
];

const HOURLY_DATA = Array.from({ length: 24 }, (_, i) => ({
  hour: `${String(i).padStart(2, "0")}:00`,
  aqi: Math.floor(120 + Math.sin(i / 4) * 60 + Math.random() * 30),
}));

const CITY_RANKINGS = [
  { city: "Delhi", aqi: 287, change: +12, color: "#9333ea" },
  { city: "Kolkata", aqi: 198, change: +5, color: "#ef4444" },
  { city: "Jaipur", aqi: 201, change: -8, color: "#ef4444" },
  { city: "Mumbai", aqi: 142, change: -3, color: "#f97316" },
  { city: "Bangalore", aqi: 78, change: -14, color: "#a3e635" },
  { city: "Pune", aqi: 88, change: +2, color: "#22c55e" },
];

const POLLUTANTS = [
  { name: "PM2.5", value: 145, unit: "μg/m³", limit: 250, color: "#f97316", icon: <Wind size={16} /> },
  { name: "PM10", value: 210, unit: "μg/m³", limit: 350, color: "#facc15", icon: <Leaf size={16} /> },
  { name: "NO₂", value: 68, unit: "ppb", limit: 100, color: "#22c55e", icon: <Activity size={16} /> },
  { name: "O₃", value: 42, unit: "ppb", limit: 70, color: "#38bdf8", icon: <Gauge size={16} /> },
];

function getAQIColor(aqi) {
  if (aqi <= 50) return "#22c55e";
  if (aqi <= 100) return "#a3e635";
  if (aqi <= 150) return "#facc15";
  if (aqi <= 200) return "#f97316";
  if (aqi <= 300) return "#ef4444";
  return "#9333ea";
}

const CustomTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{
      background: "rgba(15,23,42,0.95)", backdropFilter: "blur(20px)",
      border: "1px solid rgba(255,255,255,0.1)", borderRadius: 12,
      padding: "12px 16px", boxShadow: "0 20px 40px rgba(0,0,0,0.4)",
    }}>
      <div style={{ fontSize: 12, color: "#64748b", marginBottom: 8 }}>{label}</div>
      {payload.map((p) => (
        <div key={p.dataKey} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
          <div style={{ width: 8, height: 8, borderRadius: 2, background: p.color }} />
          <span style={{ fontSize: 13, color: "#94a3b8" }}>{p.dataKey}:</span>
          <span style={{ fontSize: 13, color: "#f1f5f9", fontWeight: 700 }}>{p.value}</span>
        </div>
      ))}
    </div>
  );
};

export default function Dashboard({ user, onLogout }) {
  const [searchQuery, setSearchQuery] = useState("");
  const [activeChart, setActiveChart] = useState("area");
  const [selectedPollutants, setSelectedPollutants] = useState(["PM25", "PM10", "NO2"]);
  const [liveAQI, setLiveAQI] = useState(287);
  const [currentTime, setCurrentTime] = useState(new Date());

  useEffect(() => {
    const tick = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(tick);
  }, []);

  // Simulated live AQI fluctuation
  useEffect(() => {
    const interval = setInterval(() => {
      setLiveAQI((prev) => Math.max(50, Math.min(400, prev + Math.floor((Math.random() - 0.5) * 10))));
    }, 3000);
    return () => clearInterval(interval);
  }, []);

  const aqiColor = getAQIColor(liveAQI);
  const pollutantColors = { PM25: "#f97316", PM10: "#facc15", NO2: "#22c55e", O3: "#38bdf8", CO: "#a855f7" };

  const togglePollutant = (key) => {
    setSelectedPollutants((prev) =>
      prev.includes(key) ? (prev.length > 1 ? prev.filter((p) => p !== key) : prev) : [...prev, key]
    );
  };

  return (
    <div style={{
      minHeight: "100vh",
      background: "radial-gradient(ellipse at 0% 0%, #0d1b2a 0%, #020617 50%, #050510 100%)",
      fontFamily: "'DM Sans', sans-serif",
      color: "#f1f5f9",
    }}>
      {/* Ambient effects */}
      <div style={{ position: "fixed", inset: 0, pointerEvents: "none", zIndex: 0 }}>
        <div style={{ position: "absolute", top: "5%", left: "5%", width: 600, height: 600, borderRadius: "50%", background: "radial-gradient(circle, rgba(34,197,94,0.04) 0%, transparent 70%)", filter: "blur(40px)" }} />
        <div style={{ position: "absolute", bottom: "10%", right: "5%", width: 500, height: 500, borderRadius: "50%", background: `radial-gradient(circle, ${aqiColor}08 0%, transparent 70%)`, filter: "blur(60px)", transition: "background 2s ease" }} />
        <div style={{ position: "absolute", inset: 0, backgroundImage: "linear-gradient(rgba(255,255,255,0.01) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.01) 1px, transparent 1px)", backgroundSize: "50px 50px" }} />
      </div>

      {/* Navbar */}
      <nav style={{
        position: "sticky", top: 0, zIndex: 100,
        background: "rgba(2,6,23,0.85)", backdropFilter: "blur(20px)",
        borderBottom: "1px solid rgba(255,255,255,0.06)",
        padding: "0 32px", height: 64,
        display: "flex", alignItems: "center", justifyContent: "space-between",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{
            width: 36, height: 36, borderRadius: 10,
            background: "linear-gradient(135deg, #22c55e, #16a34a)",
            display: "flex", alignItems: "center", justifyContent: "center",
            boxShadow: "0 0 20px rgba(34,197,94,0.3)",
          }}>
            <Wind size={18} color="white" />
          </div>
          <span style={{ fontFamily: "'Space Grotesk', sans-serif", fontWeight: 700, fontSize: 18, color: "#f8fafc" }}>AeroSense</span>
          <span style={{
            padding: "2px 10px", borderRadius: 20, fontSize: 11, fontWeight: 700,
            background: "rgba(34,197,94,0.1)", color: "#22c55e", border: "1px solid rgba(34,197,94,0.2)",
            textTransform: "uppercase", letterSpacing: "0.05em",
          }}>Live</span>
        </div>

        {/* Search bar */}
        <div style={{
          display: "flex", alignItems: "center", gap: 10,
          background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)",
          borderRadius: 10, padding: "8px 14px", width: 280,
        }}>
          <Search size={15} color="#475569" />
          <input
            placeholder="Search city or area..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{
              flex: 1, background: "none", border: "none", outline: "none",
              color: "#f1f5f9", fontFamily: "'DM Sans', sans-serif", fontSize: 14,
            }}
          />
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div style={{ fontSize: 13, color: "#475569" }}>
            {currentTime.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </div>
          <Bell size={18} color="#475569" style={{ cursor: "pointer" }} />
          <div style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }} onClick={onLogout}>
            <div style={{
              width: 32, height: 32, borderRadius: "50%",
              background: "linear-gradient(135deg, #22c55e, #16a34a)",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 13, fontWeight: 700, color: "white",
            }}>
              {user?.name?.charAt(0) || "U"}
            </div>
            <LogOut size={16} color="#475569" />
          </div>
        </div>
      </nav>

      {/* Main content */}
      <main style={{ padding: "28px 32px", position: "relative", zIndex: 1 }}>
        {/* Page header */}
        <div style={{ marginBottom: 28 }}>
          <h2 style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 26, fontWeight: 800, color: "#f8fafc", marginBottom: 4 }}>
            Welcome back, {user?.name?.split(" ")[0] || "User"} 👋
          </h2>
          <p style={{ color: "#475569", fontSize: 14 }}>
            {currentTime.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })} · Delhi NCR Region
          </p>
        </div>

        {/* BENTO GRID */}
        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(12, 1fr)",
          gridTemplateRows: "auto",
          gap: 16,
        }}>
          {/* Live AQI Hero Card */}
          <div style={{
            gridColumn: "span 3",
            gridRow: "span 2",
            background: "rgba(15, 23, 42, 0.7)",
            backdropFilter: "blur(20px)",
            border: `1px solid ${aqiColor}30`,
            borderRadius: 20,
            padding: 28,
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
            position: "relative",
            overflow: "hidden",
            boxShadow: `0 0 40px ${aqiColor}15, inset 0 1px 0 rgba(255,255,255,0.05)`,
            transition: "box-shadow 2s ease, border-color 2s ease",
          }}>
            <div style={{ position: "absolute", top: -60, right: -60, width: 200, height: 200, borderRadius: "50%", background: `radial-gradient(circle, ${aqiColor}20 0%, transparent 70%)`, transition: "background 2s ease" }} />
            <div>
              <div style={{ fontSize: 12, color: "#475569", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>Live AQI · Delhi</div>
              <div style={{
                fontFamily: "'Space Grotesk', sans-serif",
                fontSize: 80, fontWeight: 800, lineHeight: 1,
                color: aqiColor,
                filter: `drop-shadow(0 0 20px ${aqiColor}60)`,
                transition: "color 2s ease, filter 2s ease",
              }}>
                {liveAQI}
              </div>
              <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 8 }}>
                <div style={{
                  padding: "4px 12px", borderRadius: 20, fontSize: 12, fontWeight: 700,
                  background: `${aqiColor}15`, color: aqiColor, border: `1px solid ${aqiColor}30`,
                }}>
                  {liveAQI > 200 ? "Very Unhealthy" : liveAQI > 150 ? "Unhealthy" : liveAQI > 100 ? "Moderate" : "Good"}
                </div>
              </div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <MetricRow icon={<Thermometer size={14} />} label="Temp" value="23°C" />
              <MetricRow icon={<Droplets size={14} />} label="Humidity" value="68%" />
              <MetricRow icon={<Eye size={14} />} label="Visibility" value="3.2 km" />
              <MetricRow icon={<Wind size={14} />} label="Wind" value="12 km/h" />
            </div>
          </div>

          {/* Pollutant meters */}
          {POLLUTANTS.map((p, i) => (
            <div key={p.name} style={{
              gridColumn: "span 2",
              background: "rgba(15, 23, 42, 0.6)",
              backdropFilter: "blur(20px)",
              border: "1px solid rgba(255,255,255,0.07)",
              borderRadius: 16,
              padding: "18px 20px",
              display: "flex", flexDirection: "column", gap: 12,
              boxSizing: "border-box",
            }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                <div>
                  <div style={{ fontSize: 12, color: "#475569", marginBottom: 4 }}>{p.name}</div>
                  <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 26, fontWeight: 800, color: p.color }}>
                    {p.value}
                  </div>
                  <div style={{ fontSize: 11, color: "#475569" }}>{p.unit}</div>
                </div>
                <div style={{ width: 32, height: 32, borderRadius: 9, background: `${p.color}15`, border: `1px solid ${p.color}25`, display: "flex", alignItems: "center", justifyContent: "center", color: p.color }}>
                  {p.icon}
                </div>
              </div>
              <div>
                <div style={{ height: 4, background: "rgba(255,255,255,0.06)", borderRadius: 2, overflow: "hidden" }}>
                  <div style={{
                    height: "100%", width: `${(p.value / p.limit) * 100}%`,
                    background: `linear-gradient(90deg, ${p.color}80, ${p.color})`,
                    borderRadius: 2, transition: "width 1s ease",
                  }} />
                </div>
                <div style={{ fontSize: 11, color: "#475569", marginTop: 4 }}>{Math.round((p.value / p.limit) * 100)}% of safe limit</div>
              </div>
            </div>
          ))}

          {/* AI Predictor */}
          <div style={{ gridColumn: "span 3", gridRow: "span 2" }}>
            <PredictorCard />
          </div>

          {/* Historical Chart */}
          <div style={{
            gridColumn: "span 9",
            background: "rgba(15, 23, 42, 0.6)",
            backdropFilter: "blur(20px)",
            border: "1px solid rgba(255,255,255,0.07)",
            borderRadius: 20,
            padding: "24px 28px",
            boxSizing: "border-box",
          }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
              <div>
                <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 16, fontWeight: 700, color: "#f1f5f9" }}>
                  Historical Pollutant Trends
                </div>
                <div style={{ fontSize: 12, color: "#475569" }}>Jan – Mar 2026 · Delhi</div>
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                {/* Pollutant toggles */}
                <div style={{ display: "flex", gap: 6, marginRight: 12 }}>
                  {Object.entries(pollutantColors).slice(0, 4).map(([key, color]) => (
                    <button key={key} onClick={() => togglePollutant(key)} style={{
                      padding: "4px 10px", borderRadius: 8, fontSize: 12, fontWeight: 600,
                      border: `1px solid ${selectedPollutants.includes(key) ? color : "rgba(255,255,255,0.08)"}`,
                      background: selectedPollutants.includes(key) ? `${color}15` : "transparent",
                      color: selectedPollutants.includes(key) ? color : "#475569",
                      cursor: "pointer", transition: "all 0.15s ease",
                    }}>{key.replace("2", "₂").replace("3", "₃")}</button>
                  ))}
                </div>
                {/* Chart type toggles */}
                {["area", "line", "bar"].map((type) => (
                  <button key={type} onClick={() => setActiveChart(type)} style={{
                    padding: "6px 14px", borderRadius: 8, fontSize: 12, fontWeight: 600,
                    border: `1px solid ${activeChart === type ? "rgba(34,197,94,0.4)" : "rgba(255,255,255,0.08)"}`,
                    background: activeChart === type ? "rgba(34,197,94,0.12)" : "transparent",
                    color: activeChart === type ? "#22c55e" : "#475569",
                    cursor: "pointer", transition: "all 0.15s ease",
                    textTransform: "capitalize",
                  }}>{type}</button>
                ))}
              </div>
            </div>

            <ResponsiveContainer width="100%" height={220}>
              {activeChart === "bar" ? (
                <BarChart data={HISTORICAL_DATA} margin={{ left: -10 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
                  <XAxis dataKey="time" tick={{ fill: "#475569", fontSize: 11 }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fill: "#475569", fontSize: 11 }} axisLine={false} tickLine={false} />
                  <Tooltip content={<CustomTooltip />} />
                  {selectedPollutants.map((key) => (
                    <Bar key={key} dataKey={key} fill={pollutantColors[key]} radius={[3, 3, 0, 0]} fillOpacity={0.8} />
                  ))}
                </BarChart>
              ) : activeChart === "line" ? (
                <LineChart data={HISTORICAL_DATA} margin={{ left: -10 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
                  <XAxis dataKey="time" tick={{ fill: "#475569", fontSize: 11 }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fill: "#475569", fontSize: 11 }} axisLine={false} tickLine={false} />
                  <Tooltip content={<CustomTooltip />} />
                  {selectedPollutants.map((key) => (
                    <Line key={key} type="monotone" dataKey={key} stroke={pollutantColors[key]} strokeWidth={2} dot={false} />
                  ))}
                </LineChart>
              ) : (
                <AreaChart data={HISTORICAL_DATA} margin={{ left: -10 }}>
                  <defs>
                    {selectedPollutants.map((key) => (
                      <linearGradient key={key} id={`grad-${key}`} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor={pollutantColors[key]} stopOpacity={0.3} />
                        <stop offset="95%" stopColor={pollutantColors[key]} stopOpacity={0} />
                      </linearGradient>
                    ))}
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
                  <XAxis dataKey="time" tick={{ fill: "#475569", fontSize: 11 }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fill: "#475569", fontSize: 11 }} axisLine={false} tickLine={false} />
                  <Tooltip content={<CustomTooltip />} />
                  {selectedPollutants.map((key) => (
                    <Area key={key} type="monotone" dataKey={key} stroke={pollutantColors[key]} strokeWidth={2}
                      fill={`url(#grad-${key})`} dot={false} />
                  ))}
                </AreaChart>
              )}
            </ResponsiveContainer>
          </div>

          {/* Hourly AQI sparkline */}
          <div style={{
            gridColumn: "span 6",
            background: "rgba(15, 23, 42, 0.6)",
            backdropFilter: "blur(20px)",
            border: "1px solid rgba(255,255,255,0.07)",
            borderRadius: 20, padding: "24px 28px",
          }}>
            <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 15, fontWeight: 700, color: "#f1f5f9", marginBottom: 4 }}>
              Today's AQI Pattern
            </div>
            <div style={{ fontSize: 12, color: "#475569", marginBottom: 16 }}>Hourly variation · Delhi</div>
            <ResponsiveContainer width="100%" height={130}>
              <AreaChart data={HOURLY_DATA}>
                <defs>
                  <linearGradient id="aqiGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={aqiColor} stopOpacity={0.4} />
                    <stop offset="95%" stopColor={aqiColor} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="hour" tick={{ fill: "#475569", fontSize: 10 }} interval={3} axisLine={false} tickLine={false} />
                <Tooltip content={<CustomTooltip />} />
                <Area type="monotone" dataKey="aqi" stroke={aqiColor} strokeWidth={2} fill="url(#aqiGrad)" dot={false} />
              </AreaChart>
            </ResponsiveContainer>
          </div>

          {/* City Rankings */}
          <div style={{
            gridColumn: "span 3",
            background: "rgba(15, 23, 42, 0.6)",
            backdropFilter: "blur(20px)",
            border: "1px solid rgba(255,255,255,0.07)",
            borderRadius: 20, padding: "24px 28px",
          }}>
            <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 15, fontWeight: 700, color: "#f1f5f9", marginBottom: 16 }}>
              City Rankings
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {CITY_RANKINGS.map((c, i) => (
                <div key={c.city} style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <div style={{ width: 20, fontSize: 12, color: "#475569", textAlign: "center" }}>{i + 1}</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                      <span style={{ fontSize: 13, color: "#94a3b8" }}>{c.city}</span>
                      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                        <span style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 14, fontWeight: 700, color: c.color }}>{c.aqi}</span>
                        <span style={{ fontSize: 11, color: c.change > 0 ? "#ef4444" : "#22c55e", display: "flex", alignItems: "center" }}>
                          {c.change > 0 ? <ChevronUp size={12} /> : <ChevronDown size={12} />}{Math.abs(c.change)}
                        </span>
                      </div>
                    </div>
                    <div style={{ height: 3, background: "rgba(255,255,255,0.06)", borderRadius: 2 }}>
                      <div style={{ height: "100%", width: `${(c.aqi / 400) * 100}%`, background: c.color, borderRadius: 2, opacity: 0.7 }} />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Alert card */}
          <div style={{
            gridColumn: "span 3",
            background: "rgba(239,68,68,0.08)",
            backdropFilter: "blur(20px)",
            border: "1px solid rgba(239,68,68,0.2)",
            borderRadius: 20, padding: "24px 28px",
            display: "flex", flexDirection: "column", gap: 14,
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{
                width: 36, height: 36, borderRadius: 10,
                background: "rgba(239,68,68,0.15)", border: "1px solid rgba(239,68,68,0.3)",
                display: "flex", alignItems: "center", justifyContent: "center",
              }}>
                <AlertTriangle size={18} color="#ef4444" />
              </div>
              <div>
                <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 14, fontWeight: 700, color: "#f1f5f9" }}>Health Alert</div>
                <div style={{ fontSize: 11, color: "#64748b" }}>Active advisory</div>
              </div>
            </div>
            {[
              { msg: "PM2.5 levels critically high", time: "2h ago" },
              { msg: "Avoid outdoor exercise", time: "Active" },
              { msg: "Wear N95 masks outdoors", time: "Active" },
            ].map((alert, i) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 12px", background: "rgba(239,68,68,0.06)", borderRadius: 10, border: "1px solid rgba(239,68,68,0.1)" }}>
                <span style={{ fontSize: 12, color: "#fca5a5" }}>{alert.msg}</span>
                <span style={{ fontSize: 11, color: "#64748b", whiteSpace: "nowrap", marginLeft: 8 }}>{alert.time}</span>
              </div>
            ))}
          </div>
        </div>
      </main>

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Space+Grotesk:wght@600;700;800&display=swap');
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { width: 6px; background: rgba(255,255,255,0.03); }
        ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 3px; }
      `}</style>
    </div>
  );
}

function MetricRow({ icon, label, value }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, color: "#475569", fontSize: 13 }}>
        {icon} {label}
      </div>
      <span style={{ fontSize: 13, color: "#94a3b8", fontWeight: 600 }}>{value}</span>
    </div>
  );
}
