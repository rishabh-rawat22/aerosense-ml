import { useState } from "react";
import { Wind, Mail, Lock, User, ArrowRight, Eye, EyeOff, Loader } from "lucide-react";

export default function Auth({ onLogin }) {
  const [mode, setMode] = useState("login");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState({ name: "", email: "", password: "" });

  const handleSubmit = (e) => {
    e.preventDefault();
    setLoading(true);
    // TODO: Replace with your Flask API call
    // POST /api/auth/login or /api/auth/register
    setTimeout(() => {
      setLoading(false);
      onLogin({ name: form.name || "User", email: form.email });
    }, 1600);
  };

  const aqi_dots = [
    { color: "#22c55e", label: "Good" },
    { color: "#a3e635", label: "Moderate" },
    { color: "#facc15", label: "Unhealthy*" },
    { color: "#f97316", label: "Unhealthy" },
    { color: "#ef4444", label: "Very Unhealthy" },
    { color: "#9333ea", label: "Hazardous" },
  ];

  return (
    <div style={{
      minHeight: "100vh",
      background: "radial-gradient(ellipse at 20% 50%, #0f172a 0%, #020617 60%, #0a0a1a 100%)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      fontFamily: "'DM Sans', sans-serif",
      position: "relative",
      overflow: "hidden",
    }}>
      {/* Ambient glow orbs */}
      <div style={{
        position: "absolute", top: "15%", left: "10%", width: 400, height: 400,
        borderRadius: "50%", background: "radial-gradient(circle, rgba(34,197,94,0.07) 0%, transparent 70%)",
        filter: "blur(40px)", pointerEvents: "none",
      }} />
      <div style={{
        position: "absolute", bottom: "20%", right: "8%", width: 500, height: 500,
        borderRadius: "50%", background: "radial-gradient(circle, rgba(147,51,234,0.08) 0%, transparent 70%)",
        filter: "blur(60px)", pointerEvents: "none",
      }} />
      {/* Grid texture overlay */}
      <div style={{
        position: "absolute", inset: 0, pointerEvents: "none",
        backgroundImage: "linear-gradient(rgba(255,255,255,0.015) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.015) 1px, transparent 1px)",
        backgroundSize: "40px 40px",
      }} />

      <div style={{ display: "flex", gap: 80, alignItems: "center", zIndex: 1, padding: "20px" }}>
        {/* Left branding panel */}
        <div style={{ display: "flex", flexDirection: "column", gap: 32, maxWidth: 380 }} className="auth-brand">
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{
              width: 48, height: 48, borderRadius: 14,
              background: "linear-gradient(135deg, #22c55e, #16a34a)",
              display: "flex", alignItems: "center", justifyContent: "center",
              boxShadow: "0 0 30px rgba(34,197,94,0.4)",
            }}>
              <Wind size={24} color="white" />
            </div>
            <div>
              <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 22, fontWeight: 700, color: "#f8fafc", letterSpacing: "-0.5px" }}>AeroSense</div>
              <div style={{ fontSize: 12, color: "#64748b", letterSpacing: "0.05em", textTransform: "uppercase" }}>Air Quality Intelligence</div>
            </div>
          </div>

          <div>
            <h1 style={{
              fontFamily: "'Space Grotesk', sans-serif",
              fontSize: 42, fontWeight: 800, lineHeight: 1.1,
              background: "linear-gradient(135deg, #f8fafc 0%, #94a3b8 100%)",
              WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent",
              backgroundClip: "text", marginBottom: 16,
            }}>
              Breathe with<br />clarity.
            </h1>
            <p style={{ color: "#64748b", fontSize: 15, lineHeight: 1.7 }}>
              Real-time AQI monitoring, predictive analytics, and historical trends — all in one intelligent dashboard.
            </p>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ fontSize: 11, color: "#475569", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 4 }}>AQI Scale</div>
            {aqi_dots.map((dot) => (
              <div key={dot.label} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ width: 10, height: 10, borderRadius: "50%", background: dot.color, boxShadow: `0 0 8px ${dot.color}80`, flexShrink: 0 }} />
                <div style={{ height: 2, flex: 1, background: `linear-gradient(90deg, ${dot.color}40, transparent)`, borderRadius: 1 }} />
                <div style={{ fontSize: 12, color: "#64748b", whiteSpace: "nowrap" }}>{dot.label}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Auth card */}
        <div style={{
          width: 420,
          background: "rgba(15, 23, 42, 0.7)",
          backdropFilter: "blur(24px)",
          border: "1px solid rgba(255,255,255,0.08)",
          borderRadius: 24,
          padding: "40px",
          boxShadow: "0 32px 64px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.06)",
        }}>
          {/* Tab toggle */}
          <div style={{
            display: "flex",
            background: "rgba(255,255,255,0.04)",
            borderRadius: 12,
            padding: 4,
            marginBottom: 36,
          }}>
            {["login", "register"].map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                style={{
                  flex: 1, padding: "10px 0", borderRadius: 9,
                  border: "none", cursor: "pointer",
                  fontFamily: "'DM Sans', sans-serif", fontSize: 14, fontWeight: 600,
                  transition: "all 0.2s ease",
                  background: mode === m ? "rgba(34,197,94,0.15)" : "transparent",
                  color: mode === m ? "#22c55e" : "#64748b",
                  boxShadow: mode === m ? "0 0 0 1px rgba(34,197,94,0.2)" : "none",
                }}
              >
                {m === "login" ? "Sign In" : "Create Account"}
              </button>
            ))}
          </div>

          <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {mode === "register" && (
              <InputField icon={<User size={16} />} type="text" placeholder="Full Name" value={form.name}
                onChange={(v) => setForm({ ...form, name: v })} />
            )}
            <InputField icon={<Mail size={16} />} type="email" placeholder="Email Address" value={form.email}
              onChange={(v) => setForm({ ...form, email: v })} />
            <InputField
              icon={<Lock size={16} />}
              type={showPassword ? "text" : "password"}
              placeholder="Password"
              value={form.password}
              onChange={(v) => setForm({ ...form, password: v })}
              suffix={
                <button type="button" onClick={() => setShowPassword(!showPassword)}
                  style={{ background: "none", border: "none", cursor: "pointer", color: "#475569", display: "flex" }}>
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              }
            />

            {mode === "login" && (
              <div style={{ textAlign: "right" }}>
                <span style={{ fontSize: 13, color: "#22c55e", cursor: "pointer" }}>Forgot password?</span>
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              style={{
                marginTop: 8,
                padding: "14px 24px",
                borderRadius: 12,
                border: "none",
                background: loading ? "rgba(34,197,94,0.3)" : "linear-gradient(135deg, #22c55e, #16a34a)",
                color: "white",
                fontFamily: "'DM Sans', sans-serif",
                fontSize: 15, fontWeight: 700,
                cursor: loading ? "not-allowed" : "pointer",
                display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
                transition: "all 0.2s ease",
                boxShadow: loading ? "none" : "0 0 30px rgba(34,197,94,0.3)",
              }}
            >
              {loading ? (
                <><Loader size={18} style={{ animation: "spin 1s linear infinite" }} /> Authenticating...</>
              ) : (
                <>{mode === "login" ? "Sign In" : "Create Account"} <ArrowRight size={18} /></>
              )}
            </button>
          </form>

          <div style={{ marginTop: 28, textAlign: "center", fontSize: 13, color: "#475569" }}>
            {mode === "login" ? "Don't have an account? " : "Already have an account? "}
            <span onClick={() => setMode(mode === "login" ? "register" : "login")}
              style={{ color: "#22c55e", cursor: "pointer", fontWeight: 600 }}>
              {mode === "login" ? "Register" : "Sign In"}
            </span>
          </div>
        </div>
      </div>

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Space+Grotesk:wght@600;700;800&display=swap');
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        @media (max-width: 768px) { .auth-brand { display: none !important; } }
      `}</style>
    </div>
  );
}

function InputField({ icon, type, placeholder, value, onChange, suffix }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 12,
      background: "rgba(255,255,255,0.04)",
      border: "1px solid rgba(255,255,255,0.08)",
      borderRadius: 12, padding: "12px 16px",
      transition: "border-color 0.2s ease",
    }}
      onFocus={(e) => e.currentTarget.style.borderColor = "rgba(34,197,94,0.4)"}
      onBlur={(e) => e.currentTarget.style.borderColor = "rgba(255,255,255,0.08)"}
    >
      <span style={{ color: "#475569", display: "flex" }}>{icon}</span>
      <input
        type={type}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required
        style={{
          flex: 1, background: "none", border: "none", outline: "none",
          color: "#f1f5f9", fontFamily: "'DM Sans', sans-serif", fontSize: 14,
        }}
      />
      {suffix}
    </div>
  );
}
