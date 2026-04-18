require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const connectDB = require("./config/db");
const logger = require("./config/logger");
const { apiLimiter } = require("./middleware/rateLimiter");
const authRoutes = require("./routes/authRoutes");
const aqiRoutes = require("./routes/aqiRoutes");

// Connect to MongoDB then start the CPCB hourly sync
connectDB().then(() => {
  const { startCronJob } = require("./jobs/syncCPCB");
  startCronJob();
});

const app = express();

// ── Security ──────────────────────────────────────────────────────────────────
app.use(helmet());
app.use(
  cors({
    origin: [
      "http://localhost:3000",
      process.env.CLIENT_URL,
    ].filter(Boolean),
    credentials: true,
  }),
);

// ── Logging & Parsing ─────────────────────────────────────────────────────────
app.use(
  morgan("combined", { stream: { write: (m) => logger.info(m.trim()) } }),
);
app.use(express.json({ limit: "10kb" }));
app.use(express.urlencoded({ extended: true }));

// ── Rate Limiting ─────────────────────────────────────────────────────────────
app.use("/api", apiLimiter);

// ── Routes ────────────────────────────────────────────────────────────────────
app.use("/api/auth", authRoutes);
app.use("/api/aqi", aqiRoutes);

// Health check
app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    message: "Aerosense API running 🌿",
    environment: process.env.NODE_ENV,
    dataSource: "OpenAQ — openaq.org",
    mlModel: process.env.ML_SERVICE_URL ? "connected" : "pending_integration",
    timestamp: new Date().toISOString(),
  });
});

// 404 Handler
app.use((req, res) => {
  res
    .status(404)
    .json({ success: false, error: `Route ${req.originalUrl} not found.` });
});

// Global Error Handler
app.use((err, req, res, next) => {
  logger.error(err.stack || err.message);
  res.status(err.status || 500).json({
    success: false,
    error:
      process.env.NODE_ENV === "production"
        ? "Internal server error."
        : err.message,
  });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  logger.info(`🚀 Aerosense server on port ${PORT} [${process.env.NODE_ENV}]`);
  logger.info(
    `📡 Data source: OpenAQ (openaq.org — free, no API key required)`,
  );
});

module.exports = app;