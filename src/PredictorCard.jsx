import { useState } from "react";
import { Brain, MapPin, ChevronDown, Zap, AlertTriangle, CheckCircle, Info } from "lucide-react";

// TODO: Replace mock predictions with your Flask API
// POST /api/predict { city: string } → { aqi: number, category: string, pollutants: {...} }
const MOCK_PREDICTIONS = {
  "Delhi": { aqi: 287, dominant: "PM2.5", confidence: 91, trend: "worsening" },
  "Mumbai": { aqi: 142, dominant: "PM10", confidence: 88, trend: "stable" },
  "Bangalore": { aqi: 78, dominant: "NO2", confidence: 94, trend: "improving" },
  "Chennai": { aqi: 95, dominant: "PM2.5", confidence: 86, trend: "stable" },
  "Kolkata": { aqi: 198, dominant: "PM2.5", confidence: 89, trend: "worsening" },
  "Hyderabad": { aqi: 112, dominant: "PM10", confidence: 92, trend: "stable" },
  "Ahmedabad": { aqi: 165, dominant: "PM2.5", confidence: 87, trend: "worsening" },
  "Pune": { aqi: 88, dominant: "NO2", confidence: 90, trend: "improving" },
  "Jaipur": { aqi: 201, dominant: "PM10", confidence: 85, trend: "worsening" },
  "Lucknow": { aqi: 234, dominant: "PM2.5", confidence: 88, trend: "worsening" },
  "Chandigarh": { aqi: 134, dominant: "PM10", confidence: 91, trend: "stable" },
  "Surat": { aqi: 143, dominant: "PM2.5", confidence: 86, trend: "stable" },
};

const CITIES = Object.keys(MOCK_PREDICTIONS);

function getAQICategory(aqi) {
  if (aqi <= 50) return { label: "Good", color: "#22c55e", bg: "rgba(34,197,94,0.1)", icon: <CheckCircle size={14} /> };
  if (aqi <= 100) return { label: "Moderate", color: "#a3e635", bg: "rgba(163,230,53,0.1)", icon: <CheckCircle size={14} /> };
  if (aqi <= 150) return { label: "Unhealthy for Sensitive", color: "#facc15", bg: "rgba(250,204,21,0.1)", icon: <Info size={14} /> };
  if (aqi <= 200) return { label: "Unhealthy", color: "#f97316", bg: "rgba(249,115,22,0.1)", icon: <AlertTriangle size={14} /> };
  if (aqi <= 300) return { label: "Very Unhealthy", color: "#ef4444", bg: "rgba(239,68,68,0.1)", icon: <AlertTriangle size={14} /> };
  return { label: "Hazardous", color: "#9333ea", bg: "rgba(147,51,234,0.1)", icon: <AlertTriangle size={14} /> };
}

function AQIGauge({ aqi, color }) {
  const maxAQI = 400;
  const pct = Math.min(aqi / maxAQI, 1);
  const radius = 54;
  const circumference = 2 * Math.PI * radius;
  const arcLen = circumference * 0.75; // 270-degree arc
  const dashOffset = arcLen - pct * arcLen;

  return (
    <div style={{ position: "relative", width: 140, height: 110, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <svg width="140" height="140" style={{ position: "absolute", top: -15 }}>
        <defs>
          <linearGradient id="gaugeGrad" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor={color} stopOpacity="0.4" />
            <stop offset="100%" stopColor={color} />
          </linearGradient>
        </defs>
        {/* Track */}
        <circle cx="70" cy="80" r={radius} fill="none"
          stroke="rgba(255,255,255,0.06)" strokeWidth="10"
          strokeDasharray={`${arcLen} ${circumference}`}
          strokeDashoffset={-circumference * 0.125}
          strokeLinecap="round" transform="rotate(0 70 80)" />
        {/* Value arc */}
        <circle cx="70" cy="80" r={radius} fill="none"
          stroke="url(#gaugeGrad)" strokeWidth="10"
          strokeDasharray={`${arcLen} ${circumference}`}
          strokeDashoffset={-circumference * 0.125 + dashOffset}
          strokeLinecap="round"
          style={{ transition: "stroke-dashoffset 1.2s cubic-bezier(0.34, 1.56, 0.64, 1)", filter: `drop-shadow(0 0 8px ${color})` }} />
      </svg>
      <div style={{ position: "relative", textAlign: "center", zIndex: 1 }}>
        <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 36, fontWeight: 800, color, lineHeight: 1, filter: `drop-shadow(0 0 12px ${color}60)` }}>
          {aqi}
        </div>
        <div style={{ fontSize: 11, color: "#475569", textTransform: "uppercase", letterSpacing: "0.08em" }}>AQI</div>
      </div>
    </div>
  );
}

export default function PredictorCard() {
  const [city, setCity] = useState("");
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [phase, setPhase] = useState(0);

  const loadingPhrases = [
    "Fetching atmospheric data...",
    "Running ML inference...",
    "Calibrating pollutant model...",
    "Finalizing prediction...",
  ];

  const handlePredict = () => {
    if (!city) return;
    setLoading(true);
    setResult(null);
    setPhase(0);

    // TODO: Replace with your Flask API call
    // const res = await fetch('/api/predict', { method: 'POST', body: JSON.stringify({ city }) })
    // const data = await res.json()
    const phaseInterval = setInterval(() => {
      setPhase((p) => {
        if (p >= loadingPhrases.length - 1) { clearInterval(phaseInterval); return p; }
        return p + 1;
      });
    }, 500);

    setTimeout(() => {
      clearInterval(phaseInterval);
      setLoading(false);
      setResult(MOCK_PREDICTIONS[city]);
    }, 2200);
  };

  const category = result ? getAQICategory(result.aqi) : null;

  return (
    <div style={{
      background: "rgba(15, 23, 42, 0.6)",
      backdropFilter: "blur(20px)",
      border: "1px solid rgba(255,255,255,0.08)",
      borderRadius: 20,
      padding: 28,
      display: "flex",
      flexDirection: "column",
      gap: 20,
      height: "100%",
      boxSizing: "border-box",
      position: "relative",
      overflow: "hidden",
    }}>
      {/* Top glow */}
      {result && <div style={{
        position: "absolute", top: -40, right: -40, width: 200, height: 200,
        borderRadius: "50%", background: `radial-gradient(circle, ${category.color}15 0%, transparent 70%)`,
        pointerEvents: "none",
      }} />}

      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{
          width: 36, height: 36, borderRadius: 10,
          background: "linear-gradient(135deg, rgba(147,51,234,0.3), rgba(147,51,234,0.1))",
          border: "1px solid rgba(147,51,234,0.3)",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          <Brain size={18} color="#a855f7" />
        </div>
        <div>
          <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 15, fontWeight: 700, color: "#f1f5f9" }}>AQI Predictor</div>
          <div style={{ fontSize: 11, color: "#475569" }}>ML-powered 24h forecast</div>
        </div>
      </div>

      {/* City selector */}
      <div style={{ position: "relative" }}>
        <button
          onClick={() => setDropdownOpen(!dropdownOpen)}
          style={{
            width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between",
            padding: "12px 16px", borderRadius: 12,
            background: "rgba(255,255,255,0.04)",
            border: `1px solid ${city ? "rgba(147,51,234,0.4)" : "rgba(255,255,255,0.08)"}`,
            cursor: "pointer", fontFamily: "'DM Sans', sans-serif",
            color: city ? "#f1f5f9" : "#475569", fontSize: 14,
            transition: "all 0.2s ease",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <MapPin size={15} color={city ? "#a855f7" : "#475569"} />
            {city || "Select a city"}
          </div>
          <ChevronDown size={15} color="#475569"
            style={{ transform: dropdownOpen ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 0.2s ease" }} />
        </button>

        {dropdownOpen && (
          <div style={{
            position: "absolute", top: "calc(100% + 6px)", left: 0, right: 0,
            background: "rgba(15, 23, 42, 0.98)",
            backdropFilter: "blur(20px)",
            border: "1px solid rgba(255,255,255,0.1)",
            borderRadius: 12, zIndex: 100,
            maxHeight: 220, overflowY: "auto",
            boxShadow: "0 20px 40px rgba(0,0,0,0.5)",
          }}>
            {CITIES.map((c) => (
              <button
                key={c}
                onClick={() => { setCity(c); setDropdownOpen(false); setResult(null); }}
                style={{
                  width: "100%", padding: "10px 16px", textAlign: "left",
                  background: city === c ? "rgba(147,51,234,0.15)" : "transparent",
                  border: "none", cursor: "pointer",
                  color: city === c ? "#a855f7" : "#94a3b8",
                  fontFamily: "'DM Sans', sans-serif", fontSize: 14,
                  transition: "all 0.15s ease",
                  display: "flex", alignItems: "center", gap: 8,
                }}
                onMouseEnter={(e) => { if (city !== c) e.currentTarget.style.background = "rgba(255,255,255,0.04)"; }}
                onMouseLeave={(e) => { if (city !== c) e.currentTarget.style.background = "transparent"; }}
              >
                <MapPin size={13} color={city === c ? "#a855f7" : "#475569"} />
                {c}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Predict button */}
      <button
        onClick={handlePredict}
        disabled={!city || loading}
        style={{
          padding: "12px 20px", borderRadius: 12, border: "none",
          background: !city ? "rgba(255,255,255,0.04)" : loading
            ? "rgba(147,51,234,0.2)"
            : "linear-gradient(135deg, #9333ea, #7c3aed)",
          color: !city ? "#475569" : "white",
          fontFamily: "'DM Sans', sans-serif", fontSize: 14, fontWeight: 700,
          cursor: !city || loading ? "not-allowed" : "pointer",
          display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
          transition: "all 0.2s ease",
          boxShadow: !city || loading ? "none" : "0 0 24px rgba(147,51,234,0.4)",
        }}
      >
        {loading
          ? <><LoadingDots /> {loadingPhrases[phase]}</>
          : <><Zap size={16} /> Run Prediction</>
        }
      </button>

      {/* Result */}
      {result && !loading && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16, animation: "fadeSlideUp 0.5s ease" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <AQIGauge aqi={result.aqi} color={category.color} />
            <div style={{ flex: 1, paddingLeft: 20, display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{
                display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 12px",
                borderRadius: 20, background: category.bg,
                border: `1px solid ${category.color}40`,
                color: category.color, fontSize: 12, fontWeight: 700,
                width: "fit-content",
              }}>
                {category.icon} {category.label}
              </div>
              <div style={{ fontSize: 13, color: "#64748b" }}>
                Dominant: <span style={{ color: "#94a3b8", fontWeight: 600 }}>{result.dominant}</span>
              </div>
              <div style={{ fontSize: 13, color: "#64748b" }}>
                Confidence: <span style={{ color: "#94a3b8", fontWeight: 600 }}>{result.confidence}%</span>
              </div>
              <div style={{ fontSize: 13, color: "#64748b" }}>
                Trend: <span style={{
                  fontWeight: 600,
                  color: result.trend === "improving" ? "#22c55e" : result.trend === "stable" ? "#facc15" : "#ef4444"
                }}>{result.trend === "improving" ? "↗ " : result.trend === "stable" ? "→ " : "↘ "}{result.trend}</span>
              </div>
            </div>
          </div>

          {/* Health recommendation */}
          <div style={{
            padding: "12px 14px", borderRadius: 10,
            background: `${category.color}0d`,
            border: `1px solid ${category.color}20`,
            fontSize: 12, color: "#94a3b8", lineHeight: 1.6,
          }}>
            <span style={{ color: category.color, fontWeight: 700 }}>💡 Advisory: </span>
            {result.aqi > 200
              ? "Stay indoors. Use air purifiers. Avoid outdoor exercise."
              : result.aqi > 100
              ? "Sensitive groups should limit outdoor activity."
              : "Air quality is acceptable for most individuals."}
          </div>
        </div>
      )}

      <style>{`
        @keyframes fadeSlideUp {
          from { opacity: 0; transform: translateY(12px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes blink { 0%, 80%, 100% { opacity: 0; } 40% { opacity: 1; } }
      `}</style>
    </div>
  );
}

function LoadingDots() {
  return (
    <div style={{ display: "flex", gap: 3, alignItems: "center" }}>
      {[0, 1, 2].map((i) => (
        <div key={i} style={{
          width: 5, height: 5, borderRadius: "50%", background: "#a855f7",
          animation: `blink 1.2s infinite ${i * 0.2}s`,
        }} />
      ))}
    </div>
  );
}
